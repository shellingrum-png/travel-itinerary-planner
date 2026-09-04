/**
 * 路径规划服务(含缓存层,防重复计费) — 全部走高德 JS API 插件(免 Web 服务 Key)
 * getDuration:
 *   1) 命中 route_cache → 直接返回(0 API 调用)
 *   2) 未命中 → 调高德 Driving/Walking/Transfer → 写缓存返回
 */
import { db, ROUTE_CACHE_TTL_DAYS } from './db';
import type { TransportMode } from '../types';

/** md5 -> hex(JS 侧需用纯 JS 实现或 react-native-md5,V1 可用简化 hash) */
const cacheKey = (a: [number, number], b: [number, number], mode: TransportMode) =>
  [a[0], a[1], b[0], b[1], mode].join('|');

export interface PoiSearchResult {
  id: string;
  name: string;
  address: string;
  lng: number;
  lat: number;
  type: string;
}

import { loadPlaceSearch, loadRoutePlanner } from './amapLoader';

/** 使用高德 JS API PlaceSearch（无需 Web 服务 Key） */
export async function searchPoiByJS(keyword: string, city?: string): Promise<PoiSearchResult[]> {
  const PlaceSearch = await loadPlaceSearch();
  return new Promise((resolve, reject) => {
    // city 为空 → 不限定城市,按关键词全范围检索(旧数据修复场景命中率更高)
    const ps = city ? new PlaceSearch({ city, pageSize: 20 }) : new PlaceSearch({ pageSize: 20 });
    ps.search(keyword, (status: string, result: any) => {
      if (status !== 'complete' || !result.poiList) {
        resolve([]);
        return;
      }
      const pois = result.poiList.pois || [];
      resolve(pois.map((p: any) => {
        const loc = typeof p.location === 'string'
          ? p.location.split(',').map(Number)
          : [p.location?.lng ?? 0, p.location?.lat ?? 0];
        return {
          id: p.id,
          name: p.name,
          address: p.address || '',
          lng: loc[0],
          lat: loc[1],
          type: p.type || '',
        };
      }));
    });
  });
}

export async function getDuration(
  from: [number, number],
  to: [number, number],
  mode: TransportMode,
  city?: string,
): Promise<{ durationMin: number; distanceM: number }> {
  const key = cacheKey(from, to, mode);

  // 1) 缓存命中(优先,防重复计费)
  const hit = await db.getRouteCache(key);
  if (hit) return { durationMin: hit.durationMin, distanceM: hit.distanceM };

  // 2) 调高德 JS API 路线规划插件(免 Web 服务 Key)
  try {
    const Cls = await loadRoutePlanner(mode === 'transit' ? 'transit' : mode === 'walk' ? 'walk' : 'drive');
    const result = await new Promise<{ durationMin: number; distanceM: number } | null>((resolve) => {
      const planner = new Cls({ city: city || '北京', pageSize: 1 });
      planner.search(from, to, (status: string, r: any) => {
        if (status === 'complete' && r) {
          // 驾车/步行:r.routes[0] ;公交:r.plans[0]
          const first = (r.routes && r.routes[0]) || (r.plans && r.plans[0]);
          if (first) {
            resolve({ durationMin: Math.round(Number(first.time || 0) / 60), distanceM: Number(first.distance || 0) });
            return;
          }
        }
        resolve(null);
      });
      // 超时兜底,避免卡死
      setTimeout(() => resolve(null), 5000);
    });

    if (!result) throw new Error('NO_ROUTE');
    // 3) 写缓存
    await db.upsertRouteCache({
      key,
      origin: from,
      dest: to,
      mode,
      durationMin: result.durationMin,
      distanceM: result.distanceM,
      ttlDays: ROUTE_CACHE_TTL_DAYS,
    });
    return result;
  } catch {
    // 全部失败:返回保守默认值,不阻塞用户
    const defaults: Record<TransportMode, number> = { walk: 45, drive: 30, transit: 60 };
    return { durationMin: defaults[mode] || 45, distanceM: 0 };
  }
}