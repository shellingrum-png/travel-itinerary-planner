/**
 * 分享页 / 生成分享 共用的路段构建逻辑(纯逻辑,依赖高德 JS API 与本地缓存)。
 *
 * 为什么要抽出来:分享页要「和详情页一样」的里程与机场段,而生成分享时又需要
 * 用同一套逻辑把主账号的路线缓存**补齐**后再下发(否则个别段首次加载超时没缓存,
 * 家人端会退回直线近似显示 ≈)。
 */
import { getDuration, resolveTransportHubCoord } from '../services/amap';
import { findDepartTransport, findReturnTransport } from '../services/itineraryEngine';
import { computeAllSegments, type SegPoint, type SegmentInfo } from './segments';
import { ROUTE_NODE_TYPES } from './crossDay';
import type { TripSnapshot } from '../services/sync';

/** 机场虚拟节点 id(机场来自大交通记录,不是普通 item)—— 与详情页一致 */
export const AIRPORT_ARR_ID = '__airport_arrival__';
export const AIRPORT_DEP_ID = '__airport_departure__';

export interface Airport { lng: number; lat: number; name: string }
export interface AirportPair { arr?: Airport; dep?: Airport }
export interface SegData {
  pointsByDay: Map<string, SegPoint[]>;
  intra: Map<string, (SegmentInfo | null)[]>;
  cross: Map<string, SegmentInfo | null>;
}

/** 解析首日去程 / 末日返程机场坐标(高德 JS API 地理编码,免登录) */
export async function resolveAirports(snap: TripSnapshot): Promise<AirportPair> {
  const sorted = [...snap.days].sort((a, b) => a.daySeq - b.daySeq);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const arrT = first ? findDepartTransport(snap.transports, first.date) : null;
  const depT = last ? findReturnTransport(snap.transports, last.date) : null;
  const [arrC, depC] = await Promise.all([
    arrT ? resolveTransportHubCoord(arrT.toPlace ?? '', arrT.mode) : null,
    depT ? resolveTransportHubCoord(depT.fromPlace ?? '', depT.mode) : null,
  ]);
  return {
    arr: arrC ? { lng: arrC[0], lat: arrC[1], name: arrT!.toPlace || '' } : undefined,
    dep: depC ? { lng: depC[0], lat: depC[1], name: depT!.fromPlace || '' } : undefined,
  };
}

/**
 * 参与路段计算的节点类型(与详情页一致) —— 见 utils/crossDay 的说明。
 * 漏掉 hotel 会让「末站 → 当晚酒店」整段丢失,当天里程偏小。
 */
/** 逐日点序列(景点/酒店按 orderSeq + 首/末日的机场虚拟节点) */
export function buildDayPoints(snap: TripSnapshot, ap: AirportPair): Array<{ dayId: string; points: SegPoint[] }> {
  const poiById = new Map(snap.pois.map((p) => [p.id, p]));
  const sorted = [...snap.days].sort((a, b) => a.daySeq - b.daySeq);
  return sorted.map((d, di) => {
    const pts: SegPoint[] = snap.items
      .filter((it) => it.dayId === d.id && ROUTE_NODE_TYPES.has(it.itemType) && it.poiId)
      .sort((a, b) => a.orderSeq - b.orderSeq)
      .map((it) => {
        const p = poiById.get(it.poiId!);
        return p
          ? ({ id: it.id, name: p.name, lng: p.lng, lat: p.lat, transportMode: it.transportMode, transportModeSet: it.transportModeSet } as SegPoint)
          : null;
      })
      .filter((p): p is SegPoint => !!p && p.lng !== 0 && p.lat !== 0);
    // 机场并入:首日到达机场作起点,末日返程机场作终点(机场接送一律按驾车,不做距离改判)
    if (di === 0 && ap.arr) {
      pts.unshift({ id: AIRPORT_ARR_ID, name: ap.arr.name, lng: ap.arr.lng, lat: ap.arr.lat, transportMode: 'drive', transportModeSet: true });
    }
    if (di === sorted.length - 1 && ap.dep) {
      pts.push({ id: AIRPORT_DEP_ID, name: ap.dep.name, lng: ap.dep.lng, lat: ap.dep.lat, transportMode: 'drive', transportModeSet: true });
    }
    return { dayId: d.id, points: pts };
  });
}

/**
 * 构建全部路段(天内 + 跨天)。getDuration 会命中本地 route_cache;
 * 未命中则调高德并写缓存 —— 生成分享时跑一次即可把缓存补齐。
 */
export async function buildSegments(snap: TripSnapshot, ap: AirportPair, concurrency = 2): Promise<SegData> {
  const days = buildDayPoints(snap, ap);
  const pointsByDay = new Map(days.map((d) => [d.dayId, d.points]));
  const { intraDay, crossDay } = await computeAllSegments(days, getDuration, concurrency);
  return { pointsByDay, intra: intraDay, cross: crossDay };
}
