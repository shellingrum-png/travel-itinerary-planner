import { describe, it, expect } from 'vitest';
import { optimizeItinerary, distanceToPath } from '../itineraryEngine';
import type { DayAnchor, ItineraryPoi } from '../itineraryEngine';
import type { Poi } from '../../types';

const poi = (id: string, name: string, lng: number, lat: number, city?: string): Poi => ({
  id, name, lng, lat, category: 'poi', city,
});

const day = (daySeq: number, city: string, lng: number, lat: number): DayAnchor => ({
  daySeq, dayId: `day-${daySeq}`, poi: poi(`a-${daySeq}`, `锚点${daySeq}`, lng, lat, city), fromHotel: true, city,
});

const mkIt = (id: string, name: string, lng: number, lat: number, city: string, srcDaySeq: number, sunset?: boolean): ItineraryPoi => ({
  id, poi: poi(id, name, lng, lat, city), city, srcDaySeq, sunset,
});

// 真实坐标(辅助判断距离)
const 张掖 = [100.45, 38.93];
const 敦煌 = [94.66, 40.14];
const 德令哈 = [97.37, 37.37];
const 青海湖 = [100.18, 36.89];

describe('itineraryEngine 距离归属', () => {
  it('景点归到最近的天锚点(张掖景点归张掖天,不跑敦煌)', () => {
    const days = [
      day(1, '张掖', 张掖[0], 张掖[1]),
      day(2, '敦煌', 敦煌[0], 敦煌[1]),
      day(3, '敦煌', 敦煌[0], 敦煌[1]),
    ];
    // 张掖大佛寺坐标在张掖,应归 Day1(最近)
    const pois = [mkIt('p1', '张掖大佛寺', 100.45, 38.93, '张掖', 1)];
    const r = optimizeItinerary({ days, pois, maxPerDay: 2 });
    const a = r.assignments.find((x) => x.poiId === 'p1');
    expect(a?.daySeq).toBe(1);
  });

  it('茫崖景点不跨到敦煌(距离>120km不跨)', () => {
    const days = [
      day(1, '大柴旦', 95.36, 37.85),
      day(2, '敦煌', 敦煌[0], 敦煌[1]),
    ];
    // 黑独山在茫崖(94.35,38.92),离大柴旦近,离敦煌远(>120km) → 应留原天D1
    const pois = [mkIt('p1', '黑独山', 94.35, 38.92, '酒泉', 1)];
    const r = optimizeItinerary({ days, pois, maxPerDay: 2 });
    const a = r.assignments.find((x) => x.poiId === 'p1');
    expect(a?.daySeq).toBe(1); // 留在原天,不被搬到敦煌
  });

  it('同城连住平摊,每日≤2', () => {
    const days = [
      day(1, '敦煌', 敦煌[0], 敦煌[1]),
      day(2, '敦煌', 敦煌[0], 敦煌[1]),
      day(3, '敦煌', 敦煌[0], 敦煌[1]),
      day(4, '敦煌', 敦煌[0], 敦煌[1]),
    ];
    const pois = [
      mkIt('p1', '莫高窟', 94.8, 40.04, '敦煌', 2),
      mkIt('p2', '鸣沙山', 94.67, 40.08, '敦煌', 3, true),
      mkIt('p3', '玉门关', 93.8, 40.35, '敦煌', 4),
      mkIt('p4', '雅丹', 93.1, 40.5, '敦煌', 1),
      mkIt('p5', '阳关', 94.0, 39.9, '敦煌', 2),
    ];
    const r = optimizeItinerary({ days, pois, maxPerDay: 2 });
    const byDay: Record<number, number> = {};
    r.assignments.forEach((a) => { byDay[a.daySeq] = (byDay[a.daySeq] || 0) + 1; });
    // 5个景点分4天,每天≤2(允许平摊)
    expect(Object.values(byDay).every((n) => n <= 2)).toBe(true);
    expect(r.assignments.length).toBe(5);
  });

  it('按天容量:容量不足时优先保数据不丢,并给出警告', () => {
    const days = [
      day(1, '兰州', 103.8, 36.06),   // 出发日:容量1(赶飞机)
      day(2, '张掖', 张掖[0], 张掖[1]), // 容量2
      day(3, '青海湖', 青海湖[0], 青海湖[1]), // 回程日:容量1
    ];
    // 2个兰州景点离D1最近,但D1容量仅1 → 第2个应保留在D1(不丢)但产生警告
    const pois = [
      mkIt('p1', '中山桥', 103.8, 36.06, '兰州', 1),
      mkIt('p2', '兰州牛肉面', 103.82, 36.05, '兰州', 1),
      mkIt('p3', '张掖丹霞', 张掖[0], 张掖[1], '张掖', 2),
      mkIt('p4', '茶卡', 青海湖[0], 青海湖[1], '青海湖', 3),
    ];
    const r = optimizeItinerary({
      days, pois, maxPerDay: 2,
      dayCapacity: { 1: 1, 2: 2, 3: 1 },
    });
    // 所有景点都不丢(保数据优先)
    expect(r.assignments.length).toBe(4);
    // 容量不足时有警告(提示用户调整)
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe('itineraryEngine 顺路路由', () => {
  it('点到路径距离计算', () => {
    const d1 = distanceToPath(poi('x', 'x', 5, 0), [[0, 0], [10, 0]]);
    expect(d1).toBeLessThan(1);
    const d2 = distanceToPath(poi('y', 'y', 5, 100), [[0, 0], [10, 0]]);
    expect(d2).toBeGreaterThan(90);
  });

  it('过渡日偏离路径产生警告', () => {
    const days = [
      day(1, '德令哈', 德令哈[0], 德令哈[1]),
      day(2, '青海湖', 青海湖[0], 青海湖[1]),
    ];
    // 茶卡盐湖在德令哈→青海湖路线附近(距德令哈~85km,在120km阈值内)
    const pois = [mkIt('p1', '茶卡盐湖', 99.08, 36.79, '海西', 2)];
    const r = optimizeItinerary({
      days, pois, maxPerDay: 2,
      transitionRoutes: { 2: [[德令哈[0], 德令哈[1]], [青海湖[0], 青海湖[1]]] },
      routeDeviationKm: 30,
    });
    // 茶卡应被分配(不丢),且它在路线上不应产生"偏离"警告
    expect(r.assignments.find((a) => a.poiId === 'p1')).toBeTruthy();
    const hasWarn = r.warnings.some((w) => w.includes('茶卡') && w.includes('偏离'));
    expect(hasWarn).toBe(false);
  });
});