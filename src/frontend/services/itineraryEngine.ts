/**
 * V6.3 行程优化引擎(规则引擎,硬约束)
 *
 * 混合架构的"规则引擎"部分:锚点硬约束 + 城市绑定 + 连住负载均衡 + 过渡日顺路路由。
 * LLM 只做软文案(第5步,本次未实现)。
 *
 * 纯函数,可单测,不依赖高德。
 */
import { haversineKm } from '../utils/tsp';
import { toMinutes } from '../utils/time';
import type { Poi, Transport } from '../types';

// ── 类型 ──
/** 每天锚点骨架 */
export interface DayAnchor {
  daySeq: number;
  dayId: string;
  poi: Poi;        // 锚点(酒店或首个景点)
  fromHotel: boolean;
  city?: string;   // 锚点所属城市
}

/** 待分配景点 */
export interface ItineraryPoi {
  id: string;
  poi: Poi;
  city?: string;     // 逆地理绑定的城市
  srcDaySeq: number; // 原所在天(城市推断兜底)
  sunset?: boolean;  // 日落/夜景优先放最后
}

/** 输入 */
export interface ItineraryInput {
  days: DayAnchor[];
  pois: ItineraryPoi[];
  maxPerDay?: number;          // 每日景点上限(松弛=2)
  dayCapacity?: Record<number, number>; // V6.3.2 按天容量:daySeq → 该天可放景点数(优先于 maxPerDay)
  forbiddenDays?: Record<string, number[]>; // V6.3.4 poiId → 禁止分配的天(距离感知可达性)
  transitionRoutes?: Record<number, [number, number][]>; // daySeq → 行车路径点
  routeDeviationKm?: number;   // 顺路偏离阈值(默认30)
}

/** 输出 */
export interface ItineraryResult {
  assignments: Array<{ poiId: string; daySeq: number }>;
  unassigned: Array<{ poiId: string; name: string; reason: string }>;
  warnings: string[];
}

const DEFAULT_MAX = 2;
const DEFAULT_DEVIATION = 30;

/**
 * 主引擎
 * 核心:按「地理距离」归属(城市字符串匹配不可靠,逆地理的"酒泉市"会覆盖几百公里外的茫崖)
 * 1. 每个景点归到「离它最近的天锚点」,且距离在合理阈值内(否则保持原天)
 * 2. 同城连住多天时,平摊(每日≤maxPerDay),日落放最后
 * 3. 过渡日顺路:有 transitionRoutes 时校验景点偏离路径
 */
export function optimizeItinerary(input: ItineraryInput): ItineraryResult {
  const maxPerDay = input.maxPerDay ?? DEFAULT_MAX;
  const dayCapacity = input.dayCapacity ?? {}; // 按天容量(优先于 maxPerDay)
  const deviation = input.routeDeviationKm ?? DEFAULT_DEVIATION;
  const days = [...input.days].sort((a, b) => a.daySeq - b.daySeq);
  const result: ItineraryResult = { assignments: [], unassigned: [], warnings: [] };

  // 某天容量:优先按天容量,否则全局 maxPerDay
  const capacityOf = (daySeq: number): number =>
    dayCapacity[daySeq] ?? maxPerDay;

  // 地理距离:点到天锚点距离
  const distToDay = (poi: Poi, d: DayAnchor): number =>
    haversineKm(poi.lng, poi.lat, d.poi.lng, d.poi.lat);

  // 归属:优先「离景点最近的天锚点」;若该天满,找次近的;距离阈值内才允许跨天
  const MAX_CROSS_KM = 120; // 超过120km不跨天(防止黑独山从大柴旦跑到敦煌)
  const usage = new Map<number, number>();
  days.forEach((d) => usage.set(d.daySeq, 0));

  // 日落优先放最后 → 先处理非日落,后处理日落
  const pois = [...input.pois].sort((a, b) => (a.sunset === b.sunset ? 0 : a.sunset ? 1 : -1));

  for (const p of pois) {
    // 候选天 = 距离 ≤ MAX_CROSS_KM 且未被「禁配」(forbiddenDays)的天
    const feasible = days
      .map((d) => ({ d, dist: distToDay(p.poi, d), usage: usage.get(d.daySeq) ?? 0 }))
      .filter((r) => r.dist <= MAX_CROSS_KM)
      .filter((r) => !input.forbiddenDays?.[p.id]?.includes(r.d.daySeq));

    // 平摊优先:在候选天中选「用量最少」的(距离相近时均衡分布);距离作为次级排序
    let best: DayAnchor | null = null;
    let bestUsage = Infinity;
    for (const r of feasible.sort((a, b) => a.usage - b.usage || a.dist - b.dist)) {
      if (r.usage >= capacityOf(r.d.daySeq)) continue; // 该天容量已满跳过
      if (r.usage < bestUsage) {
        bestUsage = r.usage;
        best = r.d;
      }
    }

    if (!best) {
      // 无候选(都超120km 或 全满) → 保持原天(不丢、不乱搬)
      const fallback = days.find((d) => d.daySeq === p.srcDaySeq);
      if (fallback) {
        usage.set(fallback.daySeq, (usage.get(fallback.daySeq) ?? 0) + 1);
        result.assignments.push({ poiId: p.id, daySeq: fallback.daySeq });
        result.warnings.push(`「${p.poi.name}」近处已满或无匹配,留在原天(Day ${fallback.daySeq})。`);
      } else {
        result.unassigned.push({ poiId: p.id, name: p.poi.name, reason: '无可归天' });
      }
      continue;
    }
    usage.set(best.daySeq, (usage.get(best.daySeq) ?? 0) + 1);
    result.assignments.push({ poiId: p.id, daySeq: best.daySeq });
  }

  // 过渡日顺路校验(可选)
  if (input.transitionRoutes) {
    for (const a of result.assignments) {
      const route = input.transitionRoutes[a.daySeq];
      if (!route || route.length < 2) continue;
      const poi = input.pois.find((p) => p.id === a.poiId);
      if (!poi) continue;
      const dist = distanceToPath(poi.poi, route);
      if (dist > deviation) {
        result.warnings.push(`「${poi.poi.name}」距 Day${a.daySeq} 行车路线约 ${Math.round(dist)}km,建议调整。`);
      }
    }
  }

  return result;
}

/** 景点到折线路径的最近距离(km) */
export function distanceToPath(poi: Poi, path: [number, number][]): number {
  let min = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const d = pointToSegmentKm(poi.lng, poi.lat, path[i][0], path[i][1], path[i + 1][0], path[i + 1][1]);
    if (d < min) min = d;
  }
  return min === Infinity ? 0 : min;
}

/** 点到线段最短距离(km,平面近似) */
export function pointToSegmentKm(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return haversineKm(px, py, ax, ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return haversineKm(px, py, cx, cy);
}

/** 同城连续天分组(供平摊) */
export function groupConsecutiveDays(days: DayAnchor[]): DayAnchor[][] {
  const groups: DayAnchor[][] = [];
  let cur: DayAnchor[] = [];
  let curCity = '';
  for (const d of days) {
    const c = d.city || d.poi.city || '';
    if (!cur.length || c === curCity) {
      cur.push(d);
    } else {
      groups.push(cur);
      cur = [d];
    }
    curCity = c;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

// ── V6.3.3 动态容量:基于返程/去程大交通估算 ──

/** 按大交通 mode 预留的赶车/赶飞机 buffer(分钟) */
const MODE_BUFFER: Partial<Record<Transport['mode'], number>> = {
  flight: 120,
  train: 45,
  drive: 15,
  ferry: 30,
};

/** 从 "YYYY-MM-DDTHH:MM" 拆出 {date, hhmm};hhmm 非法则视为无效 */
function parseIso(iso: string): { date: string; hhmm: string } | null {
  const s = String(iso ?? '');
  const [d, t] = s.split('T');
  if (!d || !t || !/^\d{1,2}:\d{2}$/.test(t)) return null;
  return { date: d, hhmm: t };
}

/** 按「日期」匹配一条返程交通,取 departAt 最晚(同分偏好 round_trip);无匹配→null */
export function findReturnTransport(ts: Transport[], lastDate: string, preferRoundTrip = true): Transport | null {
  let best: Transport | null = null;
  let bestScore = -Infinity;
  for (const t of ts) {
    if (t.segType !== 'round_trip' && t.segType !== 'inter_city') continue;
    const p = parseIso(t.departAt);
    if (!p || p.date !== lastDate) continue;
    const isRound = t.segType === 'round_trip';
    const score = toMinutes(p.hhmm) * 2 + (isRound && preferRoundTrip ? 1 : 0);
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best;
}

/** 按「日期」匹配一条去程交通,取 arriveAt 最早(同分偏好 round_trip);无匹配→null */
export function findDepartTransport(ts: Transport[], firstDate: string, preferRoundTrip = true): Transport | null {
  let best: Transport | null = null;
  let bestScore = Infinity;
  for (const t of ts) {
    if (t.segType !== 'round_trip' && t.segType !== 'inter_city') continue;
    const p = parseIso(t.arriveAt);
    if (!p || p.date !== firstDate) continue;
    const isRound = t.segType === 'round_trip';
    const score = toMinutes(p.hhmm) * 2 - (isRound && preferRoundTrip ? 1 : 0);
    if (score < bestScore) { bestScore = score; best = t; }
  }
  return best;
}

/**
 * 计算出发/回程日的可用窗口(分钟)。
 * transport=null 或时间格式坏 → null(调用方回退普通天);可用 ≤ 0 → 纯赶路日。
 */
export function dayWindowMin(args: {
  segType: 'depart' | 'return';
  transport: Transport | null;
  dayStart: string;   // HH:MM
  dayEnd: string;     // HH:MM
  buffers?: Partial<Record<Transport['mode'], number>>;
}): number | null {
  const { segType, transport, dayStart, dayEnd } = args;
  if (!transport) return null;
  const buffers = { ...MODE_BUFFER, ...args.buffers };
  const buffer = buffers[transport.mode] ?? 45;
  const iso = segType === 'return' ? transport.departAt : transport.arriveAt;
  const p = parseIso(iso);
  if (!p) return null;
  const boundary = segType === 'return' ? toMinutes(p.hhmm) - buffer : toMinutes(dayEnd) - buffer;
  const start = segType === 'return' ? toMinutes(dayStart) : toMinutes(p.hhmm);
  return boundary - start;
}

/**
 * 按大交通(mode + 起抵时间)动态估算某天可排景点数。
 * transport=null → 返回 fallback(默认 2,即普通天)。
 */
export function estimateDayCapacity(args: {
  segType: 'depart' | 'return';
  transport: Transport | null;
  dayStart: string;   // HH:MM
  dayEnd: string;     // HH:MM
  avgPoiMin?: number; // 每景点耗时(游玩+通勤),默认 120
  clampMax?: number;  // 默认 4
  buffers?: Partial<Record<Transport['mode'], number>>;
}): number {
  const { segType, transport, dayStart, dayEnd } = args;
  const avgPoiMin = args.avgPoiMin ?? 120;
  const clampMax = args.clampMax ?? 4;
  const win = dayWindowMin({ segType, transport, dayStart, dayEnd, buffers: args.buffers });
  if (win === null) return 2; // 无大交通/格式坏 → 按普通天
  if (win <= 0) return 0;     // 纯赶路日
  return Math.min(clampMax, Math.floor(win / avgPoiMin));
}

/**
 * 按实际往返路径耗时的可达性估算可排景点数(距离感知,H→P→A)。
 * total(p) = pathMin + visitMin(pathMin=该景点起点→景点→终点的往返路径总时长)。
 * - reachableIds:单项 total ≤ window 的景点
 * - capacity:按 total 升序贪心累计(累计 ≤ window)能容纳的数量,clamp [0, clampMax]
 */
export function estimateReachablePois(args: {
  candidates: Array<{ id: string; visitMin: number; pathMin: number }>;
  windowMin: number;
  clampMax?: number;
}): { capacity: number; reachableIds: string[] } {
  const { candidates, windowMin } = args;
  const clampMax = args.clampMax ?? 4;
  if (windowMin <= 0) return { capacity: 0, reachableIds: [] };
  const total = (p: { id: string; visitMin: number; pathMin: number }) =>
    (p.pathMin || 0) + (p.visitMin || 0);
  const reachableIds = candidates
    .filter((p) => total(p) <= windowMin)
    .map((p) => p.id);
  let acc = 0;
  let capacity = 0;
  const sorted = [...candidates].sort((a, b) => total(a) - total(b));
  for (const p of sorted) {
    const t = total(p);
    if (acc + t > windowMin) break;
    acc += t;
    capacity++;
  }
  return { capacity: Math.min(clampMax, capacity), reachableIds };
}