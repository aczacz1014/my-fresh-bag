(() => {
  const validLocations = ['냉장', '냉동', '상온'];
  function isValidItem(item) {
    return Boolean(item && typeof item.id === 'string' && typeof item.name === 'string' && item.name.trim() && Number.isFinite(Number(item.quantity)) && Number(item.quantity) >= 0 && typeof item.unit === 'string' && validLocations.includes(item.location) && typeof item.category === 'string');
  }
  function normalizeItem(item) {
    const safePhoto = typeof item.photo === 'string' && item.photo.length <= 180_000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(item.photo) ? item.photo : '';
    const safeImage = typeof item.productImageUrl === 'string' && /^https:\/\/images\.openfoodfacts\.org\//.test(item.productImageUrl) ? item.productImageUrl : '';
    let productSource = null;
    try {
      const sourceUrl = new URL(item.productSource?.url);
      if (sourceUrl.protocol === 'https:' && sourceUrl.hostname === 'world.openfoodfacts.org' && /^\/product\/\d+$/.test(sourceUrl.pathname)) productSource = { name: String(item.productSource.name || 'Open Food Facts').slice(0, 80), url: sourceUrl.href, queriedAt: String(item.productSource.queriedAt || '').slice(0, 30), license: String(item.productSource.license || 'Open Food Facts database; product image license follows its source').slice(0, 160) };
    } catch { /* untrusted backup metadata is omitted */ }
    let checkDateSourceUrl = '';
    try {
      const sourceUrl = new URL(item.checkDateSourceUrl);
      if (sourceUrl.protocol === 'https:' && sourceUrl.hostname === 'www.foodsafety.gov' && sourceUrl.pathname.startsWith('/food-safety-charts/')) checkDateSourceUrl = sourceUrl.href;
    } catch { /* custom or legacy dates may have no external source */ }
    const sources = Array.isArray(item.productSources) ? item.productSources.filter((source) => { try { const url = new URL(source.url); return url.protocol === 'https:' && /(^|\.)(donga\.co\.kr|cj\.co\.kr|cjthemarket\.com|nongshim\.com|foodsafetykorea\.go\.kr|mfds\.go\.kr|openfoodfacts\.org|ssg\.com|kurly\.com|coupang\.com|lotteon\.com|gmarket\.co\.kr)$/.test(url.hostname); } catch { return false; } }).slice(0, 5).map((source) => ({ name: String(source.name || '제품 정보 출처').slice(0,80), url: new URL(source.url).href, queriedAt: String(source.queriedAt || '').slice(0,30) })) : [];
    const safeNutrition = item.nutrition && typeof item.nutrition === 'object' ? Object.fromEntries(['caloriesKcal','carbohydratesG','sugarsG','proteinG','fatG','sodiumMg'].map((key) => [key, item.nutrition[key] != null && Number.isFinite(Number(item.nutrition[key])) ? Number(item.nutrition[key]) : null])) : null;
    return { ...item, quantity: Number(item.quantity), expiry: item.expiry || '', memo: item.memo || '', brand: item.brand || '', productType: item.productType || '', packageQuantity: item.packageQuantity || '', expirySource: item.expirySource || (item.expiry ? 'user' : 'none'), checkDate: item.checkDate || '', checkDateSource: item.checkDateSource || '', checkDateBasis: item.checkDateBasis || '', checkDateSourceUrl, opened: Boolean(item.opened), openedAt: item.openedAt || '', openedGuidance: item.openedGuidance || '', openedGuidanceDays: Number.isInteger(item.openedGuidanceDays) ? item.openedGuidanceDays : null, barcode: item.barcode || '', manufacturingDate: item.manufacturingDate || '', manufacturingDateEvidence: item.manufacturingDateEvidence || '', purchaseDate: item.purchaseDate || '', productImageUrl: safeImage, productSource, productSources: sources, nutrition: safeNutrition ? { ...safeNutrition, calorieBasis: String(item.nutrition.calorieBasis || ''), basis: String(item.nutrition.basis || '') } : null, unopenedStorage: item.unopenedStorage || '', openedStorage: item.openedStorage || '', shelfLifeDays: Number.isInteger(item.shelfLifeDays) ? item.shelfLifeDays : null, shelfLifeBasis: item.shelfLifeBasis || '', photo: safePhoto };
  }
  function mergeItems(items, entry) {
    const key = (item) => [item.name.trim().toLocaleLowerCase('ko'), (item.brand || '').trim().toLocaleLowerCase('ko'), item.unit, item.location, item.category, item.expiry || '', item.opened ? 'opened' : 'sealed'].join('|');
    const matched = items.find((item) => key(item) === key(entry));
    if (matched) return items.map((item) => item.id === matched.id ? { ...item, quantity: Number(item.quantity) + Number(entry.quantity), photo: item.photo || entry.photo || '', updatedAt: new Date().toISOString() } : item);
    return [entry, ...items];
  }
  function estimatePackageCalories(item) {
    const nutrition = item?.nutrition;
    if (!nutrition || nutrition.caloriesKcal == null || !Number.isFinite(Number(item.quantity))) return null;
    const measure = (value) => {
      if (/\d+\s*[x×]/i.test(String(value || ''))) return null;
      const match = String(value || '').match(/(\d+(?:[.,]\d+)?)\s*(kg|g|ml|mL|l|L)\b/i);
      if (!match) return null;
      const unit = match[2].toLowerCase();
      return { amount: Number(match[1].replace(',', '.')) * (unit === 'kg' || unit === 'l' ? 1000 : 1), unit: unit === 'kg' || unit === 'g' ? 'g' : 'mL' };
    };
    const pack = measure(item.packageQuantity);
    const basis = measure(nutrition.calorieBasis || nutrition.basis);
    if (!pack || !basis || pack.unit !== basis.unit || basis.amount <= 0) return null;
    const perPackage = Number(nutrition.caloriesKcal) * pack.amount / basis.amount;
    return Number.isFinite(perPackage) ? { perPackage, totalOnHand: perPackage * Number(item.quantity) } : null;
  }
  function recommendCheckDate(item) {
    if (!item?.purchaseDate || item.location !== '냉장' || !/^\d{4}-\d{2}-\d{2}$/.test(item.purchaseDate)) return null;
    const type = `${item.name || ''} ${item.productType || ''}`;
    if (!/(생\s?닭|생\s?가금류|raw\s+chicken|fresh\s+chicken|다진\s?소고기|간\s?소고기|ground\s+beef|생\s?칠면조|raw\s+turkey)/i.test(type)) return null;
    const [year, month, day] = item.purchaseDate.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    date.setUTCDate(date.getUTCDate() + 1);
    return { date: date.toISOString().slice(0, 10), basis: '생 가금류·다진 육류 냉장 보관 권고(1–2일 범위의 이른 확인일)', sourceUrl: 'https://www.foodsafety.gov/food-safety-charts/cold-food-storage-charts' };
  }
  const api = { isValidItem, normalizeItem, mergeItems, recommendCheckDate, estimatePackageCalories };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  globalThis.MyFreshBagData = api;
})();
