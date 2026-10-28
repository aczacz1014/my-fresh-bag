const { lookupProducts } = require('../lib/product-lookup');
const { aiFeaturesEnabled } = require('../lib/deployment');
const windows = new Map();
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 30;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST 요청만 허용됩니다.' }); }
  try {
    const now = Date.now();
    for (const [ip, state] of windows) if (now - state.startedAt >= WINDOW_MS) windows.delete(ip);
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    const state = windows.get(ip);
    if (state && state.count >= MAX_PER_WINDOW) { res.setHeader('Retry-After', String(Math.ceil((WINDOW_MS - (now - state.startedAt)) / 1000))); return res.status(429).json({ error: '제품 정보 조회는 한 시간에 최대 30회까지 가능합니다.' }); }
    const payload = req.body || {};
    if (!Array.isArray(payload.items) || payload.items.length > 8 || payload.items.some((item) => !item || typeof item !== 'object' || (item.name != null && (typeof item.name !== 'string' || item.name.length > 100)) || (item.brand != null && (typeof item.brand !== 'string' || item.brand.length > 80)) || (item.barcode != null && (typeof item.barcode !== 'string' || item.barcode.length > 24)))) return res.status(400).json({ error: '제품 조회는 한 번에 최대 8개까지 가능하며, 이름·브랜드·바코드 길이 제한을 확인해 주세요.' });
    if (state) state.count += 1; else windows.set(ip, { startedAt: now, count: 1 });
    return res.status(200).json({ results: await lookupProducts(payload.items, globalThis.fetch, { disableAI: !aiFeaturesEnabled() }) });
  } catch {
    return res.status(502).json({ error: '제품 데이터베이스에 연결하지 못했습니다.' });
  }
};
