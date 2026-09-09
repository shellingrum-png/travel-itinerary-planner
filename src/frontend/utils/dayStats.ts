/**
 * 数据概览聚合(V9.0) — 纯函数,可单测,不依赖浏览器 API
 * 产出:总花费/分类/人均 + 逐日{酒店、景点、开车公里}。
 * 开车公里:同路线缓存 key(amap.ts:11 `lng|lat|lng|lat|mode`),命中 route_cache 取精确值,
 *          未命中用 haversine 直线距离兜底并标记 approx。
 */
import { haversineKm } from './tsp';
import type { Trip, ItineraryDay, ItineraryItem, Poi, Hotel, Expense, RouteCache, Transport } from '../types';

/** 路线缓存 key(与 amap.ts cacheKey 同格式,key = route_cache.id) */
export function routeCacheKey(lng1: number, lat1: number, lng2: number, lat2: number, mode: string): string {
  return [lng1, lat1, lng2, lat2, mode].join('|');
}

export interface DayPoi {
  name: string;
  category: string;
}

export interface DayStats {
  daySeq: number;
  date: string;
  hotelName: string;     // 住哪(多家用空串分隔,无则 '—')
  hotelCount: number;
  pois: DayPoi[];
  driveKm: number;       // 该天开车总公里(近似值按 approx 标记)
  driveKmApprox: boolean;
  spend: number;         // 当日花费
}

export interface TripOverview {
  totalSpend: number;
  spendByCategory: Record<string, number>;
  perCapita: number;
  dayStats: DayStats[];
}

interface OverviewInput {
  trip: Trip;
  days: ItineraryDay[];
  itemsByDay: Record<string, ItineraryItem[]>; // dayId → items(按 orderSeq)
  pois: Poi[];          // 按 id 建索引
  hotels: Hotel[];
  transports: Transport[]; // 预留:大交通费不重复计入
  expenses: Expense[];
  routeCache: RouteCache[]; // 全部路径缓存,key=routeCache.id
}

const inInterval = (date: string, checkIn?: string, checkOut?: string): boolean => {
  if (!checkIn) return false;
  if (date < checkIn) return false;
  if (checkOut && date > checkOut) return false;
  return true;
};

export function computeTripOverview(input: OverviewInput): TripOverview {
  const { trip, days, itemsByDay, pois, hotels, expenses, routeCache } = input;
  const poiById = new Map(pois.map((p) => [p.id, p]));
  const routeDistanceById = new Map(routeCache.map((r) => [r.id, r.distanceM]));

  // 花费
  const totalSpend = expenses.reduce((s, e) => s + e.amount, 0);
  const spendByCategory: Record<string, number> = {};
  for (const e of expenses) spendByCategory[e.category] = (spendByCategory[e.category] || 0) + e.amount;
  const perCapita = totalSpend / Math.max(1, trip.companionCount || 1);

  const dayStats: DayStats[] = days
    .slice()
    .sort((a, b) => a.daySeq - b.daySeq)
    .map((day) => {
      const items = (itemsByDay[day.id] || []).slice().sort((a, b) => a.orderSeq - b.orderSeq);

      // ── 酒店:优先当天 hotel item,兜底按 checkIn/checkOut 区间匹配 ──
      const hotelNames = new Set<string>();
      for (const it of items) {
        if (it.itemType === 'hotel') {
          const h = hotels.find((x) => x.poiId === it.poiId);
          hotelNames.add(h?.name || it.note || '酒店');
        }
      }
      for (const h of hotels) {
        if (inInterval(day.date, h.checkIn, h.checkOut)) hotelNames.add(h.name);
      }
      const hotelName = hotelNames.size ? [...hotelNames].join(' / ') : '—';

      // ── 当日景点 ──
      const dayPois: DayPoi[] = [];
      for (const it of items) {
        if (it.itemType !== 'poi') continue;
        const poi = it.poiId ? poiById.get(it.poiId) : undefined;
        if (poi) dayPois.push({ name: poi.name, category: poi.category || 'poi' });
      }

      // ── 每天开车公里:顺序遍历带坐标节点(hotel 锚点 + poi),相邻 drive 段求和 ──
      let driveKm = 0;
      let driveKmApprox = false;
      const nodes: { lng: number; lat: number; mode?: string }[] = [];
      for (const it of items) {
        if (it.itemType === 'transport' || it.itemType === 'buffer') continue;
        const poi = it.poiId ? poiById.get(it.poiId) : undefined;
        if (!poi) continue;
        nodes.push({ lng: poi.lng, lat: poi.lat, mode: it.transportMode });
      }
      for (let i = 1; i < nodes.length; i++) {
        const prev = nodes[i - 1];
        const cur = nodes[i];
        if (cur.mode !== 'drive') continue;
        const key = routeCacheKey(prev.lng, prev.lat, cur.lng, cur.lat, 'drive');
        const dist = routeDistanceById.get(key);
        if (typeof dist === 'number') {
          driveKm += dist / 1000;
        } else {
          driveKm += haversineKm(prev.lng, prev.lat, cur.lng, cur.lat);
          driveKmApprox = true;
        }
      }

      // 当日花费:按 dayId 或 date 匹配
      const spend = expenses.reduce((s, e) => (e.dayId === day.id || e.date === day.date ? s + e.amount : s), 0);

      return {
        daySeq: day.daySeq,
        date: day.date,
        hotelName,
        hotelCount: hotelNames.size,
        pois: dayPois,
        driveKm: Math.round(driveKm * 10) / 10,
        driveKmApprox,
        spend: Math.round(spend * 100) / 100,
      };
    });

  return { totalSpend, spendByCategory, perCapita, dayStats };
}
