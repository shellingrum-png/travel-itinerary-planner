import { describe, it, expect } from 'vitest';
import { detectConflicts, type ConflictInput } from '../conflicts';
import type { ItineraryItem, Poi, PoiAiCard } from '../../types';

function item(overrides: Partial<ItineraryItem> = {}): ItineraryItem {
  return {
    id: 'i1',
    dayId: 'd1',
    itemType: 'poi',
    orderSeq: 0,
    transportMode: 'walk',
    ...overrides,
  };
}

function poi(overrides: Partial<Poi> = {}): Poi {
  return {
    id: 'p1',
    name: '测试景点',
    lng: 100,
    lat: 38,
    category: 'poi',
    ...overrides,
  };
}

function itemWithPoi(overrides: Partial<ItineraryItem> = {}, p?: Poi, card?: PoiAiCard): ItineraryItem & { poi?: Poi; card?: PoiAiCard } {
  return {
    id: 'i1',
    dayId: 'd1',
    itemType: 'poi',
    orderSeq: 0,
    transportMode: 'walk',
    ...overrides,
    poi: p,
    card,
  };
}

function makeCard(suggestDuration: number): PoiAiCard {
  return {
    poiId: 'p1',
    recommendReason: 'test',
    pitfallGuide: 'test',
    suggestDuration,
    tips: [],
    rating: 4,
    cacheKey: 'test',
  };
}

describe('detectConflicts', () => {
  it('空列表无冲突', () => {
    expect(detectConflicts({ items: [], spent: 0 })).toEqual([]);
  });

  it('时间重叠: 前节点 leave > 后节点 arrive', () => {
    const result = detectConflicts({
      items: [
        item({ id: 'a', arriveTime: '09:00', leaveTime: '10:00', orderSeq: 0 }),
        item({ id: 'b', arriveTime: '09:30', leaveTime: '11:00', orderSeq: 1 }),
      ],
      spent: 0,
    });
    const overlap = result.find((c) => c.type === 'overlap');
    expect(overlap).toBeDefined();
    expect(overlap!.level).toBe('yellow');
  });

  it('无重叠时不触发', () => {
    const result = detectConflicts({
      items: [
        item({ id: 'a', arriveTime: '09:00', leaveTime: '10:00', orderSeq: 0 }),
        item({ id: 'b', arriveTime: '10:30', leaveTime: '12:00', orderSeq: 1 }),
      ],
      spent: 0,
    });
    expect(result.find((c) => c.type === 'overlap')).toBeUndefined();
  });

  it('闭馆冲突: 当日闭馆才触发', () => {
    // 2026-10-05 是周一
    const p = poi({ name: '故宫', closedDays: ['周一'] });
    const result = detectConflicts({
      items: [itemWithPoi({ id: 'a', orderSeq: 0 }, p)],
      spent: 0,
      dayDate: '2026-10-05', // 周一
    });
    const closed = result.find((c) => c.type === 'closed');
    expect(closed).toBeDefined();
    expect(closed!.message).toContain('故宫');
  });

  it('闭馆冲突: 非当日闭馆不触发', () => {
    const p = poi({ name: '故宫', closedDays: ['周一'] });
    const result = detectConflicts({
      items: [itemWithPoi({ id: 'a', orderSeq: 0 }, p)],
      spent: 0,
      dayDate: '2026-10-06', // 周二
    });
    expect(result.find((c) => c.type === 'closed')).toBeUndefined();
  });

  it('无 closedDays 时不触发闭馆', () => {
    const p = poi({ closedDays: [] });
    const result = detectConflicts({
      items: [itemWithPoi({ id: 'a', orderSeq: 0 }, p)],
      spent: 0,
      dayDate: '2026-10-05',
    });
    expect(result.find((c) => c.type === 'closed')).toBeUndefined();
  });

  // ── 关键边界测试: 15min 无预警, 14min 有预警 ──

  it('留白 = 15min → 无通勤过紧预警', () => {
    const result = detectConflicts({
      items: [
        item({ id: 'a', arriveTime: '09:00', leaveTime: '09:30', orderSeq: 0 }),
        item({ id: 'b', arriveTime: '09:45', leaveTime: '10:30', orderSeq: 1 }),
      ],
      spent: 0,
    });
    expect(result.find((c) => c.type === 'tight_transit')).toBeUndefined();
  });

  it('留白 = 14min → 有通勤过紧预警', () => {
    const result = detectConflicts({
      items: [
        item({ id: 'a', arriveTime: '09:00', leaveTime: '09:30', orderSeq: 0 }),
        item({ id: 'b', arriveTime: '09:44', leaveTime: '10:30', orderSeq: 1 }),
      ],
      spent: 0,
    });
    const tight = result.find((c) => c.type === 'tight_transit');
    expect(tight).toBeDefined();
    expect(tight!.level).toBe('yellow');
  });

  // 预算超额

  it('预算超额 → 红标', () => {
    const result = detectConflicts({
      items: [],
      spent: 6000,
      budget: 5000,
    });
    const over = result.find((c) => c.type === 'over_budget');
    expect(over).toBeDefined();
    expect(over!.level).toBe('red');
  });

  it('预算未超不触发', () => {
    const result = detectConflicts({
      items: [],
      spent: 3000,
      budget: 5000,
    });
    expect(result.find((c) => c.type === 'over_budget')).toBeUndefined();
  });

  it('无预算不判定', () => {
    const result = detectConflicts({
      items: [],
      spent: 9999,
    });
    expect(result.find((c) => c.type === 'over_budget')).toBeUndefined();
  });

  // 游览超建议

  it('游览超建议 1.5 倍 → 灰标', () => {
    const card = makeCard(60);
    const result = detectConflicts({
      items: [itemWithPoi({ id: 'a', orderSeq: 0, visitMinutes: 100 }, poi({ name: '测试' }), card)],
      spent: 0,
    });
    const over = result.find((c) => c.type === 'over_suggest');
    expect(over).toBeDefined();
    expect(over!.level).toBe('grey');
  });

  it('未超建议不触发', () => {
    const card = makeCard(60);
    const result = detectConflicts({
      items: [itemWithPoi({ id: 'a', orderSeq: 0, visitMinutes: 80 }, poi({ name: '测试' }), card)],
      spent: 0,
    });
    expect(result.find((c) => c.type === 'over_suggest')).toBeUndefined();
  });

  it('无 AI 卡片不判定游览超建议', () => {
    const result = detectConflicts({
      items: [itemWithPoi({ id: 'a', orderSeq: 0, visitMinutes: 200 }, poi({ name: '测试' }))],
      spent: 0,
    });
    expect(result.find((c) => c.type === 'over_suggest')).toBeUndefined();
  });
});
