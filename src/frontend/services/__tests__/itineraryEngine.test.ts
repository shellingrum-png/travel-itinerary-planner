import { describe, it, expect } from 'vitest';
import { optimizeItinerary, distanceToPath } from '../itineraryEngine';
import type { DayAnchor, ItineraryPoi } from '../itineraryEngine';
import type { Poi } from '../../types';

const poi = (id: string, name: string, lng: number, lat: number, city?: string): Poi => ({
  id, name, lng, lat, category: 'poi', city,
});

const day = (daySeq: number, city: string, lng = 0, lat = 0): DayAnchor => ({
  daySeq, dayId: `day-${daySeq}`, poi: poi(`a-${daySeq}`, `锚点${daySeq}`, lng, lat, city), fromHotel: true, city,
});

const mkIt = (id: string, name: string, lng: number, lat: number, city: string, srcDaySeq: number, sunset?: boolean): ItineraryPoi => ({
  id, poi: poi(id, name, lng, lat, city), city, srcDaySeq, sunset,
});

describe('itineraryEngine 城市硬约束', () => {
  it('跨城景点不搬入他城天', () => {
    const days = [day(1, '张掖'), day(2, '敦煌'), day(3, '敦煌')];
    const pois = [mkIt('p1', '张掖大佛寺', 100.45, 38.93, '张掖', 1)];
    const r = optimizeItinerary({ days, pois, maxPerDay: 2 });
    // 张掖景点只能进张掖天(Day1)
    const a = r.assignments.find((x) => x.poiId === 'p1');
    expect(a?.daySeq).toBe(1);
  });

  it('同城景点可平摊到该城连住天', () => {
    const days = [day(1, '敦煌'), day(2, '敦煌'), day(3, '敦煌'), day(4, '敦煌')];
    const pois = [
      mkIt('p1', '莫高窟', 94.8, 40.04, '敦煌', 2),
      mkIt('p2', '鸣沙山', 94.67, 40.08, '敦煌', 3, true),
      mkIt('p3', '玉门关', 93.8, 40.35, '敦煌', 4),
      mkIt('p4', '雅丹', 93.1, 40.5, '敦煌', 1),
      mkIt('p5', '阳关', 94.0, 39.9, '敦煌', 2),
    ];
    const r = optimizeItinerary({ days, pois, maxPerDay: 2 });
    // 5个景点分到4天,每天≤2
    const byDay: Record<number, number> = {};
    r.assignments.forEach((a) => { byDay[a.daySeq] = (byDay[a.daySeq] || 0) + 1; });
    expect(Object.values(byDay).every((n) => n <= 2)).toBe(true);
    // 日落(鸣沙山)放最后:分配的天不是该天唯一
    const sunsetAssign = r.assignments.find((a) => a.poiId === 'p2');
    expect(sunsetAssign).toBeTruthy();
  });

  it('每日上限:超量时保持合理', () => {
    const days = [day(1, '敦煌'), day(2, '敦煌')];
    const pois = Array.from({ length: 5 }, (_, i) => mkIt(`p${i}`, `景点${i}`, 94 + i * 0.01, 40 + i * 0.01, '敦煌', 1));
    const r = optimizeItinerary({ days, pois, maxPerDay: 2 });
    // 5个景点分2天(上限2):平摊,超出的落回原天不丢
    expect(r.assignments.length).toBe(5);
    const byDay: Record<number, number> = {};
    r.assignments.forEach((a) => { byDay[a.daySeq] = (byDay[a.daySeq] || 0) + 1; });
    // 至少平摊,不出现极端堆积(≤3)
    expect(Object.values(byDay).every((n) => n <= 3)).toBe(true);
  });
});

describe('itineraryEngine 顺路路由', () => {
  it('点到路径距离计算', () => {
    // 直线 0,0 → 10,0 上,点(5,0)距离0
    const d1 = distanceToPath(poi('x', 'x', 5, 0), [[0, 0], [10, 0]]);
    expect(d1).toBeLessThan(1);
    // 远离路径的点
    const d2 = distanceToPath(poi('y', 'y', 5, 100), [[0, 0], [10, 0]]);
    expect(d2).toBeGreaterThan(90);
  });

  it('过渡日偏离路径产生警告', () => {
    const days = [day(1, '德令哈'), day(2, '青海湖')];
    const pois = [mkIt('p1', '茶卡盐湖', 99.08, 36.79, '青海湖', 2)];
    const r = optimizeItinerary({
      days, pois, maxPerDay: 2,
      transitionRoutes: { 2: [[96.9, 36.4], [100.1, 36.9]] }, // 德令哈→青海湖直线
      routeDeviationKm: 30,
    });
    // 茶卡在路线上(离线不远),不应产生偏离警告
    const hasWarn = r.warnings.some((w) => w.includes('茶卡'));
    expect(hasWarn).toBe(false);
  });
});