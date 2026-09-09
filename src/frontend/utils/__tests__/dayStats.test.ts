import { describe, it, expect } from 'vitest';
import { computeTripOverview, routeCacheKey } from '../dayStats';
import type { Trip, ItineraryDay, ItineraryItem, Poi, Hotel, Expense, RouteCache, Transport } from '../../types';

const trip: Trip = {
  id: 'trip1', title: '青海行', destination: '青海', startDate: '2026-09-30',
  endDate: '2026-10-02', status: 'planning', companionCount: 2, currency: 'CNY',
};

const day = (daySeq: number, id: string, date: string): ItineraryDay => ({ id, tripId: 'trip1', daySeq, date });

const poi = (id: string, name: string, lng: number, lat: number, category: Poi['category'] = 'poi'): Poi => ({
  id, name, lng, lat, category,
});

const item = (dayId: string, orderSeq: number, opts: Partial<ItineraryItem>): ItineraryItem => ({
  id: `i${dayId}-${orderSeq}`, dayId, orderSeq, itemType: 'poi', transportMode: 'walk', ...opts,
});

describe('routeCacheKey', () => {
  it('与 amap.ts 同格式:[lng|lat|lng|lat|mode]', () => {
    expect(routeCacheKey(100.1, 30.2, 101.3, 31.4, 'drive')).toBe('100.1|30.2|101.3|31.4|drive');
  });
});

describe('computeTripOverview — 花费', () => {
  it('总花费/分类/人均', () => {
    const expenses: Expense[] = [
      { id: 'e1', tripId: 'trip1', category: 'food', amount: 100, currency: 'CNY', dirty: 0 },
      { id: 'e2', tripId: 'trip1', category: 'ticket', amount: 60, currency: 'CNY', dirty: 0 },
      { id: 'e3', tripId: 'trip1', category: 'food', amount: 40, currency: 'CNY', dirty: 0 },
    ];
    const ov = computeTripOverview({
      trip, days: [], itemsByDay: {}, pois: [], hotels: [], transports: [], expenses, routeCache: [],
    });
    expect(ov.totalSpend).toBe(200);
    expect(ov.perCapita).toBe(100); // 2人
    expect(ov.spendByCategory).toEqual({ food: 140, ticket: 60 });
  });

  it('companionCount 缺省时人均=总花费', () => {
    const ov = computeTripOverview({
      trip: { ...trip, companionCount: 0 }, days: [], itemsByDay: {}, pois: [],
      hotels: [], transports: [], expenses: [{ id: 'e', tripId: 'trip1', category: 'other', amount: 50, currency: 'CNY', dirty: 0 }], routeCache: [],
    });
    expect(ov.perCapita).toBe(50);
  });
});

describe('computeTripOverview — 逐日酒店/景点', () => {
  const days = [day(1, 'd1', '2026-09-30'), day(2, 'd2', '2026-10-01')];
  const pois = [poi('p1', '塔尔寺', 101.7, 36.5), poi('p2', '青海湖', 100.2, 36.9)];

  it('酒店按 checkIn/checkOut 区间匹配(单晚 hotel 覆盖入住当天)', () => {
    const hotels: Hotel[] = [
      { id: 'h1', tripId: 'trip1', name: '西宁酒店', checkIn: '2026-09-30', checkOut: '2026-09-30' },
    ];
    const itemsByDay: Record<string, ItineraryItem[]> = {
      d1: [item('d1', 0, { poiId: 'p1' }), item('d1', 1, { poiId: 'p2' })],
      d2: [],
    };
    const ov = computeTripOverview({
      trip, days, itemsByDay, pois, hotels, transports: [], expenses: [], routeCache: [],
    });
    expect(ov.dayStats[0].hotelName).toBe('西宁酒店');
    expect(ov.dayStats[1].hotelName).toBe('—'); // 10-01 不在入住区间
  });

  it('酒店 item 优先于区间匹配;move 日多家合并', () => {
    const hotels: Hotel[] = [
      { id: 'h1', tripId: 'trip1', name: '敦煌A', poiId: 'ph1' },
      { id: 'h2', tripId: 'trip1', name: '敦煌B', checkIn: '2026-09-30', checkOut: '2026-09-30' },
    ];
    const itemsByDay: Record<string, ItineraryItem[]> = {
      d1: [item('d1', 0, { poiId: 'ph1', itemType: 'hotel', note: '敦煌A' })],
    };
    const ov = computeTripOverview({
      trip, days: [day(1, 'd1', '2026-09-30')], itemsByDay,
      pois: [{ ...poi('ph1', '敦煌A', 94.6, 40.1, 'hotel') }], hotels, transports: [], expenses: [], routeCache: [],
    });
    expect(ov.dayStats[0].hotelName).toBe('敦煌A / 敦煌B');
    expect(ov.dayStats[0].hotelCount).toBe(2);
  });

  it('当日景点列表(item_type=poi)', () => {
    const itemsByDay: Record<string, ItineraryItem[]> = {
      d1: [item('d1', 0, { poiId: 'p1' }), item('d1', 1, { poiId: 'p2' })],
    };
    const ov = computeTripOverview({
      trip, days: [day(1, 'd1', '2026-09-30')], itemsByDay, pois,
      hotels: [], transports: [], expenses: [], routeCache: [],
    });
    expect(ov.dayStats[0].pois.map((p) => p.name)).toEqual(['塔尔寺', '青海湖']);
  });
});

describe('computeTripOverview — 每天开车公里', () => {
  const d1 = day(1, 'd1', '2026-09-30');
  const p1 = poi('p1', '塔尔寺', 101.0, 36.5);
  const p2 = poi('p2', '青海湖', 101.0, 36.9);

  it('命中 route_cache 取精确距离', () => {
    const key = routeCacheKey(101.0, 36.5, 101.0, 36.9, 'drive');
    const rc: RouteCache[] = [{
      id: key, originLng: 101.0, originLat: 36.5, destLng: 101.0, destLat: 36.9,
      mode: 'drive', distanceM: 45000, durationMin: 40, ttlDays: 30, fetchedAt: new Date().toISOString(),
    }];
    const itemsByDay: Record<string, ItineraryItem[]> = {
      d1: [item('d1', 0, { poiId: 'p1', transportMode: 'walk' }), item('d1', 1, { poiId: 'p2', transportMode: 'drive' })],
    };
    const ov = computeTripOverview({
      trip, days: [d1], itemsByDay, pois: [p1, p2], hotels: [], transports: [], expenses: [], routeCache: rc,
    });
    expect(ov.dayStats[0].driveKm).toBe(45);
    expect(ov.dayStats[0].driveKmApprox).toBe(false);
  });

  it('未命中缓存用 haversine 兜底并标记 approx(直线距离,两坐标同经度南北相距约44.5km)', () => {
    const itemsByDay: Record<string, ItineraryItem[]> = {
      d1: [item('d1', 0, { poiId: 'p1', transportMode: 'walk' }), item('d1', 1, { poiId: 'p2', transportMode: 'drive' })],
    };
    const ov = computeTripOverview({
      trip, days: [d1], itemsByDay, pois: [p1, p2], hotels: [], transports: [], expenses: [], routeCache: [],
    });
    expect(ov.dayStats[0].driveKmApprox).toBe(true);
    expect(ov.dayStats[0].driveKm).toBeGreaterThan(40);
    expect(ov.dayStats[0].driveKm).toBeLessThan(50);
  });

  it('非 drive 段不计入距离', () => {
    const p3 = poi('p3', '门源', 101.0, 37.4);
    const itemsByDay: Record<string, ItineraryItem[]> = {
      d1: [
        item('d1', 0, { poiId: 'p1', transportMode: 'walk' }),
        item('d1', 1, { poiId: 'p2', transportMode: 'transit' }), // 公交
        item('d1', 2, { poiId: 'p3', transportMode: 'walk' }),
      ],
    };
    const ov = computeTripOverview({
      trip, days: [d1], itemsByDay, pois: [p1, p2, p3], hotels: [], transports: [], expenses: [], routeCache: [],
    });
    expect(ov.dayStats[0].driveKm).toBe(0);
  });
});
