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
const SUPABASE_KEY = ENV.SUPABASE_KEY;         // service_role(服务端,绕过 RLS,勿下发)
const SUPABASE_ANON_KEY = ENV.SUPABASE_ANON_KEY || ENV.VITE_SUPABASE_ANON_KEY || ''; // anon(校验 JWT 用)
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn('⚠️ 未配置 SUPABASE_URL/SUPABASE_KEY,快照功能将不可用(见 server/.env)');
}
if (!SUPABASE_ANON_KEY) {
  console.warn('⚠️ 未配置 SUPABASE_ANON_KEY,登录鉴权将失效(前端 Auth 需用)');
}
// LLM 代理配置(key 收在服务端,不下发到前端)
const LLM_BASE_URL = ENV.LLM_BASE_URL || 'https://api.deepseek.com/v1';
const LLM_API_KEY = ENV.LLM_API_KEY || '';
const LLM_MODEL = ENV.LLM_MODEL || 'deepseek-chat';
// 高德 Web 服务 key(代理 /api/amap/place,消除前端 URL 明文 key)
const AMAP_WEB_KEY = ENV.AMAP_WEB_KEY || '';

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

// 调 Supabase Auth 校验 JWT,返回 user_id(成功)或 null(失败)
// 用 REST /auth/v1/user 校验,保持 server 零 npm 依赖
async function requireUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY || SUPABASE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.id || null;
  } catch {
    return null;
  }
}

// 快照存 Supabase:upsert 到 trips 表(snapshot jsonb 列),带 user_id 归属
async function snapSave(userId, tripId, snap) {
  console.log(`[snapSave] 收到 ${tripId} 的备份请求(标题: ${snap.trip?.title || ''})`);
  try {
    await supabaseFetch('/trips', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        id: tripId,
        user_id: userId,
        title: snap.trip?.title || '',
        snapshot: snap,        // 完整快照放 jsonb
        updated_at: new Date().toISOString(),
      }),
    });
    return true;
  } catch (e) { console.warn('[snapSave] Supabase失败:', e.message); return false; }
}

async function snapLoad(userId, tripId) {
  try {
    const res = await supabaseFetch(`/trips?select=snapshot&id=eq.${encodeURIComponent(tripId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
    if (!res.ok) return null;
    const rows = await res.json();
    return rows?.[0]?.snapshot || null;
  } catch { return null; }
}

// 旧数据迁移:首次登录的账号收养所有未归属(user_id 为空)的旅程
// 返回迁移成功与否(幂等:之后 user_id=is.null 的查询返回空)
async function adoptOrphans(userId) {
  try {
    const res = await supabaseFetch('/trips?select=id&user_id=is.null');
    if (!res.ok) return false;
    const rows = await res.json();
    if (!rows.length) return false;
    await supabaseFetch('/trips?user_id=is.null', {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: userId }),
    });
    console.log(`[adoptOrphans] 将 ${rows.length} 条未归属旅程归给首个账号`);
    return true;
  } catch { return false; }
}

async function snapList(userId) {
  await adoptOrphans(userId); // 首个账号领走旧数据
  try {
    const res = await supabaseFetch(`/trips?select=id,updated_at&user_id=eq.${encodeURIComponent(userId)}`);
    if (!res.ok) return [];
    const rows = await res.json();
    return rows.map((r) => ({ id: r.id, updatedAt: r.updated_at || null }));
  } catch { return []; }
}

async function snapRemove(userId, tripId) {
  try {
    await supabaseFetch(`/trips?id=eq.${encodeURIComponent(tripId)}&user_id=eq.${encodeURIComponent(userId)}`, { method: 'DELETE' });
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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
  // 全局请求日志:记录来源与路径,便于确认浏览器是否连到后端
  if (req.method !== 'OPTIONS') {
    console.log(`[req] ${req.method} ${url.pathname} origin=${req.headers.origin || '-'}`);
  }

  // ── CORS 预检:必须在所有路由判断之前处理,否则被各路由当业务请求返回 4xx,浏览器视为预检失败 ──
  if (req.method === 'OPTIONS') { setCors(res); return res.writeHead(204).end(); }

  // 健康检查
  if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, server: 'transport+sync', port: PORT });

  // 交通查询
  if (url.pathname === '/api/transport' && req.method === 'GET') {
    if (!(await requireUser(req))) return sendJson(res, 401, { ok: false, error: '未登录' });
    const q = url.searchParams;
    const mode = q.get('mode') || 'train';
    const from = q.get('from') || '';
    const to = q.get('to') || '';
    const date = q.get('date') || '';
    const err = validate({ mode, from, to, date });
    if (err) return sendJson(res, 400, { ok: false, error: err });
    return sendJson(res, 200, queryTransport(mode, from, to, date));
  }

  // LLM 代理:POST /api/llm/chat/completions (key 在服务端,前端零泄露)
  if (url.pathname === '/api/llm/chat/completions' && req.method === 'POST') {
    if (!(await requireUser(req))) return sendJson(res, 401, { ok: false, error: '未登录' });
    if (!LLM_API_KEY) return sendJson(res, 500, { ok: false, error: '未配置 LLM_API_KEY' });
    const body = await readBody(req);
    // 白名单透传;模型由服务端决定(前端不覆盖),key 由服务端注入
    const payload = {
      model: LLM_MODEL,
      messages: body.messages,
      temperature: typeof body.temperature === 'number' ? body.temperature : 0.3,
      ...(body.response_format ? { response_format: body.response_format } : {}),
    };
    try {
      const up = await fetch(`${LLM_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${LLM_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!up.ok) {
        const txt = await up.text();
        return sendJson(res, up.status, { ok: false, error: `上游 LLM ${up.status}`, detail: txt.slice(0, 300) });
      }
      const data = await up.json();
      return sendJson(res, 200, data);
    } catch (e) { return sendJson(res, 500, { ok: false, error: `LLM 代理失败: ${e.message}` }); }
  }

  // 高德代理:GET /api/amap/place (Web 服务 key 在服务端)
  if (url.pathname === '/api/amap/place' && req.method === 'GET') {
    if (!(await requireUser(req))) return sendJson(res, 401, { ok: false, error: '未登录' });
    const keywords = url.searchParams.get('keywords') || '';
    const city = url.searchParams.get('city') || '';
    const keyVal = AMAP_WEB_KEY || url.searchParams.get('key') || '';
    try {
      const api = 'https://restapi.amap.com/v3/place/text'
        + `?key=${encodeURIComponent(keyVal)}`
        + `&keywords=${encodeURIComponent(keywords)}`
        + `&city=${encodeURIComponent(city)}&offset=20`;
      const up = await fetch(api);
      const data = await up.json();
      return sendJson(res, 200, data);
    } catch (e) { return sendJson(res, 500, { ok: false, error: `AMAP 代理失败: ${e.message}` }); }
  }

  // 快照:列表 /:tripId (存 Supabase,需登录 + 按 user_id 隔离)
  if (url.pathname.startsWith('/api/snapshot')) {
    const userId = await requireUser(req);
    if (!userId) return sendJson(res, 401, { ok: false, error: '未登录' });
    // GET /api/snapshot → 列出当前用户所有已备份 tripId
    if (url.pathname === '/api/snapshot' && req.method === 'GET') {
      const ids = await snapList(userId);
      return sendJson(res, 200, ids);
    }
    // /api/snapshot/:tripId
    const match = url.pathname.match(/^\/api\/snapshot\/([^\/]+)$/);
    if (match) {
      const tripId = match[1];
      if (req.method === 'PUT') {
        const body = await readBody(req);
        const ok = await snapSave(userId, tripId, body);
        return sendJson(res, ok ? 200 : 500, ok ? { ok: true, tripId, savedAt: body.savedAt } : { ok: false, error: '备份失败' });
      }
      if (req.method === 'GET') {
        const snap = await snapLoad(userId, tripId);
        if (!snap) return sendJson(res, 404, { ok: false, error: '快照不存在' });
        return sendJson(res, 200, snap);
      }
      if (req.method === 'DELETE') {
        await snapRemove(userId, tripId);
        return sendJson(res, 200, { ok: true });
      }
    }
    return sendJson(res, 400, { ok: false, error: '快照路由无效' });
  }

  // 预检
  if (req.method === 'OPTIONS') { setCors(res); return res.writeHead(204).end(); }

  sendJson(res, 404, { ok: false, error: `未找到路由 ${url.pathname}。可用: /api/transport, /api/health, /api/snapshot, /api/llm/chat/completions, /api/amap/place` });
});

server.listen(PORT, () => {
  console.log(`✅ 后端服务已启动: http://localhost:${PORT} (运输 + Supabase快照备份)`);
  console.log(`   交通: /api/transport?mode=train&from=北京&to=上海&date=2026-09-10`);
  console.log(`   快照: PUT/GET/DELETE /api/snapshot/:tripId (存 Supabase)`);
});