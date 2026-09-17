/**
 * 跨天衔接段的里程计算(详情页/概览页/分享页共用口径)。
 *
 * 「跨天衔接段」= 当天首个节点 ← 前一天最后一个节点,即「今天从上一站开过来」那段。
 * 三个页面展示的都是「当天全部驾车里程」= 天内各段 + 跨天衔接段,
 * 若漏掉衔接段,顶部数字会小于下方明细相加,用户会以为算错。
 */
import { computeSegment, type DriveFetcher, type SegPoint } from './segments';
import type { ItineraryDay, ItineraryItem, Poi } from '../types';

/** 参与路段计算的节点类型(与详情页一致:缓冲/大交通节点不参与) */
export const ROUTE_NODE_TYPES = new Set(['poi', 'hotel']);

/**
 * 按日期顺序取每天「带坐标的路段节点」。
 * @param days      旅程的全部天(内部会按 daySeq 排序)
 * @param itemsByDay dayId → 该天 items
 * @param pois      全部 poi(按 id 匹配)
 * @returns 与 days 排序后一一对应的逐日节点数组
 */
export function routeNodesByDay(
  days: ItineraryDay[],
  itemsByDay: Record<string, ItineraryItem[]>,
  pois: Poi[],
): SegPoint[][] {
  const poiById = new Map(pois.map((p) => [p.id, p]));
  return [...days]
    .sort((a, b) => a.daySeq - b.daySeq)
    .map((day) => (itemsByDay[day.id] || [])
      .slice()
      .sort((a, b) => a.orderSeq - b.orderSeq)
      .flatMap((it): SegPoint[] => {
        if (!it.poiId || !ROUTE_NODE_TYPES.has(it.itemType)) return [];
        const p = poiById.get(it.poiId);
        if (!p || p.lng === 0 || p.lat === 0) return [];
        return [{
          id: it.id, name: p.name, lng: p.lng, lat: p.lat,
          transportMode: it.transportMode, transportModeSet: it.transportModeSet,
        }];
      }));
}

/** 逐日跨天衔接段的驾车里程(km)。非驾车 / 取不到坐标 → null */
export interface CrossDayDrive {
  km: number;
  /** 是否走了真实路线数据;false = 直线近似(展示时应带「约」/「≈」) */
  real: boolean;
}

/**
 * 逐日算「跨天衔接段」的驾车里程。非驾车 / 取不到坐标 → null。
 * @returns 与 days 排序后一一对应的数组
 */
export async function computeCrossDayDrive(
  days: ItineraryDay[],
  itemsByDay: Record<string, ItineraryItem[]>,
  pois: Poi[],
  drive: DriveFetcher | null,
): Promise<Array<CrossDayDrive | null>> {
  const nodes = routeNodesByDay(days, itemsByDay, pois);
  return Promise.all(nodes.map(async (pts, i) => {
    const prev = nodes[i - 1];
    const from = prev && prev[prev.length - 1];
    const to = pts[0];
    if (!from || !to) return null;
    const seg = await computeSegment(from, to, drive).catch(() => null);
    return seg && seg.mode === 'drive' ? { km: seg.distanceKm, real: seg.real } : null;
  }));
}
