const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer, resolvePublicPath } = require('./server');
const { analyzeImageDataUrl, validateImageDataUrl } = require('./lib/image-analysis');
const { isValidItem, normalizeItem, mergeItems, recommendCheckDate, estimatePackageCalories } = require('./lib/inventory-data');

const onePixelPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWf8AAAAASUVORK5CYII=';

test('serves the app entry and assets', async (t) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const get = (route) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: route }, (res) => {
    let body = ''; res.setEncoding('utf8'); res.on('data', (chunk) => body += chunk); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
  }).on('error', reject));
  const page = await get('/');
  assert.equal(page.status, 200); assert.match(page.body, /My Fresh Bag/); assert.match(page.type, /text\/html/);
  assert.equal((await get('/app.js')).status, 200);
  assert.match((await get('/assets/foods/tuna.svg')).type, /image\/svg\+xml/);
  assert.equal((await get('/missing')).status, 403);
  assert.equal((await get('/.env')).status, 403);
  assert.equal((await get('/package.json')).status, 403);
});

test('blocks paths outside the project', () => {
  assert.equal(resolvePublicPath('/../../etc/passwd'), null);
});

test('includes the required inventory workflows and storage hooks', () => {
  const app = require('node:fs').readFileSync(require('node:path').join(__dirname, 'app.js'), 'utf8');
  for (const feature of ['localStorage', 'export', 'import', 'consume', 'renderItems', 'getDaysLeft', 'my-fresh-bag-inventory-v1', 'identityConfirmed', 'mergeOrInsert']) assert.ok(app.includes(feature), `missing ${feature}`);
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, 'index.html'), 'utf8');
  for (const feature of ['사진으로 등록', '바코드 등록', 'barcode-camera-button', 'barcode-image-button', 'barcode-number', '즐겨찾기', '최근 등록', 'data-filter="냉장"', 'data-filter="냉동"', 'data-filter="상온"', 'review-dialog']) assert.ok(html.includes(feature), `missing ${feature}`);
  for (const feature of ['BarcodeDetector', '/api/lookup', 'renderNutrition', 'my-fresh-bag-history-v1', 'my-fresh-bag-favorites-v1', 'mfb-analysis-cache:', 'data-check-days', 'UNIT_OPTIONS', '다시 등록', 'delete-history']) assert.ok(app.includes(feature) || html.includes(feature), `missing ${feature}`);
  assert.equal(app.includes('mfb-analysis-hashes'), false);
});

test('validates image type, content signature, byte limit, and dimensions', () => {
  assert.deepEqual(validateImageDataUrl(onePixelPng).width, 1);
  assert.throws(() => validateImageDataUrl('data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA=='), /JPG, PNG, WEBP/);
  assert.throws(() => validateImageDataUrl('data:image/png;base64,SGVsbG8='), /일치하지 않습니다/);
  const hugePng = Buffer.from(onePixelPng.split(',')[1], 'base64'); hugePng.writeUInt32BE(5000, 16); hugePng.writeUInt32BE(5000, 20);
  assert.throws(() => validateImageDataUrl(`data:image/png;base64,${hugePng.toString('base64')}`), /1,800만 픽셀/);
});

test('uses Responses API image input and strict Structured Outputs', async () => {
  let request;
  const modelResult = { documentType: 'product_photo', items: [{ isFood: true, name: '우유', brand: null, variant: null, packageQuantity: null, productType: '일반 냉장 우유', visualEvidence: '흰색 우유 팩', candidateNames: [], barcode: null, quantity: 1, unit: '팩', category: '유제품', storage: '냉장', storageConfidence: 'high', storageEvidence: '포장에 냉장 보관 표시', actualExpiry: null, expiryEvidence: null, manufacturingDate: null, manufacturingDateEvidence: null, purchaseDate: null, purchaseDateEvidence: null, openedGuidance: null, openedGuidanceDays: null, confidence: 'high', needsConfirmation: false }], nonFoodItems: [], notes: '' };
  const fakeClient = { responses: { create: async (params) => { request = params; return { output_text: JSON.stringify(modelResult) }; } } };
  const result = await analyzeImageDataUrl(onePixelPng, fakeClient);
  assert.equal(result.items[0].name, '우유');
  assert.equal(request.input[0].content[1].image_url, onePixelPng);
  assert.equal(request.text.format.type, 'json_schema');
  assert.equal(request.text.format.strict, true);
  assert.equal(request.store, false);
  for (const field of ['barcode', 'manufacturingDate', 'purchaseDate']) assert.ok(request.text.format.schema.properties.items.items.properties[field]);
});

test('returns a clear response when the OpenAI key is not configured', async (t) => {
  const previousKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); if (previousKey !== undefined) process.env.OPENAI_API_KEY = previousKey; });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imageDataUrl: onePixelPng }) });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /API 키가 설정되지 않았습니다/);
});

test('disables OpenAI features by default on Vercel while keeping local development enabled', () => {
  const { aiFeaturesEnabled } = require('./lib/deployment');
  assert.equal(aiFeaturesEnabled({ VERCEL: '1' }), false);
  assert.equal(aiFeaturesEnabled({ VERCEL: '1', AI_FEATURES_ENABLED: 'true' }), true);
  assert.equal(aiFeaturesEnabled({}), true);
});

test('Vercel photo analysis endpoint rejects requests while AI is disabled', async () => {
  const handler = require('./api/analyze');
  const priorVercel = process.env.VERCEL; const priorFlag = process.env.AI_FEATURES_ENABLED;
  process.env.VERCEL = '1'; delete process.env.AI_FEATURES_ENABLED;
  const res = { setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return body; } };
  try {
    await handler({ method: 'POST' }, res);
    assert.equal(res.statusCode, 503); assert.equal(res.body.code, 'ai_disabled');
  } finally {
    if (priorVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = priorVercel;
    if (priorFlag === undefined) delete process.env.AI_FEATURES_ENABLED; else process.env.AI_FEATURES_ENABLED = priorFlag;
  }
});

test('does not fall through to OpenAI web search when deployment disables AI', async () => {
  const { lookupProduct, clearLookupCache } = require('./lib/product-lookup');
  clearLookupCache();
  let requests = 0;
  const fetchImpl = async () => { requests += 1; return { ok: true, json: async () => ({ status: 0, products: [] }) }; };
  const result = await lookupProduct({ barcode: '4006381333931', name: 'private test product' }, fetchImpl, { disableAI: true });
  assert.equal(result.exact, false);
  assert.notEqual(result.status, 'needs_api_key');
  assert.ok(requests <= 2); // Open Food Facts only; the per-process limiter may skip name search.
  clearLookupCache();
});

test('migrates legacy localStorage records without changing their existing fields', () => {
  const legacy = { id: 'old-1', name: '우유', quantity: 2, unit: '팩', location: '냉장', category: '유제품', expiry: '2026-11-05', memo: '무지방' };
  assert.equal(isValidItem(legacy), true);
  const migrated = normalizeItem(legacy);
  assert.equal(migrated.name, legacy.name);
  assert.equal(migrated.quantity, 2);
  assert.equal(migrated.expiry, legacy.expiry);
  assert.equal(migrated.memo, legacy.memo);
  assert.equal(migrated.expirySource, 'user');
  assert.equal(migrated.opened, false);
  assert.equal(migrated.checkDate, '');
});

test('drops untrusted external URLs from imported source metadata', () => {
  const migrated = normalizeItem({ id: 'safe-1', name: '우유', quantity: 1, unit: '팩', location: '냉장', category: '유제품', productSource: { name: 'bad', url: 'javascript:alert(1)', queriedAt: 'now' }, checkDateSourceUrl: 'https://attacker.example/collect' });
  assert.equal(migrated.productSource, null);
  assert.equal(migrated.checkDateSourceUrl, '');
});

test('merges same products only when their actual expiry dates match', () => {
  const existing = [{ id: 'milk-a', name: '우유', brand: '', quantity: 1, unit: '팩', location: '냉장', category: '유제품', expiry: '2026-11-05', opened: false }];
  const sameDate = mergeItems(existing, { ...existing[0], id: 'milk-b', quantity: 2 });
  assert.equal(sameDate.length, 1);
  assert.equal(sameDate[0].quantity, 3);
  const differentDate = mergeItems(sameDate, { ...existing[0], id: 'milk-c', quantity: 1, expiry: '2026-11-10' });
  assert.equal(differentDate.length, 2);
});

test('loads non-empty local environment values without disclosing them', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { loadLocalEnv } = require('./lib/env');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfb-env-')); const file = path.join(dir, '.env');
  const previous = process.env.OPENAI_API_KEY; const previousModel = process.env.OPENAI_VISION_MODEL;
  try {
    delete process.env.OPENAI_API_KEY; delete process.env.OPENAI_VISION_MODEL;
    fs.writeFileSync(file, 'OPENAI_API_KEY=placeholder-test-value\nOPENAI_VISION_MODEL=gpt-4o-mini\n');
    assert.equal(loadLocalEnv(file), true);
    assert.equal(process.env.OPENAI_API_KEY, 'placeholder-test-value');
    assert.equal(process.env.OPENAI_VISION_MODEL, 'gpt-4o-mini');
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous;
    if (previousModel === undefined) delete process.env.OPENAI_VISION_MODEL; else process.env.OPENAI_VISION_MODEL = previousModel;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizes authentication, billing, rate, timeout and network API errors', () => {
  const { normalizeOpenAIError } = require('./lib/image-analysis');
  assert.equal(normalizeOpenAIError({ status: 401 }).code, 'invalid_api_key');
  assert.equal(normalizeOpenAIError({ status: 429, code: 'insufficient_quota' }).code, 'billing_or_quota');
  assert.equal(normalizeOpenAIError({ status: 429, headers: new Headers({ 'retry-after': '12' }) }).retryAfter, '12');
  assert.equal(normalizeOpenAIError({ name: 'APITimeoutError' }).statusCode, 504);
  assert.equal(normalizeOpenAIError({ name: 'APIConnectionError' }).code, 'network');
});

test('looks up exact barcode products and preserves verified source metadata', async () => {
  const { lookupProduct, clearLookupCache } = require('./lib/product-lookup');
  clearLookupCache();
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1; assert.match(options.headers['User-Agent'], /MyFreshBag/);
    return { ok: true, json: async () => ({ status: 1, product: { code: '3017620422003', product_name: 'Test spread', product_name_ko: '테스트 스프레드', brands: 'Test Brand', categories: 'Spread', quantity: '350 g', image_front_url: 'https://images.openfoodfacts.org/images/products/test.jpg', conservation_conditions: 'Store in a cool place' } }) };
  };
  const first = await lookupProduct({ barcode: '3017620422003', name: '스프레드' }, fetchImpl);
  const second = await lookupProduct({ barcode: '3017620422003', name: '스프레드' }, fetchImpl);
  assert.equal(first.exact, true); assert.equal(first.product.code, '3017620422003');
  assert.match(first.source.url, /3017620422003/); assert.ok(first.source.queriedAt);
  assert.equal(first.product.imageUrl, 'https://images.openfoodfacts.org/images/products/test.jpg');
  assert.equal(second.cacheHit, true); assert.equal(calls, 1);
  clearLookupCache();
});

test('rejects approximate name matches instead of borrowing a different product', async () => {
  const { lookupProduct, clearLookupCache } = require('./lib/product-lookup');
  clearLookupCache();
  const fetchImpl = async () => ({ ok: true, json: async () => ({ products: [{ code: '12345678', product_name: '우유맛 과자', product_name_ko: '우유맛 과자', brands: '다른 브랜드' }] }) });
  const result = await lookupProduct({ name: '우유', brand: '다른 브랜드' }, fetchImpl);
  assert.equal(result.exact, false); assert.equal(result.product, null);
  clearLookupCache();
});

test('requires matching package quantity for name-based Open Food Facts matches', () => {
  const { exactNameMatch } = require('./lib/product-lookup');
  const products = [{ code: '12345678', product_name_ko: '얼박사 제로', brands: '동아제약', quantity: '355 ml' }];
  assert.equal(exactNameMatch(products, '얼박사 제로', '동아제약', '355mL'), products[0]);
  assert.equal(exactNameMatch(products, '얼박사 제로', '동아제약', '500mL'), null);
});

test('recommends only a source-backed check date for a narrowly identified refrigerated raw item', () => {
  const recommendation = recommendCheckDate({ name: '생 닭가슴살', location: '냉장', purchaseDate: '2026-10-28' });
  assert.equal(recommendation.date, '2026-10-29');
  assert.match(recommendation.sourceUrl, /foodsafety.gov/);
  assert.equal(recommendCheckDate({ name: '우유', location: '냉장', purchaseDate: '2026-10-28' }), null);
  assert.equal(recommendCheckDate({ name: '생 닭가슴살', location: '냉동', purchaseDate: '2026-10-28' }), null);
  assert.equal(recommendCheckDate({ name: '생 닭가슴살', location: '냉장', purchaseDate: '2026-02-30' }), null);
});

test('web product lookup uses Responses web_search and only promotes exact variant and volume matches', async () => {
  const { lookupWebProduct, exactWebIdentity } = require('./lib/product-lookup');
  const oldKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'test-placeholder';
  const oldModel = process.env.OPENAI_PRODUCT_SEARCH_MODEL; process.env.OPENAI_PRODUCT_SEARCH_MODEL = 'gpt-6-luna';
  try {
    let request;
    const facts = { sameProduct: true, confidence: 'high', productName: '얼박사 제로 355mL', brand: '동아제약', variant: '제로', packageQuantity: '355mL', productType: '탄산음료', storage: '상온', unopenedStorage: '직사광선을 피해 서늘한 곳', openedStorage: '개봉 후 냉장 보관', caloriesKcal: 10, calorieBasis: '355mL', carbohydratesG: 4.3, sugarsG: 0, proteinG: 1.1, fatG: 0, sodiumMg: 35, nutritionBasis: '355mL 1캔', shelfLifeDays: null, shelfLifeBasis: null, candidateNames: [], sourceIndices: [0], matchReason: '브랜드·제로 버전·355mL 용량이 제조사 출처에서 일치' };
    const client = { responses: { create: async (params) => { request = params; return { output_text: JSON.stringify(facts), output: [{ type: 'web_search_call', action: { sources: [{ url: 'https://with.donga.co.kr/kr/board/product' }] } }] }; } } };
    const result = await lookupWebProduct({ name: '얼박사 제로', brand: '동아제약', variant: '제로', packageQuantity: '355mL' }, client);
    assert.equal(request.model, 'gpt-6-luna'); assert.equal(request.tools[0].type, 'web_search'); assert.equal(request.tool_choice, 'required');
    assert.ok(request.tools[0].filters.allowed_domains.includes('donga.co.kr'));
    assert.equal(result.exact, true); assert.equal(result.product.nutrition.caloriesKcal, 10); assert.equal(result.product.nutrition.calorieBasis, '355mL');
    assert.equal(result.sources[0].url, 'https://with.donga.co.kr/kr/board/product');
    assert.equal(exactWebIdentity({ ...facts, productName: '얼박사', variant: '오리지널', packageQuantity: '355mL' }, { name: '얼박사 제로', brand: '동아제약', variant: '제로', packageQuantity: '355mL' }), false);
  } finally {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.OPENAI_PRODUCT_SEARCH_MODEL; else process.env.OPENAI_PRODUCT_SEARCH_MODEL = oldModel;
  }
});

test('maps only present Open Food Facts nutrient fields and preserves serving basis', () => {
  const { mapNutrition } = require('./lib/product-lookup');
  const info = mapNutrition({ 'energy-kcal_serving': 10 }, '355 ml');
  assert.equal(info.caloriesKcal, 10); assert.equal(info.calorieBasis, '1회 제공량 (355 ml)');
  assert.equal(info.proteinG, null); assert.equal(mapNutrition({}, ''), null);
});

test('calculates package calories only when the labeled basis and package unit agree', () => {
  const item = { quantity: 3, packageQuantity: '200 g', nutrition: { caloriesKcal: 100, calorieBasis: '100g' } };
  assert.deepEqual(estimatePackageCalories(item), { perPackage: 200, totalOnHand: 600 });
  assert.equal(estimatePackageCalories({ ...item, packageQuantity: '355 mL' }), null);
  assert.equal(estimatePackageCalories({ ...item, packageQuantity: '6 x 200 g' }), null);
  assert.equal(estimatePackageCalories({ ...item, nutrition: { caloriesKcal: null, calorieBasis: '100g' } }), null);
});

test('checks the requested grocery variants by brand and package size, and leaves generic milk unresolved', () => {
  const { exactWebIdentity } = require('./lib/product-lookup');
  const verify = (req, info) => exactWebIdentity({ sameProduct: true, confidence: 'high', ...info }, req);
  assert.equal(verify({ name: '얼박사 제로', brand: '동아제약', variant: '제로', packageQuantity: '355mL' }, { productName: '얼박사 제로 355mL', brand: '동아제약', variant: '제로', packageQuantity: '355mL' }), true);
  assert.equal(verify({ name: '얼박사 제로', brand: '동아제약', variant: '제로', packageQuantity: '355mL' }, { productName: '얼박사 오리지널 355mL', brand: '동아제약', variant: '오리지널', packageQuantity: '355mL' }), false);
  assert.equal(verify({ name: '스팸 클래식', brand: 'CJ', packageQuantity: '200g' }, { productName: '스팸 클래식 200g', brand: 'CJ제일제당', variant: '', packageQuantity: '200g' }), true);
  assert.equal(verify({ name: '햇반 백미', brand: 'CJ', packageQuantity: '210g' }, { productName: '햇반 백미 210g', brand: 'CJ제일제당', variant: '백미', packageQuantity: '210g' }), true);
  assert.equal(verify({ name: '신라면', brand: '농심', packageQuantity: '120g' }, { productName: '신라면 골드 125g', brand: '농심', variant: '골드', packageQuantity: '125g' }), false);
  assert.equal(verify({ name: '일반 냉장 우유', brand: '', packageQuantity: '' }, { productName: '일반 냉장 우유', brand: '서울우유', variant: '', packageQuantity: '1L' }), false);
});
