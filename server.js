const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { analyzeImageDataUrl, validateImageDataUrl, normalizeOpenAIError } = require('./lib/image-analysis');
const { lookupProducts } = require('./lib/product-lookup');
const { loadLocalEnv } = require('./lib/env');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3003;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.svg': 'image/svg+xml' };

function resolvePublicPath(urlPath) {
  const pathname = decodeURIComponent((urlPath || '/').split('?')[0]);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const isPublicAsset = ['index.html', 'styles.css', 'app.js', 'lib/inventory-data.js'].includes(relative) || /^assets\/foods\/[a-z0-9-]+\.svg$/.test(relative);
  if (!isPublicAsset) return null;
  const filePath = path.resolve(ROOT, relative);
  return filePath.startsWith(`${ROOT}${path.sep}`) || filePath === path.join(ROOT, 'index.html') ? filePath : null;
}

function createServer() {
  return http.createServer((req, res) => {
    if (req.url?.split('?')[0] === '/api/analyze') {
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'POST 요청만 허용됩니다.' })); }
      return handleAnalysis(req, res);
    }
    if (req.url?.split('?')[0] === '/api/lookup') {
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'POST 요청만 허용됩니다.' })); }
      return handleLookup(req, res);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('Method not allowed'); }
    const filePath = resolvePublicPath(req.url);
    if (!filePath) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(filePath, (error, data) => {
      if (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(filePath)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
      res.end(data);
    });
  });
}

const requestsByIp = new Map();
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 5;
const MAX_REQUEST_BYTES = 5_800_000;
const MAX_LOOKUP_BYTES = 24_000;

function clientIp(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim(); }

async function handleAnalysis(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!process.env.OPENAI_API_KEY?.trim()) { res.writeHead(503); return res.end(JSON.stringify({ error: '사진 인식 API 키가 설정되지 않았습니다. .env에 OPENAI_API_KEY를 입력하고 서버를 재시작해 주세요. 일반 재고 관리는 계속 사용할 수 있어요.', code: 'missing_api_key' })); }
  const now = Date.now();
  for (const [ip, usage] of requestsByIp) if (now - usage.startedAt >= RATE_WINDOW_MS) requestsByIp.delete(ip);
  const ip = clientIp(req); const usage = requestsByIp.get(ip);
  if (usage && usage.count >= RATE_MAX) { res.writeHead(429, { 'Retry-After': String(Math.ceil((RATE_WINDOW_MS - (now - usage.startedAt)) / 1000)) }); return res.end(JSON.stringify({ error: '사진 분석은 한 시간에 최대 5회까지 가능합니다. 잠시 후 다시 시도해 주세요.' })); }
  let body = '';
  try {
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) { res.writeHead(413); return res.end(JSON.stringify({ error: '이미지가 너무 큽니다. 더 작은 사진으로 다시 시도해 주세요.' })); }
    }
    const payload = JSON.parse(body || '{}');
    const image = validateImageDataUrl(payload.imageDataUrl);
    if (usage) usage.count += 1; else requestsByIp.set(ip, { startedAt: now, count: 1 });
    const result = await analyzeImageDataUrl(image.dataUrl);
    res.writeHead(200); res.end(JSON.stringify(result));
  } catch (error) {
    if (error.inputError || error instanceof SyntaxError) {
      const status = error.inputError ? error.statusCode : 400;
      res.writeHead(status); return res.end(JSON.stringify({ error: error.message, code: 'invalid_image_request' }));
    }
    const apiError = normalizeOpenAIError(error);
    res.writeHead(apiError.statusCode, apiError.retryAfter ? { 'Retry-After': apiError.retryAfter } : {});
    res.end(JSON.stringify({ error: apiError.message, code: apiError.code }));
  }
}

async function handleLookup(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  let body = '';
  try {
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_LOOKUP_BYTES) { res.writeHead(413); return res.end(JSON.stringify({ error: '제품 조회 요청이 너무 큽니다.' })); }
    }
    const payload = JSON.parse(body || '{}');
    if (!Array.isArray(payload.items) || payload.items.length > 8 || payload.items.some((item) => !item || typeof item !== 'object' || (item.name != null && (typeof item.name !== 'string' || item.name.length > 100)) || (item.brand != null && (typeof item.brand !== 'string' || item.brand.length > 80)) || (item.barcode != null && (typeof item.barcode !== 'string' || item.barcode.length > 24)))) { res.writeHead(400); return res.end(JSON.stringify({ error: '제품 조회는 한 번에 최대 8개까지 가능하며, 이름·브랜드·바코드 길이 제한을 확인해 주세요.' })); }
    const results = await lookupProducts(payload.items);
    res.writeHead(200); res.end(JSON.stringify({ results }));
  } catch {
    res.writeHead(400); res.end(JSON.stringify({ error: '제품 조회 요청을 읽지 못했습니다.' }));
  }
}

if (require.main === module) {
  loadLocalEnv();
  createServer().listen(PORT, () => {
    console.log(`My Fresh Bag is running at http://localhost:${PORT}`);
    console.log(`OpenAI image analysis key: ${process.env.OPENAI_API_KEY?.trim() ? 'configured' : 'missing (.env needs OPENAI_API_KEY)'}`);
  });
}
module.exports = { createServer, resolvePublicPath };
