/**
 * 分享服务:为单个旅程生成不可猜测的只读链接,家人免登录查看。
 * 生成/撤销需登录(后端校验旅程归属);读取公开(仅凭 token)。
 */
import { getAccessToken } from './auth';
import { db } from './db';
import type { TripSnapshot } from './sync';
import type { RouteCache } from '../types';

// 与 sync.ts 同源拼法:VITE_SYNC_API 是「源站」,未配置→本地 8766;配置为空→同源
const SYNC_ORIGIN = import.meta.env.VITE_SYNC_API ?? 'http://localhost:8766';
const BACKEND_BASE = `${SYNC_ORIGIN}/api`;

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * 生成(或取回已有)分享 token;失败抛错。
 * 同时把本地已算好的路线缓存一并提交(后端存 share_route_cache),
 * 家人端打开分享时直接回填,免于冷启动重算(高德插件首载慢会撞超时退近似)。
 */
export async function createShare(tripId: string): Promise<string> {
  let routeCache: RouteCache[] = [];
  try { routeCache = await db.listRouteCache(); } catch { /* 读不到就空下发 */ }
  const res = await fetch(`${BACKEND_BASE}/share/${encodeURIComponent(tripId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ routeCache }),
  });
  if (!res.ok) throw new Error(`生成分享链接失败 HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.token) throw new Error('生成分享链接失败:响应缺少 token');
  return data.token;
}

/** 撤销分享(原链接立即失效);失败抛错 */
export async function revokeShare(tripId: string): Promise<void> {
  const res = await fetch(`${BACKEND_BASE}/share/${encodeURIComponent(tripId)}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  // 必须检查状态码:否则 401/500 会被当成"已撤销"
  if (!res.ok) throw new Error(`撤销分享失败 HTTP ${res.status}`);
}

/** 按 token 拉取分享快照(免登录);无效/已撤销返回 null。附带的 routeCache 由后端下发 */
export async function fetchSharedTrip(token: string): Promise<(TripSnapshot & { routeCache?: RouteCache[] }) | null> {
  const res = await fetch(`${BACKEND_BASE}/share/${encodeURIComponent(token)}`);
  if (!res.ok) return null;
  return res.json();
}

/** 拼接可分享的完整 URL(生产为公网地址,dev 为本地) */
export function shareUrl(token: string): string {
  return `${window.location.origin}/share/${token}`;
}
