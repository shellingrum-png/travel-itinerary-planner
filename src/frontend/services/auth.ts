/**
 * 认证模块(自建,零外部依赖)
 * 用自建后端 /api/auth/* 做邮箱+密码注册/登录,导出 token 给 sync.ts 与路由守卫。
 * 不再依赖任何海外服务(Supabase 已弃用),所有鉴权走同源后端。
 */
const TOKEN_KEY = 'travel_token';
const USER_KEY = 'travel_user';

// 与 sync.ts/share.ts 同源拼法:VITE_SYNC_API 是「源站」,未配置→本地 8766;配置为空→同源
const BACKEND_BASE = `${import.meta.env.VITE_SYNC_API ?? 'http://localhost:8766'}/api`;

export interface AuthUser {
  id: string;
  email?: string;
}

export function isAuthConfigured(): boolean {
  // 自建登录始终启用(无后端时仍会显示登录页,提交后被后端拒绝)
  return true;
}

function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function getAccessToken(): Promise<string | null> {
  return getToken();
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const t = getToken();
  return { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...extra };
}

async function persist(token: string, user: AuthUser): Promise<void> {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* 隐私模式可能抛错,忽略 */
  }
  notify(user);
}

export async function signIn(email: string, password: string): Promise<AuthUser> {
  const res = await fetch(`${BACKEND_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({ error: '登录失败' }))) as { error?: string };
    throw new Error(e.error || `登录失败 (${res.status})`);
  }
  const data = (await res.json()) as { token: string; user: AuthUser };
  await persist(data.token, data.user);
  return data.user;
}

export async function signUp(
  email: string,
  password: string,
): Promise<{ hasSession: boolean; user: AuthUser | null }> {
  const res = await fetch(`${BACKEND_BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({ error: '注册失败' }))) as { error?: string };
    throw new Error(e.error || `注册失败 (${res.status})`);
  }
  const data = (await res.json()) as { token: string; user: AuthUser };
  await persist(data.token, data.user);
  // 注册即登录(后端直接签发 token)
  return { hasSession: true, user: data.user };
}

export async function signOut(): Promise<void> {
  const t = getToken();
  if (t) {
    try {
      await fetch(`${BACKEND_BASE}/auth/logout`, { method: 'POST', headers: authHeaders() });
    } catch {
      /* 忽略网络错误,本地清理照常 */
    }
  }
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
  notify(null);
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  // 优先用本地缓存,避免每次启动都打 /me
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (raw) return JSON.parse(raw) as AuthUser;
  } catch {
    /* 解析失败则回退到 /me */
  }
  const t = getToken();
  if (!t) return null;
  try {
    const res = await fetch(`${BACKEND_BASE}/auth/me`, { headers: authHeaders() });
    if (!res.ok) return null;
    const data = (await res.json()) as { user: AuthUser | null };
    return data.user ?? null;
  } catch {
    return null;
  }
}

// ── 模拟 Supabase 的 onAuthStateChange ──
// 用回调集合,首次异步触发当前登录态;signIn/signUp/signOut 时主动通知所有订阅者。
const listeners = new Set<(u: AuthUser | null) => void>();

function notify(u: AuthUser | null): void {
  listeners.forEach((cb) => {
    try {
      cb(u);
    } catch {
      /* ignore */
    }
  });
}

export function onAuthStateChange(cb: (u: AuthUser | null) => void): { unsubscribe: () => void } {
  listeners.add(cb);
  // 立即异步触发一次当前状态(等价于 Supabase 的首个回调)
  void getCurrentUser()
    .then((u) => cb(u))
    .catch(() => cb(null));
  return { unsubscribe: () => listeners.delete(cb) };
}
