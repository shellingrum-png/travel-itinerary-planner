/**
 * 后端服务(Node 原生 http,零依赖)
 * 功能:
 *  1. 交通查询:GET /api/transport?mode=train|flight&from=..&to=..&date=..
 *  2. 数据快照(备份/恢复):/api/snapshot/:tripId (PUT/GET/DELETE), /api/snapshot (GET 列表)
 * 内部:交通查询用 child_process 调 fly-flight 的 transport_service.py(已验证可跑)
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';
import fs from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'scripts', 'transport_service.py');
const PORT = process.env.TRANSPORT_PORT || 8766;
// 快照存储目录(本地 JSON 文件,作为读取时的兜底/缓存)
const SNAP_DIR = join(__dirname, 'snapshots');
if (!fs.existsSync(SNAP_DIR)) fs.mkdirSync(SNAP_DIR, { recursive: true });

// ── Supabase 后端存储(service_role,勿放前端) ──
// 凭据从 server/.env 读取(该文件已被 gitignore,避免 key 进 git)
function loadEnv() {
  const envPath = join(__dirname, '.env');
  const env = {};
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)\s*$/);
      if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].trim();
    }
  } catch { /* 无 .env 则用 process.env */ }
  return { ...env, ...process.env };
}
const ENV = loadEnv();
const SUPABASE_URL = ENV.SUPABASE_URL;
const SUPABASE_KEY = ENV.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn('⚠️ 未配置 SUPABASE_URL/SUPABASE_KEY,快照功能将不可用(见 server/.env)');
}

// 调 Supabase REST
async function supabaseFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  return res;
}

// 快照存 Supabase:upsert 到 trips 表(snapshot jsonb 列)
async function snapSave(tripId, snap) {
  try {
    await supabaseFetch('/trips', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        id: tripId,
        title: snap.trip?.title || '',
        snapshot: snap,        // 完整快照放 jsonb
        updated_at: new Date().toISOString(),
      }),
    });
    return true;
  } catch (e) { console.warn('[snapSave] Supabase失败:', e.message); return false; }
}

async function snapLoad(tripId) {
  try {
    const res = await supabaseFetch(`/trips?select=snapshot&id=eq.${encodeURIComponent(tripId)}&limit=1`);
    if (!res.ok) return null;
    const rows = await res.json();
    return rows?.[0]?.snapshot || null;
  } catch { return null; }
}

async function snapList() {
  try {
    const res = await supabaseFetch('/trips?select=id');
    if (!res.ok) return [];
    const rows = await res.json();
    return rows.map((r) => r.id);
  } catch { return []; }
}

async function snapRemove(tripId) {
  try {
    await supabaseFetch(`/trips?id=eq.${encodeURIComponent(tripId)}`, { method: 'DELETE' });
    return true;
  } catch { return false; }
}

// 本地文件兜底存储(若 Supabase 不可用)
const snapPath = (tripId) => join(SNAP_DIR, `${tripId}.json`);

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
    return JSON.parse(res.stdout);
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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, status, obj) {
  setCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 健康检查
  if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, server: 'transport+sync', port: PORT });

  // 交通查询
  if (url.pathname === '/api/transport' && req.method === 'GET') {
    const q = url.searchParams;
    const mode = q.get('mode') || 'train';
    const from = q.get('from') || '';
    const to = q.get('to') || '';
    const date = q.get('date') || '';
    const err = validate({ mode, from, to, date });
    if (err) return sendJson(res, 400, { ok: false, error: err });
    return sendJson(res, 200, queryTransport(mode, from, to, date));
  }

  // 快照:列表 /:tripId (存 Supabase)
  if (url.pathname.startsWith('/api/snapshot')) {
    // GET /api/snapshot → 列出所有已备份 tripId
    if (url.pathname === '/api/snapshot' && req.method === 'GET') {
      const ids = await snapList();
      return sendJson(res, 200, ids);
    }
    // /api/snapshot/:tripId
    const match = url.pathname.match(/^\/api\/snapshot\/([^\/]+)$/);
    if (match) {
      const tripId = match[1];
      if (req.method === 'PUT') {
        const body = await readBody(req);
        await snapSave(tripId, body);
        return sendJson(res, 200, { ok: true, tripId, savedAt: body.savedAt });
      }
      if (req.method === 'GET') {
        const snap = await snapLoad(tripId);
        if (!snap) return sendJson(res, 404, { ok: false, error: '快照不存在' });
        return sendJson(res, 200, snap);
      }
      if (req.method === 'DELETE') {
        await snapRemove(tripId);
        return sendJson(res, 200, { ok: true });
      }
    }
    return sendJson(res, 400, { ok: false, error: '快照路由无效' });
  }

  // 预检
  if (req.method === 'OPTIONS') { setCors(res); return res.writeHead(204).end(); }

  sendJson(res, 404, { ok: false, error: `未找到路由 ${url.pathname}。可用: /api/transport, /api/health, /api/snapshot` });
});

server.listen(PORT, () => {
  console.log(`✅ 后端服务已启动: http://localhost:${PORT} (运输 + Supabase快照备份)`);
  console.log(`   交通: /api/transport?mode=train&from=北京&to=上海&date=2026-09-10`);
  console.log(`   快照: PUT/GET/DELETE /api/snapshot/:tripId (存 Supabase)`);
});