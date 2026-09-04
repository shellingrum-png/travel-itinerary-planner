/**
 * 交通查询后端服务(Node 原生 http,零依赖)
 * 对外:GET /api/transport?mode=train|flight&from=北京&to=西宁&date=2026-09-10
 * 内部:child_process 调用 fly-flight 的 transport_service.py(已验证可跑)
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'scripts', 'transport_service.py');
const PORT = process.env.TRANSPORT_PORT || 8766;

/** 调 fly-flight 查询 */
function queryTransport(mode, from, to, date) {
  const res = spawnSync(
    'python3',
    [SCRIPT, 'search', '--mode', mode, '--from', from, '--to', to, '--date', date, '--pretty'],
    { encoding: 'utf8', timeout: 30000 },
  );
  if (res.error) return { ok: false, error: `Python 进程错误: ${res.error.message}` };
  if (res.status !== 0) return { ok: false, error: `查询失败(status ${res.status}): ${(res.stderr || res.stdout || '').slice(0, 300)}` };
  try {
    // transport_service.py 直接输出查询结果对象(非 {ok,data} 包裹),兼容两种
    const parsed = JSON.parse(res.stdout);
    return parsed;
  } catch {
    return { ok: false, error: '返回内容无法解析为 JSON', raw: (res.stdout || '').slice(0, 200) };
  }
}

function validate({ mode, from, to, date }) {
  if (!['train', 'flight'].includes(mode)) return `mode 无效,需 train/flight`;
  if (!from) return '缺少出发城市 from';
  if (!to) return '缺少到达城市 to';
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return '日期 date 需为 yyyy-mm-dd';
  return null;
}

// CORS
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, status, obj) {
  setCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 健康检查
  if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, server: 'transport', port: PORT });

  // 交通查询
  if (url.pathname === '/api/transport' && req.method === 'GET') {
    const q = url.searchParams;
    const mode = q.get('mode') || 'train';
    const from = q.get('from') || '';
    const to = q.get('to') || '';
    const date = q.get('date') || '';
    const err = validate({ mode, from, to, date });
    if (err) return sendJson(res, 400, { ok: false, error: err });
    const result = queryTransport(mode, from, to, date);
    return sendJson(res, 200, result);
  }

  // 预检
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.writeHead(204).end();
  }

  sendJson(res, 404, { ok: false, error: `未找到路由 ${url.pathname}。可用: /api/transport, /api/health` });
});

server.listen(PORT, () => {
  console.log(`✅ 交通查询服务已启动: http://localhost:${PORT}`);
  console.log(`   示例: http://localhost:${PORT}/api/transport?mode=train&from=北京&to=上海&date=2026-09-10`);
});