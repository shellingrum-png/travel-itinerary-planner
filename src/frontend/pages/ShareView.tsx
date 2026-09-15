/**
 * 分享只读页(免登录) — 家人通过 /share/:token 查看。
 * 独立于账号体系:只按 token 从公开端点拉快照,不写 IndexedDB(仅用匿名额存路线缓存)、
 * 不触发同步、无编辑入口。
 * 布局手机优先:顶部吸顶地图看整体路线 → 下方逐日列表(点当天地图自动聚焦)。
 * 路段里程/机场段与详情页一致:按距离修正交通方式(resolveMode)+ 高德 JS API 取真实路线。
 */
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { fetchSharedTrip } from '../services/share';
import { db } from '../services/db';
import { loadAMap } from '../services/amapLoader';
import { loadRoutePlanner } from '../services/amapLoader';
import { resolveAirports, buildSegments, AIRPORT_ARR_ID, AIRPORT_DEP_ID, type Airport, type SegData } from '../utils/shareSegments';
import { fmtSegment, MODE_META, type SegmentInfo } from '../utils/segments';
import { dayTransports, fmtDT, modeIcon } from '../utils/transportFormat';
import type { TripSnapshot } from '../services/sync';
import { snapshotToOverview } from '../utils/shareView';
import type { TripOverview, DayStats } from '../utils/dayStats';
import type { TransportMode, Poi, RouteCache } from '../types';
import { C, card } from '../components/ui';

const CATEGORY_LABEL: Record<string, string> = {
  transport: '大交通',
  hotel: '住宿',
  food: '餐饮',
  ticket: '门票',
  local_traffic: '本地交通',
  other: '其他',
};

const MODE_LABELS: Record<TransportMode, string> = {
  walk: '步行', drive: '驾车', transit: '公交', train: '火车', flight: '飞机',
};

const DAY_COLORS = [
  '#ff6b6b', '#ffd166', '#06d6a0', '#118ab2', '#ef476f',
  '#073b4c', '#f77f00', '#8338ec', '#3a86ff', '#ff006e',
];

/** 高德导航 URI:手机上点开会唤起高德 App 导航到该点 */
function navUrl(p: Poi): string {
  return `https://uri.amap.com/navigation?to=${p.lng},${p.lat},${encodeURIComponent(p.name)}&mode=car&coordinate=gaode&src=travel-share`;
}

export default function ShareView() {
  const { token } = useParams<{ token: string }>();
  const [snap, setSnap] = useState<TripSnapshot | null>(null);
  const [routeCache, setRouteCache] = useState<RouteCache[]>([]);
  const [overview, setOverview] = useState<TripOverview | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'invalid'>('loading');
  const [focusDay, setFocusDay] = useState<number | null>(null);
  const [airports, setAirports] = useState<{ arr?: Airport; dep?: Airport }>({});
  const [segData, setSegData] = useState<SegData>({ pointsByDay: new Map(), intra: new Map(), cross: new Map() });

  useEffect(() => {
    if (!token) { setState('invalid'); return; }
    let alive = true;
    (async () => {
      const s = await fetchSharedTrip(token);
      if (!alive) return;
      if (!s) { setState('invalid'); return; }
      // 先回填主账号随分享下发的路线缓存(真实里程),再渲染 —— 保证算路段时缓存已就位
      const shared = (s as TripSnapshot & { routeCache?: RouteCache[] }).routeCache;
      if (shared?.length) {
        try { await db.seedRouteCache(shared); } catch { /* 缓存写入失败不阻塞展示 */ }
        if (!alive) return;
        setRouteCache(shared);
      }
      setSnap(s);
      try { setOverview(snapshotToOverview(s)); } catch { setOverview(null); }
      setState('ok');
    })();
    return () => { alive = false; };
  }, [token]);

  // 解析机场 + 计算逐日路段(与详情页同口径,逻辑见 utils/shareSegments)
  useEffect(() => {
    if (!snap) return;
    let cancelled = false;
    (async () => {
      // 缓存未命中时预热高德插件(命中下发缓存则基本用不上)
      if (!routeCache.length) {
        await Promise.all([loadRoutePlanner('drive'), loadRoutePlanner('walk'), loadRoutePlanner('transit')]).catch(() => {});
      }
      if (cancelled) return;
      const ap = await resolveAirports(snap);
      if (cancelled) return;
      setAirports(ap);
      const data = await buildSegments(snap, ap, routeCache.length ? 5 : 2);
      if (cancelled) return;
      setSegData(data);
    })();
    return () => { cancelled = true; };
  }, [snap, routeCache]);

  if (state === 'loading') {
    return <div style={{ textAlign: 'center', color: '#9a9ab0', padding: 60 }}>加载中…</div>;
  }
  if (state === 'invalid' || !snap) {
    return (
      <div style={{ maxWidth: 480, margin: '0 auto', padding: 40, textAlign: 'center' }}>
        <h2 style={{ fontSize: 18, color: '#e9e9f2' }}>链接已失效</h2>
        <p style={{ color: '#9a9ab0', fontSize: 13 }}>该分享链接无效或已被撤销,请向分享者索取新链接。</p>
      </div>
    );
  }

  const { trip } = snap;
  const poiById = new Map(snap.pois.map((p) => [p.id, p]));
  const memberText = trip.members?.length
    ? trip.members.map((m) => m.name).join(' / ')
    : `${trip.companionCount}人`;

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: '16px 16px 40px', minHeight: '100vh' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{
          fontSize: 11, color: C.info, border: `1px solid ${C.info}`,
          borderRadius: 999, padding: '1px 8px',
        }}>只读分享</span>
      </div>

      <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>{trip.title}</h1>
      <p style={{ color: '#9a9ab0', fontSize: 13, margin: '6px 0 14px' }}>
        {trip.destination} · {trip.startDate} ~ {trip.endDate} · {memberText}
      </p>

      {/* 地图(整体路线) */}
      <ShareMap snap={snap} focusDay={focusDay} airports={airports} />

      {overview && (
        <>
          {/* 总花费 */}
          <div style={{ ...card, margin: '0 0 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 13, color: '#9a9ab0' }}>总花费</div>
                <div style={{ fontSize: 30, fontWeight: 700, color: C.warning }}>¥{overview.totalSpend.toFixed(0)}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 13, color: '#9a9ab0' }}>人均</div>
                <div style={{ fontSize: 20, fontWeight: 600 }}>¥{overview.perCapita.toFixed(0)}</div>
              </div>
            </div>
            {(() => {
              const entries = Object.entries(overview.spendByCategory).sort((a, b) => b[1] - a[1]);
              const maxCat = Math.max(1, ...entries.map(([, v]) => v));
              return entries.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {entries.map(([cat, val]) => (
                    <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                      <span style={{ width: 70, color: '#e8e8f0' }}>{CATEGORY_LABEL[cat] ?? cat}</span>
                      <div style={{ flex: 1, height: 8, background: 'rgba(255,255,255,0.08)', borderRadius: 4, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${(val / maxCat) * 100}%`, background: C.primary, borderRadius: 4 }} />
                      </div>
                      <span style={{ width: 60, textAlign: 'right', color: '#9a9ab0' }}>¥{val.toFixed(0)}</span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </div>

          {/* 逐日卡片(点击展开当日明细 + 地图聚焦当天) */}
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 12px' }}>每日行程</h2>
          {overview.dayStats.length === 0 ? (
            <p style={{ color: '#9a9ab0' }}>暂无日期数据</p>
          ) : (
            overview.dayStats.map((d, i) => (
              <DayCard
                key={d.daySeq}
                day={d}
                color={DAY_COLORS[i % DAY_COLORS.length]}
                snap={snap}
                poiById={poiById}
                segData={segData}
                airports={airports}
                onFocus={() => setFocusDay(d.daySeq)}
              />
            ))
          )}
        </>
      )}
    </div>
  );
}

/** 顶部地图:每天景点按序连线(不同天不同色),跨天虚线衔接,机场单独标注;点击卡片聚焦当天 */
function ShareMap({ snap, focusDay, airports }: { snap: TripSnapshot; focusDay: number | null; airports: { arr?: Airport; dep?: Airport } }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const apRef = useRef(airports);
  apRef.current = airports;
  const [mapError, setMapError] = useState<string | null>(null);

  const draw = () => {
    const map = mapRef.current;
    const AMap = (window as any).AMap;
    if (!map || !AMap) return;
    map.clearMap();
    const s = snapRef.current;
    const poiById = new Map(s.pois.map((p) => [p.id, p] as [string, Poi]));
    const days = [...s.days].sort((a, b) => a.daySeq - b.daySeq);
    const dayPts = days
      .map((d) => ({
        daySeq: d.daySeq,
        pts: s.items
          .filter((it) => it.dayId === d.id && it.itemType === 'poi' && it.poiId)
          .sort((a, b) => a.orderSeq - b.orderSeq)
          .map((it) => poiById.get(it.poiId!))
          .filter((p): p is Poi => !!p && p.lng !== 0 && p.lat !== 0),
      }))
      .filter((d) => d.pts.length > 0);

    const all: [number, number][] = [];
    // 统计坐标重叠:同点 marker 自动向下错开,避免叠盖(参照详情页做法)
    const posCount = new Map<string, number>();
    const posDone = new Map<string, number>();
    dayPts.forEach((d) => d.pts.forEach((p) => {
      const k = `${p.lng},${p.lat}`;
      posCount.set(k, (posCount.get(k) || 0) + 1);
    }));

    dayPts.forEach((d, di) => {
      const color = DAY_COLORS[di % DAY_COLORS.length];
      const path: [number, number][] = [];
      d.pts.forEach((p, i) => {
        const pos: [number, number] = [p.lng, p.lat];
        path.push(pos);
        all.push(pos);
        const k = `${p.lng},${p.lat}`;
        const total = posCount.get(k) || 1;
        const idx = (posDone.get(k) || 0) + 1;
        posDone.set(k, idx);
        const offset = total > 1 ? new AMap.Pixel(0, idx * 18 - 9) : new AMap.Pixel(-12, -12);
        const marker = new AMap.Marker({
          position: pos, offset,
          content: `<div style="width:24px;height:24px;border-radius:50%;background:${color};border:2px solid #fff;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:10px;box-shadow:0 2px 6px rgba(0,0,0,0.6);">${d.daySeq}-${i + 1}</div>`,
        });
        marker.on('click', () => {
          new AMap.InfoWindow({
            content: `<div style="color:#222;font-size:13px;font-weight:700;padding:2px 4px;">Day ${d.daySeq} · ${p.name}</div>`,
            offset: new AMap.Pixel(0, -28),
          }).open(map, pos);
        });
        map.add(marker);
      });
      if (path.length >= 2) {
        map.add(new AMap.Polyline({
          path, strokeColor: color, strokeWeight: 5, strokeOpacity: 0.85,
          lineJoin: 'round', showDir: true,
        }));
      }
    });

    // 跨天虚线:相邻有景点天的末点 → 首点
    for (let i = 0; i < dayPts.length - 1; i++) {
      const from = dayPts[i].pts[dayPts[i].pts.length - 1];
      const to = dayPts[i + 1].pts[0];
      map.add(new AMap.Polyline({
        path: [[from.lng, from.lat], [to.lng, to.lat]],
        strokeColor: '#ffffff', strokeWeight: 2, strokeOpacity: 0.4,
        strokeStyle: 'dashed', lineDash: [4, 8],
      }));
    }

    // 机场:标记 + 到首/末站橙色虚线
    const ap = apRef.current;
    const drawAirport = (air: Airport | undefined, anchor: Poi | undefined, dir: 'in' | 'out') => {
      if (!air) return;
      all.push([air.lng, air.lat]);
      map.add(new AMap.Marker({
        position: [air.lng, air.lat],
        content: '<div style="background:#ffa07a;color:#1a1a2e;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.5);">✈️ 机场</div>',
      }));
      if (!anchor) return;
      map.add(new AMap.Polyline({
        path: dir === 'in'
          ? [[air.lng, air.lat], [anchor.lng, anchor.lat]]
          : [[anchor.lng, anchor.lat], [air.lng, air.lat]],
        strokeColor: '#ffa07a', strokeWeight: 3, strokeOpacity: 0.7, strokeStyle: 'dashed', lineDash: [6, 6],
      }));
    };
    if (dayPts.length) {
      drawAirport(ap.arr, dayPts[0].pts[0], 'in');
      drawAirport(ap.dep, dayPts[dayPts.length - 1].pts.slice(-1)[0], 'out');
    }

    if (all.length > 0) {
      const b = all.reduce<[number[], number[]]>(
        (acc, p) => {
          acc[0][0] = Math.min(acc[0][0], p[0]); acc[0][1] = Math.min(acc[0][1], p[1]);
          acc[1][0] = Math.max(acc[1][0], p[0]); acc[1][1] = Math.max(acc[1][1], p[1]);
          return acc;
        },
        [[Infinity, Infinity], [-Infinity, -Infinity]],
      );
      map.setBounds(new AMap.Bounds(new AMap.LngLat(b[0][0], b[0][1]), new AMap.LngLat(b[1][0], b[1][1])), false, [40, 40, 40, 40]);
    }
  };

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const AMap = await loadAMap();
        if (dead || !containerRef.current) return;
        const map = new AMap.Map(containerRef.current, { zoom: 5, center: [100, 37.5], mapStyle: 'amap://styles/dark' });
        mapRef.current = map;
        map.on('complete', draw);
        setTimeout(draw, 1000); // 兜底:complete 未触发时也渲染一次
      } catch (e: any) {
        if (!dead) setMapError(e?.message || '地图加载失败');
      }
    })();
    return () => { dead = true; if (mapRef.current) { mapRef.current.destroy(); mapRef.current = null; } };
  }, []);

  // 数据/机场到位后重绘
  useEffect(() => { const t = setTimeout(draw, 50); return () => clearTimeout(t); }, [snap, airports]);

  // 点击某天 → 聚焦该天景点
  useEffect(() => {
    const map = mapRef.current;
    const AMap = (window as any).AMap;
    if (!map || !AMap || !focusDay) return;
    const s = snapRef.current;
    const poiById = new Map(s.pois.map((p) => [p.id, p] as [string, Poi]));
    const day = s.days.find((d) => d.daySeq === focusDay);
    if (!day) return;
    const pts = s.items
      .filter((it) => it.dayId === day.id && it.itemType === 'poi' && it.poiId)
      .sort((a, b) => a.orderSeq - b.orderSeq)
      .map((it) => poiById.get(it.poiId!))
      .filter((p): p is Poi => !!p && p.lng !== 0 && p.lat !== 0);
    if (!pts.length) return;
    if (pts.length === 1) {
      map.setZoomAndCenter(13, [pts[0].lng, pts[0].lat]);
    } else {
      const b = pts.reduce<[number[], number[]]>(
        (acc, p) => {
          acc[0][0] = Math.min(acc[0][0], p.lng); acc[0][1] = Math.min(acc[0][1], p.lat);
          acc[1][0] = Math.max(acc[1][0], p.lng); acc[1][1] = Math.max(acc[1][1], p.lat);
          return acc;
        },
        [[Infinity, Infinity], [-Infinity, -Infinity]],
      );
      map.setBounds(new AMap.Bounds(new AMap.LngLat(b[0][0], b[0][1]), new AMap.LngLat(b[1][0], b[1][1])), false, [60, 60, 60, 60]);
    }
  }, [focusDay]);

  return (
    <div style={{ position: 'sticky', top: 0, zIndex: 10, borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.09)', marginBottom: 16, height: 240, background: '#16162a' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {mapError && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9a9ab0', fontSize: 13, padding: 20, textAlign: 'center' }}>
          地图加载失败(不影响下方行程查看)
        </div>
      )}
    </div>
  );
}

function DayCard({
  day, color, snap, poiById, segData, airports, onFocus,
}: {
  day: DayStats;
  color: string;
  snap: TripSnapshot;
  poiById: Map<string, Poi>;
  segData: SegData;
  airports: { arr?: Airport; dep?: Airport };
  onFocus: () => void;
}) {
  const [open, setOpen] = useState(false);
  const dayRecord = snap.days.find((x) => x.daySeq === day.daySeq);
  const dayItems = dayRecord
    ? snap.items.filter((it) => it.dayId === dayRecord.id).sort((a, b) => a.orderSeq - b.orderSeq)
    : [];
  // 仅当该日有任意一条带时间时,才保留时间列(否则空列会把所有标签右移,看着像缩进)
  const hasTime = dayItems.some((it) => it.arriveTime);

  // 当天全部驾车里程 = 天内各驾车段 + 跨天衔接段(今天从上一站开过来那段),
  // 这样顶部数字 = 下面明细里各段相加,不会「对不上」。
  const intra = (dayRecord && segData.intra.get(dayRecord.id)) || [];
  const cross = dayRecord ? segData.cross.get(dayRecord.id) : null;
  const points = (dayRecord && segData.pointsByDay.get(dayRecord.id)) || [];
  const driveSegs = intra.filter((s): s is SegmentInfo => !!s && s.mode === 'drive');
  const crossDrive = cross && cross.mode === 'drive' ? cross : null;
  const driveKm = driveSegs.reduce((sum, s) => sum + s.distanceKm, 0) + (crossDrive?.distanceKm ?? 0);
  const approx = driveSegs.some((s) => !s.real) || (!!crossDrive && !crossDrive.real);
  const hasSeg = driveSegs.length > 0 || !!crossDrive;
  // 到达某点的路段:k=0 用跨天段,k>0 用天内段
  const arrivalByItemId = new Map<string, SegmentInfo>();
  points.forEach((p, k) => {
    const seg = k === 0 ? cross : intra[k - 1];
    if (seg) arrivalByItemId.set(p.id, seg);
  });

  const dayFlights = dayTransports(snap.transports, day.date);

  const toggle = () => { setOpen((v) => !v); onFocus(); };

  return (
    <div style={{ ...card, marginBottom: 10, borderLeft: `3px solid ${color}` }}>
      <div
        onClick={toggle}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
      >
        <strong style={{ fontSize: 15 }}>
          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: color, marginRight: 8 }} />
          Day {day.daySeq} · {day.date}
        </strong>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {(hasSeg || day.driveKm > 0) && (
            <span style={{ fontSize: 13, color: C.info }}>
              🚗 {(hasSeg ? driveKm : day.driveKm).toFixed(1)} km{(hasSeg ? approx : day.driveKmApprox) ? ' ≈' : ''}
            </span>
          )}
          <span style={{ fontSize: 12, color: '#6a6a80' }}>{open ? '收起' : '展开'}</span>
        </span>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0' }}>
        <span style={{ fontSize: 13 }}>🏨 {day.hotelName}</span>
      </div>

      {day.pois.length > 0 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {day.pois.map((p, i) => (
            <span key={i} style={{
              fontSize: 12, color: '#e8e8f0', background: 'rgba(255,255,255,0.07)',
              border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '2px 8px',
            }}>
              {p.name}
            </span>
          ))}
        </div>
      ) : (
        <span style={{ fontSize: 13, color: '#9a9ab0' }}>当日无景点排点</span>
      )}

      {day.spend > 0 && (
        <div style={{ marginTop: 8, fontSize: 13, color: '#9a9ab0' }}>当日花费 ¥{day.spend.toFixed(0)}</div>
      )}

      {open && (dayItems.length > 0 || dayFlights.length > 0) && (
        <div style={{
          marginTop: 12, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.08)',
          display: 'flex', flexDirection: 'column', gap: 8,
        }}>
          {/* 跨天衔接:本天首站 ← 上一天末站 */}
          {cross && (
            <div style={{ fontSize: 11, color: '#b8a0e0', padding: '4px 8px', borderRadius: 6, background: 'rgba(184,160,224,0.12)' }}>
              ⇡ 距上一天末站 {fmtSegment(cross)}
            </div>
          )}
          {/* 首日:到达机场 → 首站 */}
          {(() => {
            const first = intra[0];
            if (!first || first.fromId !== AIRPORT_ARR_ID) return null;
            return (
              <div style={{ fontSize: 12, color: '#ffa07a' }}>
                ✈️ {airports.arr?.name} → {MODE_META[first.mode].icon} {fmtSegment(first)}
              </div>
            );
          })()}

          {dayItems.map((it, i) => {
            const poi = it.poiId ? poiById.get(it.poiId) : undefined;
            const time = it.arriveTime ? `${it.arriveTime}${it.leaveTime ? ` ~ ${it.leaveTime}` : ''}` : '';
            let label = '';
            if (it.itemType === 'poi') label = poi?.name || it.note || '景点';
            else if (it.itemType === 'hotel') label = '🏨 ' + (it.note || poi?.name || '住宿');
            else if (it.itemType === 'transport') label = '🚗 ' + (MODE_LABELS[it.transportMode] || it.transportMode);
            else label = it.note || '缓冲';
            const canNav = it.itemType === 'poi' && poi && poi.lng !== 0 && poi.lat !== 0;
            const arrSeg = arrivalByItemId.get(it.id);
            return (
              <div key={i}>
                {/* 到达本站的路段(带交通方式与里程) */}
                {arrSeg && (
                  <div style={{ fontSize: 11, color: '#8fa8c0', marginBottom: 3 }}>
                    ↳ {MODE_META[arrSeg.mode].icon} {fmtSegment(arrSeg)}
                    {arrSeg.fromId === AIRPORT_ARR_ID ? '(机场)' : ''}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 10, fontSize: 13, alignItems: 'baseline' }}>
                  {hasTime && <span style={{ width: 88, color: '#7eb8e0', fontSize: 12, flexShrink: 0 }}>{time}</span>}
                  <span style={{ color: '#e8e8f0', flex: 1 }}>{label}</span>
                  {canNav && (
                    <a
                      href={navUrl(poi!)}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        flexShrink: 0, fontSize: 12, color: C.primary, textDecoration: 'none',
                        border: `1px solid ${C.primary}`, borderRadius: 6, padding: '1px 8px',
                      }}
                    >
                      导航
                    </a>
                  )}
                </div>
              </div>
            );
          })}

          {/* 末日:末站 → 返程机场 */}
          {(() => {
            const last = intra[intra.length - 1];
            if (!last || last.toId !== AIRPORT_DEP_ID) return null;
            return (
              <div style={{ fontSize: 12, color: '#ffa07a' }}>
                ✈️ → {airports.dep?.name} {MODE_META[last.mode].icon} {fmtSegment(last)}
              </div>
            );
          })()}

          {/* 大交通(航班/火车)行 */}
          {dayFlights.map((t) => (
            <div key={t.id} style={{ fontSize: 12, color: '#ffa07a', display: 'flex', gap: 6, alignItems: 'baseline' }}>
              <span>{modeIcon(t.mode)}</span>
              <span style={{ color: '#e8e8f0' }}>{t.fromPlace} → {t.toPlace}</span>
              <span style={{ color: '#8fa8c0', fontSize: 11 }}>{fmtDT(t.departAt)} → {fmtDT(t.arriveAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
