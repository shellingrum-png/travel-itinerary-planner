/**
 * V6.3 行程优化引擎(规则引擎,硬约束)
 *
 * 混合架构的"规则引擎"部分:锚点硬约束 + 城市绑定 + 连住负载均衡 + 过渡日顺路路由。
 * LLM 只做软文案(第5步,本次未实现)。
 *
 * 纯函数,可单测,不依赖高德。
 */
import { haversineKm } from '../utils/tsp';
import type { Poi } from '../types';

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
  const deviation = input.routeDeviationKm ?? DEFAULT_DEVIATION;
  const days = [...input.days].sort((a, b) => a.daySeq - b.daySeq);
  const result: ItineraryResult = { assignments: [], unassigned: [], warnings: [] };

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
    // 候选天 = 距离 ≤ MAX_CROSS_KM 的天(避免跨城乱搬)
    const feasible = days
      .map((d) => ({ d, dist: distToDay(p.poi, d), usage: usage.get(d.daySeq) ?? 0 }))
      .filter((r) => r.dist <= MAX_CROSS_KM);

    // 平摊优先:在候选天中选「用量最少」的(距离相近时均衡分布);距离作为次级排序
    let best: DayAnchor | null = null;
    let bestUsage = Infinity;
    for (const r of feasible.sort((a, b) => a.usage - b.usage || a.dist - b.dist)) {
      if (r.usage >= maxPerDay) continue; // 已满跳过
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