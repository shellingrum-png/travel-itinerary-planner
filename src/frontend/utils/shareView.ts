/**
 * 分享快照 → 概览聚合(纯函数,无 React/浏览器依赖,便于单测)。
 * 复用 computeTripOverview,把 TripSnapshot 转成其输入结构。
 */
import { computeTripOverview, type TripOverview } from './dayStats';
import type { ItineraryItem, RouteCache } from '../types';
import type { TripSnapshot } from '../services/sync';

export function snapshotToOverview(snap: TripSnapshot): TripOverview {
  const itemsByDay: Record<string, ItineraryItem[]> = {};
  for (const it of snap.items) (itemsByDay[it.dayId] ||= []).push(it);
  return computeTripOverview({
    trip: snap.trip,
    days: snap.days,
    itemsByDay,
    pois: snap.pois,
    hotels: snap.hotels,
    transports: snap.transports,
    expenses: snap.expenses,
    // 快照不含路径缓存 → 公里数走 haversine 近似(带 approx 标记)
    routeCache: [] as RouteCache[],
  });
}
