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
 * 1. 城市绑定:景点归属到「同城的天」
 * 2. 硬约束:景点只能进城市匹配的天(跨城禁止)
 * 3. 连住平摊:同城连续天均分,每日≤maxPerDay,日落放最后
 * 4. 过渡日顺路:有 transitionRoutes 时校验景点偏离路径
 */
export function optimizeItinerary(input: ItineraryInput): ItineraryResult {
  const maxPerDay = input.maxPerDay ?? DEFAULT_MAX;
  const deviation = input.routeDeviationKm ?? DEFAULT_DEVIATION;
  const days = [...input.days].sort((a, b) => a.daySeq - b.daySeq);
  const result: ItineraryResult = { assignments: [], unassigned: [], warnings: [] };

  // 1. 每个景点归属城市(优先 poi.city,无则用原天锚点城市)
  const cityOfDay = new Map<number, string>();
  for (const d of days) {
    cityOfDay.set(d.daySeq, d.city || d.poi.city || '');
  }
  const poiCity = (p: ItineraryPoi): string => {
    if (p.city) return p.city;
    return cityOfDay.get(p.srcDaySeq) || '';
  };

  // 2. 收集每个景点的候选天(城市匹配的天)
  const candidatesFor = (p: ItineraryPoi): DayAnchor[] => {
    const c = poiCity(p);
    return days.filter((d) => {
      const dc = cityOfDay.get(d.daySeq) || '';
      // 城市匹配:都有城市则必须同城;无城市则允许任意(老数据兜底)
      if (c && dc && c !== dc) return false;
      return true;
    });
  };

  // 3. 平摊分配
  const usage = new Map<number, number>();
  days.forEach((d) => usage.set(d.daySeq, 0));

  // 日落优先放最后 → 先处理非日落,后处理日落
  const pois = [...input.pois].sort((a, b) => (a.sunset === b.sunset ? 0 : a.sunset ? 1 : -1));

  for (const p of pois) {
    const cands = candidatesFor(p);
    if (cands.length === 0) {
      result.unassigned.push({ poiId: p.id, name: p.poi.name, reason: '无匹配城市的天' });
      continue;
    }
    // 选择"未满 + 用量最少"的天
    let best: DayAnchor | null = null;
    let bestUsage = Infinity;
    for (const d of cands) {
      const u = usage.get(d.daySeq) ?? 0;
      if (u < maxPerDay && u < bestUsage) {
        bestUsage = u;
        best = d;
      }
    }
    if (!best) {
      // 所有候选天都满了 → 放回原天(保底,不丢)
      const fallback = days.find((d) => d.daySeq === p.srcDaySeq);
      if (fallback) {
        usage.set(fallback.daySeq, (usage.get(fallback.daySeq) ?? 0) + 1);
        result.assignments.push({ poiId: p.id, daySeq: fallback.daySeq });
        result.warnings.push(`「${p.poi.name}」所在城市已满,留在原天(Day ${fallback.daySeq})。`);
      } else {
        result.unassigned.push({ poiId: p.id, name: p.poi.name, reason: '无可用天' });
      }
      continue;
    }
    usage.set(best.daySeq, (usage.get(best.daySeq) ?? 0) + 1);
    result.assignments.push({ poiId: p.id, daySeq: best.daySeq });
  }

  // 4. 过渡日顺路校验(可选)
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