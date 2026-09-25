/**
 * 后端服务(Node 原生 http + crypto + fs,零 npm 依赖)
 * 功能:
 *  1. 交通查询:GET /api/transport?mode=train|flight&from=..&to=..&date=..
 *  2. 数据快照(备份/恢复):/api/snapshot/:tripId (PUT/GET/DELETE), /api/sapshot (GET 列表)
 *  3. 用户认证(自建,零外部依赖):POST /api/auth/register|login|logout, GET /api/auth/me
 *  4. 分享:POST/DELETE /api/share/:tripId (需登录), GET /api/share/:token (免登录只读)
 *
 * 账号、快照、分享均存本地文件(server/data/),彻底不依赖 Supabase 等海外服务。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'scripts', 'transport_service.py');
const PORT = process.env.TRANSPORT_PORT || 8766;

// ── 本地数据存储目录(账号 / 快照 / 分享 / JWT 黑名单) ──
const DATA_DIR = join(__dirname, 'data');
const USERS_FILE = join(DATA_DIR, 'users.json');
const TRIPS_DIR = join(DATA_DIR, 'trips'); // trips/<userId>/<tripId>.json
const BLACKLIST_FILE = join(DATA_DIR, 'jwt_blacklist.json');
const JWT_SECRET_FILE = join(DATA_DIR, 'jwt_secret');
for (const d of [DATA_DIR, TRIPS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ── 配置:从 server/.env 读取(已 gitignore,避免 key 进 git) ──
function loadEnv() {
  const envPath = join(__dirname, '.env');
  const env = {};
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)\s*$/);
      if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].trim();
    }
  } catch {
    /* 无 .env 则用 process.env */
  }
  return { ...env, ...process.env };
}
const ENV = loadEnv();
// LLM 代理配置(key 收在服务端,不下发到前端)
const LLM_BASE_URL = ENV.LLM_BASE_URL || 'https://api.deepseek.com/v1';
const LLM_API_KEY = ENV.LLM_API_KEY || '';
const LLM_MODEL = ENV.LLM_MODEL || 'deepseek-chat';
// 高德 Web 服务 key(代理 /api/amap/place,消除前端 URL 明文 key)
const AMAP_WEB_KEY = ENV.AMAP_WEB_KEY || '';

// ── JWT 密钥(无配置则自动生成并持久化,保证重启后旧 token 仍有效) ──
function getJwtSecret() {
  if (ENV.JWT_SECRET && ENV.JWT_SECRET.length >= 16) return ENV.JWT_SECRET;
  try {
    if (fs.existsSync(JWT_SECRET_FILE)) return fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim();
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(JWT_SECRET_FILE, s, { mode: 0o600 });
    return s;
  } catch {
    return 'travel-insecure-default-secret-change-me';
  }
}
const JWT_SECRET = getJwtSecret();
const JWT_TTL_SECONDS = 30 * 24 * 3600; // 30 天

// base64url 编解码
function b64url(input) {
  return Buffer.from(input).toString('base64url');
}
function b64urlDecode(input) {
  return Buffer.from(input, 'base64url');
}
function signJwt(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}
function verifyJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('bad jwt');
  const [header, body, sig] = parts;
  const expected = crypto
    .createHmac('sha256', JWT_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('bad sig');
  const payload = JSON.parse(b64urlDecode(body).toString('utf8'));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('expired');
  return payload;
}

// ── 用户存储(本地文件 users.json) ──
function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function findUserByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return loadUsers().find((u) => u.email === e) || null;
}

// ── 注销黑名单(使已签发的 token 立即失效) ──
let blacklist = (() => {
  try {
    return JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf8'));
  } catch {
    return [];
  }
})();
function addBlacklist(token) {
  let exp = Math.floor(Date.now() / 1000) + JWT_TTL_SECONDS;
  try {
    const p = verifyJwt(token);
    if (p.exp) exp = p.exp;
  } catch {
    /* 已过期或非法 token 仍记录,过期后自动清理 */
  }
  blacklist.push({ token, exp });
  const now = Math.floor(Date.now() / 1000);
  blacklist = blacklist.filter((x) => x.exp > now);
  try {
    fs.writeFileSync(BLACKLIST_FILE, JSON.stringify(blacklist));
  } catch {
    /* ignore */
  }
}
function isBlacklisted(token) {
  const now = Math.floor(Date.now() / 1000);
  return blacklist.some((x) => x.token === token && x.exp > now);
}

// ── 鉴权:从 Authorization 取 token,验 JWT 返回 user_id ──
async function requireUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return null;
  if (isBlacklisted(token)) return null;
  try {
    const payload = verifyJwt(token);
    return payload?.uid || null;
  } catch {
    return null;
  }
}

// ── 本地 trips 存储(替代 Supabase) ──
function tripFile(userId, tripId) {
  // 防路径穿越:只保留安全字符
  const safeId = String(tripId).replace(/[^a-zA-Z0-9_-]/g, '');
  const safeUid = String(userId).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!fs.existsSync(join(TRIPS_DIR, safeUid))) fs.mkdirSync(join(TRIPS_DIR, safeUid), { recursive: true });
  return join(TRIPS_DIR, safeUid, `${safeId}.json`);
}
function readTripFile(userId, tripId) {
  try {
    return JSON.parse(fs.readFileSync(tripFile(userId, tripId), 'utf8'));
  } catch {
    return null;
  }
}
function writeTripFile(userId, tripId, obj) {
  fs.writeFileSync(tripFile(userId, tripId), JSON.stringify(obj, null, 2));
}

// 快照存 Supabase 已弃用 → 存本地文件;函数签名保持不变,前端 sync.ts 无需改动
async function snapSave(userId, tripId, snap) {
  console.log(`[snapSave] 收到 ${tripId} 的备份请求(标题: ${snap.trip?.title || ''})`);
  const existing = readTripFile(userId, tripId) || {};
  const obj = {
    id: tripId,
    user_id: userId,
    title: snap.trip?.title || existing.title || '',
    snapshot: snap, // 完整快照
    share_token: existing.share_token || null,
    share_route_cache: existing.share_route_cache || [],
    // 用客户端快照里的 savedAt,而【不是】服务端 now(),理由同旧实现(避免 reconcile 回环)
    updated_at: snap.savedAt || new Date().toISOString(),
  };
  try {
    writeTripFile(userId, tripId, obj);
    return true;
  } catch (e) {
    console.warn('[snapSave] 失败:', e.message);
    return false;
  }
}
async function snapLoad(userId, tripId) {
  const obj = readTripFile(userId, tripId);
  return obj?.snapshot || null;
}
async function snapList(userId) {
  const dir = join(TRIPS_DIR, String(userId).replace(/[^a-zA-Z0-9_-]/g, ''));
  try {
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    return files.map((f) => {
      try {
        const o = JSON.parse(fs.readFileSync(join(dir, f), 'utf8'));
        return { id: o.id || f.replace(/\.json$/, ''), updatedAt: o.updated_at || null };
      } catch {
        return { id: f.replace(/\.json$/, ''), updatedAt: null };
      }
    });
  } catch {
    return [];
  }
}
async function snapRemove(userId, tripId) {
  try {
    fs.unlinkSync(tripFile(userId, tripId));
    return true;
  } catch {
    return false;
  }
}

// 旧数据迁移:首个登录的账号收养所有未归属(user_id 为空)的旅程(兼容历史遗留)
async function adoptOrphans(userId) {
  try {
    const uids = fs
      .readdirSync(TRIPS_DIR)
      .filter((n) => {
        try {
          return fs.statSync(join(TRIPS_DIR, n)).isDirectory();
        } catch {
          return false;
        }
      });
    let adopted = 0;
    for (const uid of uids) {
      if (uid === userId) continue;
      const dir = join(TRIPS_DIR, uid);
      let files = [];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      } catch {
        continue;
      }
      for (const f of files) {
        const fp = join(dir, f);
        try {
          const o = JSON.parse(fs.readFileSync(fp, 'utf8'));
          if (!o.user_id) {
            o.user_id = userId;
            writeTripFile(userId, o.id || f.replace(/\.json$/, ''), o);
            try {
              fs.unlinkSync(fp);
            } catch {
              /* ignore */
            }
            adopted++;
          }
        } catch {
          /* ignore */
        }
      }
    }
    if (adopted) console.log(`[adoptOrphans] 将 ${adopted} 条未归属旅程归给 ${userId}`);
    return adopted > 0;
  } catch {
    return false;
  }
}

// ── 分享:生成/撤销不可猜测的只读 token,家人免登录按 token 查看 ──
async function shareCreate(userId, tripId, routeCache) {
  const obj = readTripFile(userId, tripId);
  if (!obj) return null;
  const token = obj.share_token || crypto.randomBytes(24).toString('hex'); // 48 位十六进制,不可猜测
  obj.share_token = token;
  if (Array.isArray(routeCache)) obj.share_route_cache = routeCache;
  try {
    writeTripFile(userId, tripId, obj);
    return token;
  } catch {
    return null;
  }
}
async function shareRevoke(userId, tripId) {
  const obj = readTripFile(userId, tripId);
  if (!obj) return false;
  obj.share_token = null;
  obj.share_route_cache = null;
  try {
    writeTripFile(userId, tripId, obj);
    return true;
  } catch {
    return false;
  }
}
// 公开读取:遍历所有用户目录,按 token 查该旅程快照(不含 user_id 过滤)
async function shareLoad(token) {
  try {
    const uids = fs
      .readdirSync(TRIPS_DIR)
      .filter((n) => {
        try {
          return fs.statSync(join(TRIPS_DIR, n)).isDirectory();
        } catch {
          return false;
        }
      });
    for (const uid of uids) {
      const dir = join(TRIPS_DIR, uid);
      let files = [];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      } catch {
        continue;
      }
      for (const f of files) {
        try {
          const o = JSON.parse(fs.readFileSync(join(dir, f), 'utf8'));
          if (o.share_token === token) {
            return { ...o.snapshot, routeCache: o.share_route_cache || [] };
          }
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

// ── 交通查询 ──
function queryTransport(mode, from, to, date) {
  const res = spawnSync(
    'python3',
    [SCRIPT, 'search', '--mode', mode, '--from', from, '--to', to, '--date', date, '--pretty'],
    { encoding: 'utf8', timeout: 30000 },
  );
  if (res.error) return { ok: false, error: `Python 进程错误: ${res.error.message}` };
  if (res.status !== 0)
    return {
      ok: false,
      error: `查询失败(status ${res.status}): ${(res.stderr || res.stdout || '').slice(0, 300)}`,
    };
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
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

// 校验邮箱格式
function isValidEmail(email) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email || '').trim());
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // 全局请求日志:记录来源与路径,便于确认浏览器是否连到后端
  if (req.method !== 'OPTIONS') {
    console.log(`[req] ${req.method} ${url.pathname} origin=${req.headers.origin || '-'}`);
  }

  // ── CORS 预检:必须在所有路由判断之前处理 ──
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.writeHead(204).end();
  }

  // 健康检查
  if (url.pathname === '/api/health')
    return sendJson(res, 200, { ok: true, server: 'travel-selfhost', auth: 'self-built', port: PORT });

  // ── 自建认证路由(免 requireUser) ──
  if (url.pathname === '/api/auth/register' && req.method === 'POST') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!isValidEmail(email)) return sendJson(res, 400, { error: '邮箱格式不正确' });
    if (password.length < 6) return sendJson(res, 400, { error: '密码至少 6 位' });
    if (findUserByEmail(email)) return sendJson(res, 409, { error: '该邮箱已注册' });
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      user_id: `u_${crypto.randomBytes(8).toString('hex')}`,
      email,
      salt,
      pw_hash: hashPassword(password, salt),
      created_at: new Date().toISOString(),
    };
    const users = loadUsers();
    users.push(user);
    saveUsers(users);
    const token = signJwt({
      uid: user.user_id,
      email: user.email,
      exp: Math.floor(Date.now() / 1000) + JWT_TTL_SECONDS,
    });
    return sendJson(res, 200, { token, user: { id: user.user_id, email: user.email } });
  }

  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const user = findUserByEmail(email);
    if (!user || user.pw_hash !== hashPassword(password, user.salt))
      return sendJson(res, 401, { error: '邮箱或密码错误' });
    const token = signJwt({
      uid: user.user_id,
      email: user.email,
      exp: Math.floor(Date.now() / 1000) + JWT_TTL_SECONDS,
    });
    return sendJson(res, 200, { token, user: { id: user.user_id, email: user.email } });
  }

  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token) addBlacklist(token);
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === '/api/auth/me' && req.method === 'GET') {
    const userId = await requireUser(req);
    if (!userId) return sendJson(res, 401, { error: '未登录' });
    const u = loadUsers().find((x) => x.user_id === userId);
    if (!u) return sendJson(res, 401, { error: '用户不存在' });
    return sendJson(res, 200, { user: { id: u.user_id, email: u.email } });
  }

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
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: `LLM 代理失败: ${e.message}` });
    }
  }

  // 高德代理:GET /api/amap/place (Web 服务 key 在服务端)
  if (url.pathname === '/api/amap/place' && req.method === 'GET') {
    if (!(await requireUser(req))) return sendJson(res, 401, { ok: false, error: '未登录' });
    const keywords = url.searchParams.get('keywords') || '';
    const city = url.searchParams.get('city') || '';
    const keyVal = AMAP_WEB_KEY || url.searchParams.get('key') || '';
    try {
      const api =
        'https://restapi.amap.com/v3/place/text' +
        `?key=${encodeURIComponent(keyVal)}` +
        `&keywords=${encodeURIComponent(keywords)}` +
        `&city=${encodeURIComponent(city)}&offset=20`;
      const up = await fetch(api);
      const data = await up.json();
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: `AMAP 代理失败: ${e.message}` });
    }
  }

  // 快照:列表 /:tripId (存本地文件,需登录 + 按 user_id 隔离)
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
        return sendJson(
          res,
          ok ? 200 : 500,
          ok ? { ok: true, tripId, savedAt: body.savedAt } : { ok: false, error: '备份失败' },
        );
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

  // 分享:POST/DELETE /api/share/:tripId (需登录,管理分享 token) + GET /api/share/:token (免登录,只读)
  if (url.pathname.startsWith('/api/share')) {
    const match = url.pathname.match(/^\/api\/share\/([^\/]+)$/);
    if (match) {
      const seg = match[1];
      // 公开只读:GET /api/share/:token —— 无需登录,仅按 token 返回该旅程快照
      if (req.method === 'GET') {
        const snap = await shareLoad(seg);
        if (!snap) return sendJson(res, 404, { ok: false, error: '分享链接无效或已撤销' });
        return sendJson(res, 200, snap);
      }
      // 生成/撤销分享:需登录,且旅程须属于当前用户
      const userId = await requireUser(req);
      if (!userId) return sendJson(res, 401, { ok: false, error: '未登录' });
      if (req.method === 'POST') {
        const body = await readBody(req);
        const token = await shareCreate(userId, seg, body.routeCache);
        if (!token) return sendJson(res, 404, { ok: false, error: '旅程不存在' });
        return sendJson(res, 200, { ok: true, token });
      }
      if (req.method === 'DELETE') {
        await shareRevoke(userId, seg);
        return sendJson(res, 200, { ok: true });
      }
    }
    return sendJson(res, 400, { ok: false, error: '分享路由无效' });
  }

  sendJson(res, 404, {
    ok: false,
    error: `未找到路由 ${url.pathname}。可用: /api/health, /api/auth/*, /api/transport, /api/snapshot, /api/share, /api/llm/chat/completions, /api/amap/place`,
  });
});

server.listen(PORT, () => {
  console.log(`✅ 后端服务已启动: http://localhost:${PORT} (运输 + 自建账号 + 本地快照)`);
  console.log(`   认证: POST /api/auth/register|login|logout , GET /api/auth/me`);
  console.log(`   交通: /api/transport?mode=train&from=北京&to=上海&date=2026-09-10`);
  console.log(`   快照: PUT/GET/DELETE /api/snapshot/:tripId (存本地文件)`);
});
