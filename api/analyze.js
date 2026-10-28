const { analyzeImageDataUrl, validateImageDataUrl, normalizeOpenAIError } = require('../lib/image-analysis');
const { aiFeaturesEnabled } = require('../lib/deployment');
const rateWindow = new Map();
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 5;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!aiFeaturesEnabled()) return res.status(503).json({ error: '공개 배포의 비용 보호 설정으로 사진 AI 기능이 꺼져 있습니다. 기본 식품 등록은 계속 사용할 수 있습니다.', code: 'ai_disabled' });
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST 요청만 허용됩니다.' }); }
  if (!process.env.OPENAI_API_KEY?.trim()) return res.status(503).json({ error: '사진 인식 API 키가 설정되지 않았습니다. Vercel 환경 변수에 OPENAI_API_KEY를 등록해 주세요.', code: 'missing_api_key' });
  try {
    const now = Date.now();
    for (const [ip, state] of rateWindow) if (now - state.startedAt >= WINDOW_MS) rateWindow.delete(ip);
    const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    const state = rateWindow.get(ip);
    if (state && state.count >= MAX_PER_WINDOW) { res.setHeader('Retry-After', String(Math.ceil((WINDOW_MS - (now - state.startedAt)) / 1000))); return res.status(429).json({ error: '사진 분석은 한 시간에 최대 5회까지 가능합니다.' }); }
    const payload = req.body || {};
    const image = validateImageDataUrl(payload.imageDataUrl);
    if (state) state.count += 1; else rateWindow.set(ip, { startedAt: now, count: 1 });
    return res.status(200).json(await analyzeImageDataUrl(image.dataUrl));
  } catch (error) {
    const validationError = Boolean(error.inputError);
    const normalized = validationError ? { statusCode: error.statusCode, code: 'invalid_image', message: error.message } : normalizeOpenAIError(error);
    if (normalized.retryAfter) res.setHeader('Retry-After', String(normalized.retryAfter));
    return res.status(normalized.statusCode).json({ error: normalized.message, code: normalized.code });
  }
};
