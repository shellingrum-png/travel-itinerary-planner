import { describe, it, expect } from 'vitest';
import { optimizeItinerary, distanceToPath, estimateDayCapacity, estimateReachablePois, dayWindowMin, findReturnTransport, findDepartTransport } from '../itineraryEngine';
import type { DayAnchor, ItineraryPoi } from '../itineraryEngine';
import type { Poi, Transport } from '../../types';

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

// ── V6.3.3 动态容量 ──
const rt = (mode: Transport['mode'], depart: string, arrive: string, segType: Transport['segType'] = 'round_trip'): Transport => ({
  id: 't1', tripId: 'trip', segType, mode, fromPlace: 'A', toPlace: 'B', departAt: depart, arriveAt: arrive,
});

describe('estimateDayCapacity', () => {
  it('回程火车19:00,dayStart 09:00,avg 120 → 4', () => {
    const cap = estimateDayCapacity({ segType: 'return', transport: rt('train', '2026-09-30T19:00', '2026-09-30T22:00'), dayStart: '09:00', dayEnd: '20:00', avgPoiMin: 120 });
    expect(cap).toBe(4); // (19:00-45min - 09:00)=555 → 4
  });

  it('回程飞机12:00(early)→ 0', () => {
    const cap = estimateDayCapacity({ segType: 'return', transport: rt('flight', '2026-09-30T12:00', '2026-09-30T15:00'), dayStart: '09:00', dayEnd: '20:00', avgPoiMin: 120 });
    expect(cap).toBe(0); // (12:00-120 - 09:00)=60 → 0
  });

  it('回程火车19:00,dayStart 08:00 → 4', () => {
    const cap = estimateDayCapacity({ segType: 'return', transport: rt('train', '2026-09-30T19:00', '2026-09-30T22:00'), dayStart: '08:00', dayEnd: '20:00', avgPoiMin: 120 });
    expect(cap).toBe(4);
  });

  it('去程火车 arrive 10:00,dayEnd 20:00 → 4', () => {
    const cap = estimateDayCapacity({ segType: 'depart', transport: rt('train', '2026-09-26T06:00', '2026-09-26T10:00'), dayStart: '09:00', dayEnd: '20:00', avgPoiMin: 120 });
    expect(cap).toBe(4); // (20:00-45 - 10:00)=555 → 4
  });

  it('去程飞机 arrive 22:00 → 0', () => {
    const cap = estimateDayCapacity({ segType: 'depart', transport: rt('flight', '2026-09-26T18:00', '2026-09-26T22:00'), dayStart: '09:00', dayEnd: '20:00', avgPoiMin: 120 });
    expect(cap).toBe(0); // (20:00-120 - 22:00)<0 → 0
  });

  it('transport=null → 普通天容量2', () => {
    expect(estimateDayCapacity({ segType: 'return', transport: null, dayStart: '09:00', dayEnd: '20:00', avgPoiMin: 120 })).toBe(2);
  });

  it('dayStart 06:00,火车 depart 22:00 → clamp 4', () => {
    const cap = estimateDayCapacity({ segType: 'return', transport: rt('train', '2026-09-30T22:00', '2026-09-30T23:00'), dayStart: '06:00', dayEnd: '22:00', avgPoiMin: 120 });
    expect(cap).toBe(4); // (22:00-45 - 06:00)=915 → 7 → clamp 4
  });

  it('departAt 格式坏 → 按普通天2', () => {
    const cap = estimateDayCapacity({ segType: 'return', transport: rt('train', '', ''), dayStart: '09:00', dayEnd: '20:00', avgPoiMin: 120 });
    expect(cap).toBe(2);
  });
});

describe('findReturnTransport / findDepartTransport', () => {
  const lastDate = '2026-09-30';
  const firstDate = '2026-09-26';

  it('findReturnTransport 取 departAt 最晚(含 inter_city);日期不匹配被过滤', () => {
    const ts = [
      rt('train', '2026-09-30T15:00', '2026-09-30T18:00'),
      rt('train', '2026-09-30T19:00', '2026-09-30T22:00'),
      rt('flight', '2026-09-29T10:00', '2026-09-29T12:00'), // 日期不匹配
      { ...rt('train', '2026-09-30T20:00', '2026-09-30T23:00'), segType: 'inter_city' as const, id: 'x' }, // inter_city 命中
    ];
    const r = findReturnTransport(ts, lastDate);
    expect(r?.departAt).toBe('2026-09-30T20:00'); // inter_city 20:00 最晚命中
  });

  it('findReturnTransport 同分偏好 round_trip', () => {
    const ts = [
      rt('train', '2026-09-30T20:00', '2026-09-30T23:00'), // round_trip 20:00
      { ...rt('train', '2026-09-30T20:00', '2026-09-30T23:00'), segType: 'inter_city' as const, id: 'x' }, // inter_city 20:00
    ];
    expect(findReturnTransport(ts, lastDate)?.segType).toBe('round_trip');
  });

  it('findReturnTransport 仅 inter_city 也命中', () => {
    const ts = [{ ...rt('flight', '2026-09-30T16:00', '2026-09-30T19:00'), segType: 'inter_city' as const, id: 'x' }];
    expect(findReturnTransport(ts, lastDate)?.departAt).toBe('2026-09-30T16:00');
  });

  it('findDepartTransport 取 arriveAt 最早(含 inter_city);日期不匹配被过滤', () => {
    const ts = [
      rt('train', '2026-09-26T06:00', '2026-09-26T10:00'),
      rt('train', '2026-09-26T05:00', '2026-09-26T08:00'),
      rt('flight', '2026-09-25T10:00', '2026-09-25T12:00'), // 日期不匹配
    ];
    const r = findDepartTransport(ts, firstDate);
    expect(r?.arriveAt).toBe('2026-09-26T08:00');
  });

  it('无匹配 → null', () => {
    expect(findReturnTransport([], lastDate)).toBeNull();
    expect(findDepartTransport([rt('train', '2026-09-30T06:00', '2026-09-30T10:00')], firstDate)).toBeNull();
  });
});

describe('estimateReachablePois(pathMin)', () => {
  it('贪心累计:w=300,total 105/150/225 → reachable 3、capacity 2', () => {
    const r = estimateReachablePois({
      candidates: [
        { id: 'a', visitMin: 60, pathMin: 45 },  // total 105
        { id: 'b', visitMin: 90, pathMin: 60 },  // total 150
        { id: 'c', visitMin: 120, pathMin: 105 }, // total 225
      ],
      windowMin: 300,
    });
    expect(r.reachableIds).toEqual(['a', 'b', 'c']); // 105/150/225 ≤ 300
    expect(r.capacity).toBe(2); // 105+150=255≤300, +225=480>300
  });

  it('w=400 → capacity 3(105+150+225=480>400→2? 实际105+150=255, +225=480>400 → 2)', () => {
    const r = estimateReachablePois({
      candidates: [
        { id: 'a', visitMin: 60, pathMin: 45 },  // 105
        { id: 'b', visitMin: 90, pathMin: 60 },  // 150
        { id: 'c', visitMin: 120, pathMin: 105 }, // 225
      ],
      windowMin: 400,
    });
    expect(r.capacity).toBe(2); // 105+150=255≤400, +225=480>400
  });

  it('clampMax 生效', () => {
    const r = estimateReachablePois({
      candidates: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, visitMin: 10, pathMin: 10 })), // 每个 total 20
      windowMin: 9999,
      clampMax: 2,
    });
    expect(r.capacity).toBe(2);
  });

  it('空输入 → {0, []}', () => {
    expect(estimateReachablePois({ candidates: [], windowMin: 300 })).toEqual({ capacity: 0, reachableIds: [] });
  });

  it('全不可达 → capacity 0,reachableIds 空', () => {
    const r = estimateReachablePois({
      candidates: [
        { id: 'a', visitMin: 60, pathMin: 0 },
        { id: 'b', visitMin: 100, pathMin: 0 },
      ],
      windowMin: 10,
    });
    expect(r).toEqual({ capacity: 0, reachableIds: [] });
  });

  it('windowMin ≤ 0 → {0, []}', () => {
    expect(estimateReachablePois({ candidates: [{ id: 'a', visitMin: 60, pathMin: 10 }], windowMin: 0 })).toEqual({ capacity: 0, reachableIds: [] });
  });
});

describe('dayWindowMin', () => {
  const dayStart = '09:00', dayEnd = '20:00';
  it('return 火车 19:00 → 555', () => {
    expect(dayWindowMin({ segType: 'return', transport: rt('train', '2026-09-30T19:00', '2026-09-30T22:00'), dayStart, dayEnd })).toBe(555);
  });
  it('return 飞行 12:00(buffer120) → 60-? 即 (12:00-120 - 09:00) = 60', () => {
    expect(dayWindowMin({ segType: 'return', transport: rt('flight', '2026-09-30T12:00', '2026-09-30T15:00'), dayStart, dayEnd })).toBe(60);
  });
  it('depart 火车 arrive 10:00 → (20:00-45 - 10:00)=555', () => {
    expect(dayWindowMin({ segType: 'depart', transport: rt('train', '2026-09-26T06:00', '2026-09-26T10:00'), dayStart, dayEnd })).toBe(555);
  });
  it('transport=null → null', () => {
    expect(dayWindowMin({ segType: 'return', transport: null, dayStart, dayEnd })).toBeNull();
  });
  it('格式坏 → null', () => {
    expect(dayWindowMin({ segType: 'return', transport: rt('train', '', ''), dayStart, dayEnd })).toBeNull();
  });
});

describe('引擎 forbiddenDays', () => {
  const 张掖A = [100.45, 38.93];
  const 张掖B = [100.60, 38.95]; // 距 A 约 15km
  const 张掖 = [100.50, 38.94]; // 介于 A/B 之间,更近 A
  const 敦煌 = [94.66, 40.14];

  it('禁最近的天后,改分到另一近天', () => {
    const days = [
      day(1, '张掖A', 张掖A[0], 张掖A[1]),
      day(2, '张掖B', 张掖B[0], 张掖B[1]),
    ];
    // p1 距 D1(~8km)最远(D2 ~15km),原本最近是 D1;禁配 D1 → 应改分到 D2
    const pois = [mkIt('p1', '七彩丹霞', 张掖[0], 张掖[1], '张掖', 1)];
    const r = optimizeItinerary({ days, pois, maxPerDay: 2, forbiddenDays: { p1: [1] } });
    expect(r.assignments.find((a) => a.poiId === 'p1')?.daySeq).toBe(2);
  });

  it('全禁时留原天+警告(不丢数据)', () => {
    const days = [
      day(1, '张掖A', 张掖A[0], 张掖A[1]),
      day(2, '张掖B', 张掖B[0], 张掖B[1]),
    ];
    const pois = [mkIt('p1', '七彩丹霞', 张掖[0], 张掖[1], '张掖', 1)];
    const r = optimizeItinerary({ days, pois, maxPerDay: 2, forbiddenDays: { p1: [1, 2] } });
    const a = r.assignments.find((x) => x.poiId === 'p1');
    expect(a?.daySeq).toBe(1); // 留原天
    expect(r.warnings.some((w) => w.includes('七彩丹霞'))).toBe(true);
  });

  it('与 dayCapacity 叠加:全禁时仍留原天(不丢数据)', () => {
    const days = [
      day(1, '张掖A', 张掖A[0], 张掖A[1]),
      day(2, '张掖B', 张掖B[0], 张掖B[1]),
    ];
    const pois = [mkIt('p1', '七彩丹霞', 张掖[0], 张掖[1], '张掖', 1)];
    const r = optimizeItinerary({ days, pois, maxPerDay: 2, dayCapacity: { 1: 1, 2: 1 }, forbiddenDays: { p1: [1, 2] } });
    expect(r.assignments.find((x) => x.poiId === 'p1')?.daySeq).toBe(1);
  });
});