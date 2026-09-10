/**
 * 相邻节点之间的「路段」计算(V11)
 *
 * 用途:在行程卡片上展示「从上一站到本站多少公里、要多久」。
 *
 * 交通方式判定:
 *  - item.transportMode 由用户/导入指定,语义是「从上一节点到本节点怎么走」;
 *  - 但它对所有节点都存了默认值,无法区分「用户明确选了步行」与「没管过」,
 *    因此再用距离阈值兜底:很近的两点即便默认值是 drive,也按步行展示
 *    (同城几百米打车/开车都不合理,这个假设与顺路优化一致)。
 *  - `transportMode` 为 drive 且距离超过阈值时,才去取真实驾车路线。
 */
import { haversineKm } from './tsp';
import type { TransportMode } from '../types';

/** 短于此距离的相邻点视为步行(不调驾车接口) */
export const WALK_THRESHOLD_KM = 3;

/** 驾车数据查询接口(便于测试注入;实际由 services/amap 的 getDuration 提供) */
export type DriveFetcher = (
  from: [number, number],
  to: [number, number],
  mode: TransportMode,
) => Promise<{ durationMin: number; distanceM: number }>;

/** 展示用的简易点 */
export interface SegPoint {
  id: string;
  name: string;
  lng: number;
  lat: number;
  /** 到达该点的方式(来自 item.transportMode) */
  transportMode: TransportMode;
}

/** 一段路的展示数据 */
export interface SegmentInfo {
  /** 起点(上一节点)id / 终点(本节点)id */
  fromId: string;
  toId: string;
  /** 实际采用的交通方式(可能被距离阈值修正) */
  mode: TransportMode;
  /** 是否走了真实路线数据(getDuration),false = 直线估算 */
  real: boolean;
  distanceKm: number;
  durationMin: number;
}

/** 交通方式的展示元信息 */
export const MODE_META: Record<TransportMode, { icon: string; label: string; verb: string }> = {
  walk: { icon: '🚶', label: '步行', verb: '步行' },
  drive: { icon: '🚗', label: '驾车', verb: '驾车' },
  transit: { icon: '🚌', label: '公交', verb: '公交' },
  train: { icon: '🚄', label: '火车', verb: '乘火车' },
  flight: { icon: '✈️', label: '飞机', verb: '乘飞机' },
};

/**
 * 距离合理性阈值(与既有 smartTransportSpeed 保持一致)
 * 背景:transportMode 字段在历史/模板数据里普遍存的是 'walk'(等于"未指定"),
 * 因此不能无条件尊重它,必须按距离做合理性修正,否则会出现
 * 「步行 440km · 88 小时」这种荒谬结果。
 */
export const WALK_MAX_KM = 15;      // 超过即视为未指定 → 驾车
export const DRIVE_MAX_KM = 300;    // 自驾超过 → 火车
export const TRANSIT_MAX_KM = 50;   // 公交超过 → 火车

/**
 * 决定一段路用什么交通方式:
 * - walk 太远 → 视为"未指定",按距离升级为驾车/火车(历史数据全是 walk)
 * - drive 太远 → 火车;transit 太远 → 火车
 * - drive 很近(同城) → 步行(同片区短途开车不合理)
 * 用户在弹窗里选的 walk 若距离合理(≤15km)会被保留。
 */
export function resolveMode(mode: TransportMode, km: number): TransportMode {
  if (mode === 'walk') {
    if (km > DRIVE_MAX_KM) return 'train';
    if (km > WALK_MAX_KM) return 'drive';
    return 'walk';
  }
  if (mode === 'drive') {
    if (km > DRIVE_MAX_KM) return 'train';
    if (km < WALK_THRESHOLD_KM) return 'walk';
    return 'drive';
  }
  if (mode === 'transit' && km > TRANSIT_MAX_KM) return 'train';
  return mode;
}

/** 直线距离下的兜底时长(共用驾车 40km/h,与优化流程一致) */
function fallbackDriveMin(km: number): number {
  return Math.max(3, Math.round((km / 40) * 60));
}

/** 各交通方式的粗略速度(km/h),仅用于无真实路线时的兜底估算 */
const MODE_SPEED_KMH: Record<TransportMode, number> = {
  walk: 5, drive: 60, transit: 25, train: 200, flight: 700,
};

/**
 * 计算一段路。走真实路线的前提是:采用 drive 且调用方给了 fetcher。
 * 失败/超时一律回退直线估算,绝不阻塞界面。
 */
export async function computeSegment(
  from: SegPoint,
  to: SegPoint,
  drive: DriveFetcher | null,
): Promise<SegmentInfo> {
  const straightKm = haversineKm(from.lng, from.lat, to.lng, to.lat);
  const mode = resolveMode(to.transportMode, straightKm);

  // 非驾车:按各自速度估算,不消耗接口
  if (mode !== 'drive' || !drive) {
    const speed = MODE_SPEED_KMH[mode] || 60;
    return {
      fromId: from.id, toId: to.id, mode, real: false,
      distanceKm: straightKm,
      durationMin: Math.max(1, Math.round((straightKm / speed) * 60)),
    };
  }

  try {
    const r = await drive([from.lng, from.lat], [to.lng, to.lat], 'drive');
    if (r.distanceM > 0) {
      return {
        fromId: from.id, toId: to.id, mode, real: true,
        distanceKm: r.distanceM / 1000,
        durationMin: r.durationMin,
      };
    }
  } catch { /* 回退估算 */ }

  return {
    fromId: from.id, toId: to.id, mode, real: false,
    distanceKm: straightKm, durationMin: fallbackDriveMin(straightKm),
  };
}

/** 距离展示:小于 1km 用米 */
export function fmtDistance(km: number): string {
  if (!km || km <= 0) return '';
  if (km < 1) return `${Math.round(km * 1000)}m`;
  return `${km.toFixed(1)}km`;
}

/** 时长展示:>=60min 用 h+m */
export function fmtDuration(min: number): string {
  if (!min || min <= 0) return '';
  if (min >= 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h}h${m}m` : `${h}h`;
  }
  return `${min}min`;
}

/** 路段的一行文案,如「驾车 12.3km · 约 18min」 */
export function fmtSegment(seg: SegmentInfo): string {
  const meta = MODE_META[seg.mode];
  const dist = fmtDistance(seg.distanceKm);
  const dur = fmtDuration(seg.durationMin);
  const approx = seg.real ? '' : '约 ';
  const parts = [dist, dur ? `${approx}${dur}` : ''].filter(Boolean);
  return parts.length ? `${meta.verb} ${parts.join(' · ')}` : `${meta.verb}`;
}

/**
 * 一次算出「天内相邻段」与「跨天衔接段」。
 * 保持并发上限,避免打开长行程时瞬时打爆高德接口。
 *
 * @returns intraDay: Map<dayId, SegmentInfo[]>,长度 = 该天点数-1(无坐标点不计)
 *          crossDay: Map<dayId, SegmentInfo|null>,本天首点相对上一天末点的那段
 */
export async function computeAllSegments(
  days: Array<{ dayId: string; points: SegPoint[] }>,
  drive: DriveFetcher | null,
  concurrency = 5,
): Promise<{
  intraDay: Map<string, SegmentInfo[]>;
  crossDay: Map<string, SegmentInfo | null>;
}> {
  const intraDay = new Map<string, SegmentInfo[]>();
  const crossDay = new Map<string, SegmentInfo | null>();
  const jobs: Array<{ kind: 'intra'; dayId: string; idx: number; from: SegPoint; to: SegPoint }
    | { kind: 'cross'; dayId: string; from: SegPoint; to: SegPoint }> = [];

  for (let d = 0; d < days.length; d++) {
    const pts = days[d].points;
    intraDay.set(days[d].dayId, new Array(Math.max(0, pts.length - 1)).fill(null));
    for (let i = 0; i < pts.length - 1; i++) {
      jobs.push({ kind: 'intra', dayId: days[d].dayId, idx: i, from: pts[i], to: pts[i + 1] });
    }
    // 跨天:本天首点 ← 上一天【最后一个有坐标的点】
    const prev = days[d - 1]?.points;
    crossDay.set(days[d].dayId, null);
    if (prev && prev.length && pts.length) {
      jobs.push({ kind: 'cross', dayId: days[d].dayId, from: prev[prev.length - 1], to: pts[0] });
    }
  }

  for (let i = 0; i < jobs.length; i += concurrency) {
    const batch = jobs.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map((j) => computeSegment(j.from, j.to, drive).catch(() => null)),
    );
    results.forEach((seg, k) => {
      if (!seg) return;
      const j = batch[k];
      if (j.kind === 'intra') {
        const arr = intraDay.get(j.dayId)!;
        arr[j.idx] = seg;
      } else {
        crossDay.set(j.dayId, seg);
      }
    });
  }

  return { intraDay, crossDay };
}
