const OpenAI = require('openai');

const CACHE_TTL = 24 * 60 * 60 * 1000;
const MAX_CACHE_SIZE = 500;
const lookupCache = new Map();
const offWindows = { barcode: { startedAt: Date.now(), count: 0, limit: 14 }, name: { startedAt: Date.now(), count: 0, limit: 9 } };
const OFF_ROOT = 'https://world.openfoodfacts.org';
const OFF_AGENT = 'MyFreshBag/1.1 (self-hosted household food inventory)';
const TRUSTED_SOURCE_DOMAINS = ['donga.co.kr','cj.co.kr','cjthemarket.com','nongshim.com','foodsafetykorea.go.kr','mfds.go.kr','openfoodfacts.org','ssg.com','kurly.com','coupang.com','lotteon.com','gmarket.co.kr'];
const MAX_WEB_SEARCHES_PER_HOUR = 5;
let webSearchWindow = { startedAt: Date.now(), count: 0 };
const nullable = (type) => ({ anyOf: [{ type }, { type: 'null' }] });

const webProductSchema = {
  type: 'object', additionalProperties: false,
  required: ['sameProduct','confidence','productName','brand','variant','packageQuantity','productType','storage','unopenedStorage','openedStorage','caloriesKcal','calorieBasis','carbohydratesG','sugarsG','proteinG','fatG','sodiumMg','nutritionBasis','shelfLifeDays','shelfLifeBasis','candidateNames','matchReason'],
  properties: {
    sameProduct: { type: 'boolean' }, confidence: { type: 'string', enum: ['high','medium','low'] },
    productName: { type: 'string' }, brand: { type: 'string' }, variant: { type: 'string' }, packageQuantity: { type: 'string' }, productType: { type: 'string' },
    storage: { type: 'string', enum: ['냉장','냉동','상온','확인 필요'] }, unopenedStorage: nullable('string'), openedStorage: nullable('string'),
    caloriesKcal: nullable('number'), calorieBasis: nullable('string'), carbohydratesG: nullable('number'), sugarsG: nullable('number'), proteinG: nullable('number'), fatG: nullable('number'), sodiumMg: nullable('number'), nutritionBasis: nullable('string'),
    shelfLifeDays: nullable('integer'), shelfLifeBasis: nullable('string'), candidateNames: { type: 'array', items: { type: 'string' } }, matchReason: { type: 'string' }
  }
};

function clean(value, max = 100) { return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : ''; }
function digits(value) { const code = clean(value, 24).replace(/\D/g, ''); return /^\d{8,14}$/.test(code) ? code : ''; }
function normalized(value) { return clean(value, 160).normalize('NFKC').toLocaleLowerCase('ko').replace(/[\s\p{P}\p{S}]/gu, ''); }
function cacheKey(item) { const code = digits(item.barcode); return code ? `barcode:${code}` : `name:${normalized(item.name)}|${normalized(item.brand)}|${normalized(item.variant)}|${normalized(item.packageQuantity)}`; }
function noMatch(status = 'not_found', cacheHit = false) { return { status, exact: false, matchType: null, product: null, source: null, cacheHit }; }

function allowOffRequest(kind) {
  const now = Date.now(); const state = offWindows[kind];
  if (now - state.startedAt >= 60_000) { state.startedAt = now; state.count = 0; }
  if (state.count >= state.limit) return false;
  state.count += 1; return true;
}

function imageUrlOf(product) {
  const value = clean(product.image_front_url || product.image_url || '', 1000);
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'images.openfoodfacts.org' ? url.href : ''; } catch { return ''; }
}

function sourceRecord(code, queriedAt) {
  return { name: 'Open Food Facts', url: `${OFF_ROOT}/product/${encodeURIComponent(code)}`, queriedAt, license: 'ODbL database; product images CC BY-SA' };
}

function mapProduct(product, code, matchType, queriedAt) {
  const canonicalCode = clean(product.code, 24);
  if (!canonicalCode || canonicalCode.replace(/\D/g, '') !== code) return null;
  const source = sourceRecord(canonicalCode, queriedAt);
  return {
    status: 'matched', exact: true, matchType, cacheHit: false,
    product: {
      code: canonicalCode,
      name: clean(product.product_name_ko || product.product_name || product.product_name_en || '', 160),
      brand: clean(product.brands || '', 120),
      productType: clean(product.categories || '', 220),
      packageQuantity: clean(product.quantity || '', 60),
      imageUrl: imageUrlOf(product),
      storageText: clean(product.conservation_conditions || '', 300),
      unopenedStorage: clean(product.conservation_conditions || '', 300),
      openedStorage: '',
      nutrition: mapNutrition(product.nutriments || {}, product.serving_size || ''),
      shelfLifeDays: null,
      shelfLifeBasis: ''
    },
    source,
    warning: 'Open Food Facts는 공개 협업 데이터베이스이며 각 항목의 정확성을 보증하지 않습니다. 포장 라벨을 확인하세요.'
  };
}

function mapNutrition(nutriments, servingSize = '') {
  const read = (...keys) => { for (const key of keys) { const value = Number(nutriments[key]); if (Number.isFinite(value) && value >= 0) return value; } return null; };
  const per100 = read('energy-kcal_100g');
  const perServing = read('energy-kcal_serving');
  const calories = per100 ?? perServing;
  if (calories === null && !['carbohydrates_100g','sugars_100g','proteins_100g','fat_100g','sodium_100g'].some((key) => read(key) !== null)) return null;
  const basis = per100 !== null ? '100g' : (servingSize ? `1회 제공량 (${clean(servingSize, 60)})` : '1회 제공량');
  return { caloriesKcal: calories, calorieBasis: calories === null ? '' : basis, carbohydratesG: read('carbohydrates_100g'), sugarsG: read('sugars_100g'), proteinG: read('proteins_100g'), fatG: read('fat_100g'), sodiumMg: read('sodium_100g') === null ? null : read('sodium_100g') * 1000, basis: '100g', servingSize: clean(servingSize, 60) };
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: { 'User-Agent': OFF_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(6500) });
  if (!response.ok) throw new Error(`Open Food Facts returned ${response.status}`);
  return response.json();
}

async function queryBarcode(code, fetchImpl, queriedAt) {
  const fields = 'code,product_name,product_name_ko,product_name_en,brands,categories,quantity,image_url,image_front_url,conservation_conditions,nutriments,serving_size';
  const url = `${OFF_ROOT}/api/v2/product/${encodeURIComponent(code)}.json?fields=${encodeURIComponent(fields)}`;
  const data = await fetchJson(url, fetchImpl);
  if (Number(data.status) !== 1 || !data.product) return noMatch();
  const result = mapProduct(data.product, code, 'barcode', queriedAt);
  return result || noMatch();
}

function exactNameMatch(products, name, brand, packageQuantity = '') {
  const requestedName = normalized(name); const requestedBrand = normalized(brand);
  const requestedSize = normalized(packageQuantity);
  if (!requestedName) return null;
  const exact = products.filter((product) => {
    const names = [product.product_name_ko, product.product_name, product.product_name_en].map(normalized).filter(Boolean);
    if (!names.includes(requestedName)) return false;
    const brands = clean(product.brands || '', 250).split(',').map(normalized);
    if (requestedBrand && !brands.includes(requestedBrand)) return false;
    if (!requestedSize) return true;
    return normalized(product.quantity || '') === requestedSize;
  });
  if (exact.length !== 1) return null;
  return exact[0];
}

async function queryExactName(name, brand, packageQuantity, fetchImpl, queriedAt) {
  if (!brand || !packageQuantity) return noMatch('identity_incomplete');
  const terms = [brand, name].filter(Boolean).join(' ').slice(0, 180);
  if (!terms.trim()) return noMatch();
  const fields = 'code,product_name,product_name_ko,product_name_en,brands,categories,quantity,image_url,image_front_url,conservation_conditions,nutriments,serving_size';
  const url = new URL(`${OFF_ROOT}/cgi/search.pl`);
  url.searchParams.set('search_terms', terms);
  url.searchParams.set('json', '1');
  url.searchParams.set('page_size', '8');
  url.searchParams.set('fields', fields);
  const data = await fetchJson(url, fetchImpl);
  const match = exactNameMatch(Array.isArray(data.products) ? data.products : [], name, brand, packageQuantity);
  if (!match) return { ...noMatch('not_exact'), candidatesFound: Array.isArray(data.products) ? data.products.length : 0 };
  const code = digits(match.code);
  return code ? (mapProduct(match, code, 'exact_name_and_brand', queriedAt) || noMatch('not_exact')) : noMatch('not_exact');
}

function collectSearchSources(response) {
  const sources = [];
  for (const call of response?.output || []) {
    if (call.type !== 'web_search_call') continue;
    const found = call.action?.sources || [];
    for (const source of found) {
      try {
        const url = new URL(source.url);
        const trusted = TRUSTED_SOURCE_DOMAINS.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
        if (url.protocol === 'https:' && trusted && !sources.some((entry) => entry.url === url.href)) sources.push({ url: url.href });
      } catch { /* discard invalid URLs */ }
    }
  }
  return sources;
}

function exactWebIdentity(info, requested) {
  const cleanIdentity = (value, brand) => normalized(value).replace(normalized(brand), '').replace(/\d+(?:ml|g|kg|l|개|입)/g, '');
  const reqName = cleanIdentity(requested.name, requested.brand);
  const foundName = cleanIdentity(info.productName, info.brand);
  const reqBrand = normalized(requested.brand);
  const foundBrand = normalized(info.brand);
  const size = normalized(requested.packageQuantity);
  const foundSize = normalized(info.packageQuantity);
  const nameOk = reqName && foundName && reqName === foundName;
  const aliases = { cj: 'cj제일제당', 동아: '동아제약' };
  const brandOk = !reqBrand || (foundBrand && (reqBrand === foundBrand || aliases[reqBrand] === foundBrand));
  const sizeOk = !size || (foundSize && (size === foundSize || foundSize.includes(size)));
  const requestedVariant = normalized(requested.variant);
  const foundVariant = normalized(info.variant);
  const variantOk = !requestedVariant || (foundVariant && (foundVariant === requestedVariant || foundName.includes(requestedVariant)));
  const sufficientlySpecified = Boolean(requested.barcode || (reqBrand && size));
  return Boolean(sufficientlySpecified && info.sameProduct && info.confidence === 'high' && nameOk && brandOk && sizeOk && variantOk);
}

function authorityOf(url) {
  const host = new URL(url).hostname.toLowerCase();
  if (/donga\.co\.kr$/.test(host) || /cj\.co\.kr$/.test(host) || /cjthemarket\.com$/.test(host) || /nongshim\.com$/.test(host)) return '제조사/브랜드';
  if (/foodsafetykorea\.go\.kr$/.test(host) || /mfds\.go\.kr$/.test(host)) return '식약처';
  if (/openfoodfacts\.org$/.test(host)) return 'Open Food Facts';
  return '웹 검색 출처';
}

async function lookupWebProduct(input, client = null) {
  if (!process.env.OPENAI_API_KEY?.trim()) return noMatch('needs_api_key');
  const now = Date.now();
  if (now - webSearchWindow.startedAt >= 60 * 60 * 1000) webSearchWindow = { startedAt: now, count: 0 };
  if (webSearchWindow.count >= MAX_WEB_SEARCHES_PER_HOUR) return noMatch('rate_limited');
  webSearchWindow.count += 1;
  const openai = client || new OpenAI({ timeout: 25_000, maxRetries: 0 });
  const requested = { name: clean(input?.name, 100), brand: clean(input?.brand, 80), variant: clean(input?.variant, 80), packageQuantity: clean(input?.packageQuantity, 60), barcode: digits(input?.barcode) };
  const response = await openai.responses.create({
    model: process.env.OPENAI_PRODUCT_SEARCH_MODEL || 'gpt-6-luna',
    store: false,
    max_output_tokens: 1000,
    tools: [{ type: 'web_search', filters: { allowed_domains: TRUSTED_SOURCE_DOMAINS } }],
    tool_choice: 'required',
    include: ['web_search_call.action.sources'],
    input: `Identify the exact Korean packaged food product and research only the supplied identity. Input: name=${requested.name}; brand=${requested.brand}; variant=${requested.variant}; package size=${requested.packageQuantity}; barcode=${requested.barcode}. Search official manufacturer pages first, then Korean MFDS/Food Safety Korea, then Open Food Facts, then exact product pages at reputable Korean retailers. Do not mix standard and zero versions, flavors, sizes, or reformulations. Return values only when supported by retrieved sources; otherwise null or empty. Product name, brand, variant, and package size must match the requested identity. Nutrition must include its exact serving basis and values as published; never convert without a known serving size. Storage must distinguish unopened and opened instructions when available. ShelfLifeDays is permitted only when an exact product's manufacturer-stated period from manufacture is found; never infer an expiry from purchase date. If identity is not exact or sources conflict without a clear current manufacturer source, set sameProduct=false, confidence=low, and provide candidateNames; do not provide product-specific facts.`,
    text: { format: { type: 'json_schema', name: 'verified_food_product', strict: true, schema: webProductSchema } }
  });
  const allSources = collectSearchSources(response);
  const sources = allSources.slice(0, 5).map((entry) => ({ name: authorityOf(entry.url), url: entry.url, queriedAt: new Date().toISOString() }));
  let facts;
  try { facts = JSON.parse(response.output_text); }
  catch { return { ...noMatch('unverified'), sources, candidates: [], matchReason: '검색은 완료했지만 제품 정보를 확인 가능한 형식으로 받지 못했습니다. 출처를 열어 직접 확인해 주세요.' }; }
  if (!sources.length) return { ...noMatch('unverified'), candidates: (facts.candidateNames || []).slice(0, 3), matchReason: '검색 결과에 연결 가능한 출처가 없습니다.' };
  if (!exactWebIdentity(facts, requested)) return { ...noMatch('ambiguous'), candidates: (facts.candidateNames || []).slice(0, 3), sources, matchReason: clean(facts.matchReason, 300) };
  if (facts.shelfLifeDays !== null && !sources.some((source) => authorityOf(source.url) === '제조사/브랜드')) { facts.shelfLifeDays = null; facts.shelfLifeBasis = null; }
  return {
    status: 'matched', exact: true, matchType: 'web_search_exact', cacheHit: false, sources,
    product: {
      name: clean(facts.productName, 160), brand: clean(facts.brand, 120), variant: clean(facts.variant, 100),
      packageQuantity: clean(facts.packageQuantity, 60), productType: clean(facts.productType, 180), imageUrl: '',
      storage: facts.storage, storageText: clean([facts.unopenedStorage, facts.openedStorage].filter(Boolean).join(' / '), 400),
      unopenedStorage: clean(facts.unopenedStorage || '', 220), openedStorage: clean(facts.openedStorage || '', 220),
      nutrition: facts.caloriesKcal === null && facts.carbohydratesG === null && facts.proteinG === null ? null : {
        caloriesKcal: facts.caloriesKcal, calorieBasis: clean(facts.calorieBasis || '', 80), carbohydratesG: facts.carbohydratesG, sugarsG: facts.sugarsG,
        proteinG: facts.proteinG, fatG: facts.fatG, sodiumMg: facts.sodiumMg, basis: clean(facts.nutritionBasis || '', 80), servingSize: ''
      },
      shelfLifeDays: facts.shelfLifeDays, shelfLifeBasis: clean(facts.shelfLifeBasis || '', 220)
    },
    matchReason: clean(facts.matchReason, 300), warning: '검색 결과는 제품 라벨에서 확인하고, 최신 표기와 다르면 제품 라벨을 우선하세요.'
  };
}

async function lookupProduct(input, fetchImpl = globalThis.fetch, options = {}) {
  const barcode = digits(input?.barcode);
  const name = clean(input?.name, 100);
  const brand = clean(input?.brand, 80);
  const key = cacheKey({ barcode, name, brand, variant: input?.variant, packageQuantity: input?.packageQuantity });
  const cached = lookupCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.result, cacheHit: true };
  if (cached) lookupCache.delete(key);
  const queriedAt = new Date().toISOString();
  let result;
  try { result = barcode ? (allowOffRequest('barcode') ? await queryBarcode(barcode, fetchImpl, queriedAt) : noMatch('rate_limited')) : noMatch(); }
  catch { result = noMatch('unavailable'); }
  const requestedSize = normalized(clean(input?.packageQuantity, 60));
  if (result.exact && requestedSize && result.product.packageQuantity && requestedSize !== normalized(result.product.packageQuantity)) {
    result = { ...noMatch('identity_conflict'), candidates: [result.product.name].filter(Boolean), matchReason: '바코드 상품과 사진에서 읽은 용량이 달라 확인이 필요합니다.' };
  }
  if (result.status !== 'identity_conflict' && !result.exact && name) {
    try { result = allowOffRequest('name') ? await queryExactName(name, brand, clean(input?.packageQuantity, 60), fetchImpl, queriedAt) : noMatch('rate_limited'); }
    catch { result = noMatch('unavailable'); }
  }
  if (!options.disableAI && result.status !== 'identity_conflict' && !result.exact && name) {
    try { result = await lookupWebProduct(input); }
    catch { result = { ...noMatch('unavailable'), warning: '웹 제품 정보 조회에 실패했습니다. 사진 분석 결과와 직접 입력은 계속 사용할 수 있습니다.' }; }
  }
  if (!['unavailable', 'rate_limited', 'needs_api_key'].includes(result.status)) {
    lookupCache.set(key, { expiresAt: Date.now() + CACHE_TTL, result });
    if (lookupCache.size > MAX_CACHE_SIZE) lookupCache.delete(lookupCache.keys().next().value);
  }
  return result;
}

async function lookupProducts(items, fetchImpl = globalThis.fetch, options = {}) {
  const limited = Array.isArray(items) ? items.slice(0, 8) : [];
  return Promise.all(limited.map((item) => lookupProduct(item, fetchImpl, options)));
}

module.exports = { lookupProduct, lookupProducts, digits, normalized, exactNameMatch, exactWebIdentity, lookupWebProduct, mapNutrition, webProductSchema, collectSearchSources, clearLookupCache: () => lookupCache.clear() };
