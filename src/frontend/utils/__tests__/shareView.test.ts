import { describe, it, expect } from 'vitest';
import { snapshotToOverview } from '../shareView';
import type { TripSnapshot } from '../../services/sync';
import type { Trip, ItineraryDay, ItineraryItem, Poi, Hotel, Expense } from '../../types';

const trip: Trip = {
  id: 'trip1', title: '青海行', destination: '青海', startDate: '2026-09-30',
  endDate: '2026-10-01', status: 'planning', companionCount: 2, currency: 'CNY',
};

const snapshot: TripSnapshot = {
  trip,
  days: [
    { id: 'd1', tripId: 'trip1', daySeq: 1, date: '2026-09-30' },
    { id: 'd2', tripId: 'trip1', daySeq: 2, date: '2026-10-01' },
  ] as ItineraryDay[],
  items: [
    { id: 'i1', dayId: 'd1', orderSeq: 0, itemType: 'poi', poiId: 'p1', transportMode: 'drive' },
    { id: 'i2', dayId: 'd1', orderSeq: 1, itemType: 'poi', poiId: 'p2', transportMode: 'drive' },
    { id: 'i3', dayId: 'd2', orderSeq: 0, itemType: 'poi', poiId: 'p3', transportMode: 'walk' },
  ] as ItineraryItem[],
  pois: [
    { id: 'p1', name: '塔尔寺', lng: 101.7, lat: 36.5, category: 'poi' },
    { id: 'p2', name: '青海湖', lng: 100.2, lat: 36.9, category: 'poi' },
    { id: 'p3', name: '茶卡盐湖', lng: 99.1, lat: 36.7, category: 'poi' },
  ] as Poi[],
  aiCards: [],
  hotels: [
    { id: 'h1', tripId: 'trip1', name: '西宁酒店', checkIn: '2026-09-30', checkOut: '2026-09-30' },
  ] as Hotel[],
  transports: [],
  expenses: [
    { id: 'e1', tripId: 'trip1', category: 'food', amount: 100, currency: 'CNY', dirty: 0, dayId: 'd1' },
    { id: 'e2', tripId: 'trip1', category: 'ticket', amount: 60, currency: 'CNY', dirty: 0, dayId: 'd1' },
  ] as Expense[],
  savedAt: '2026-09-14T00:00:00.000Z',
};

describe('snapshotToOverview — 分享快照转概览', () => {
  it('按 dayId 正确分组 items,逐日景点不串天', () => {
    const ov = snapshotToOverview(snapshot);
    expect(ov.dayStats).toHaveLength(2);
    expect(ov.dayStats[0].pois.map((p) => p.name)).toEqual(['塔尔寺', '青海湖']);
    expect(ov.dayStats[1].pois.map((p) => p.name)).toEqual(['茶卡盐湖']);
  });

  it('花费与人均来自快照 expenses', () => {
    const ov = snapshotToOverview(snapshot);
    expect(ov.totalSpend).toBe(160);
    expect(ov.perCapita).toBe(80); // 2人
    expect(ov.spendByCategory).toEqual({ food: 100, ticket: 60 });
    expect(ov.dayStats[0].spend).toBe(160); // 两笔都在 d1
  });

  it('酒店按入住区间匹配', () => {
    const ov = snapshotToOverview(snapshot);
    expect(ov.dayStats[0].hotelName).toBe('西宁酒店');
    expect(ov.dayStats[1].hotelName).toBe('—');
  });

  it('无 routeCache 时公里数走 haversine 近似(approx 标记)', () => {
    const ov = snapshotToOverview(snapshot);
    // d1 有两个 drive 段(塔尔寺→青海湖),快照无路径缓存 → 近似
    expect(ov.dayStats[0].driveKm).toBeGreaterThan(0);
    expect(ov.dayStats[0].driveKmApprox).toBe(true);
    // d2 只有单点,无段
    expect(ov.dayStats[1].driveKm).toBe(0);
  });

  it('空快照不抛错', () => {
    const empty: TripSnapshot = { ...snapshot, days: [], items: [], pois: [], hotels: [], expenses: [] };
    const ov = snapshotToOverview(empty);
    expect(ov.dayStats).toEqual([]);
    expect(ov.totalSpend).toBe(0);
  });
});
