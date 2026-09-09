import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { db } from '../services/db';
import { useOnlineStatus } from '../utils/useOnlineStatus';
import { solveTsp, savings, solveOpenPath, haversineKm } from '../utils/tsp';
import { getDuration, searchPoiByJS, reverseGeocode, getDrivingPath, resolveTransportHubCoord } from '../services/amap';
import { getPoiCard } from '../services/llm';
import { loadAMap } from '../services/amapLoader';
import { optimizeItinerary, estimateDayCapacity, estimateReachablePois, dayWindowMin, findReturnTransport, findDepartTransport } from '../services/itineraryEngine';
import type { ItineraryPoi, DayAnchor } from '../services/itineraryEngine';
import TripPreview from '../components/TripPreview';
import ItemEditModal, { type EditPatch } from '../components/ItemEditModal';
import { modeIcon, fmtDT, dayTransports, isBigTransportMode } from '../utils/transportFormat';
import { buildItemPatch, ticketAction } from '../utils/itemEdit';
import type { Trip, ItineraryDay, ItineraryItem, Poi, PoiAiCard, Hotel, TransportMode, Transport, TransportModeType, TransportSegmentType } from '../types';

const DAY_COLORS = [
  '#ff6b6b','#ffd166','#06d6a0','#118ab2','#ef476f',
  '#073b4c','#f77f00','#8338ec','#3a86ff','#ff006e',
];

interface SearchResult {
  id: string; name: string; address: string; lng: number; lat: number; type: string;
}

type EditTab = 'scenic' | 'hotel' | 'transport';
type ViewMode = 'editor' | 'viewer';

export default function TripDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [days, setDays] = useState<ItineraryDay[]>([]);
  const [daySummaries, setDaySummaries] = useState<Array<{ day: ItineraryDay; items: (ItineraryItem & { poi?: Poi; aiCard?: PoiAiCard })[] }>>([]);
  const [spent, setSpent] = useState(0);
  const [showMap, setShowMap] = useState(true);
  const [mode, setMode] = useState<ViewMode>('editor');
  const online = useOnlineStatus();
  const [transports, setTransports] = useState<Transport[]>([]); // 大交通表

  // ── 编辑状态 ──
  const [activeDayId, setActiveDayId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<EditTab>('scenic');
  const [detailExpanded, setDetailExpanded] = useState<Record<string, boolean>>({});
  const [editExpanded, setEditExpanded] = useState<Record<string, boolean>>({});

  // 景点搜索
  const [scenicKeyword, setScenicKeyword] = useState('');
  const [scenicCity, setScenicCity] = useState('');
  const [scenicResults, setScenicResults] = useState<SearchResult[]>([]);
  const [scenicLoading, setScenicLoading] = useState(false);
  const [selectedScenic, setSelectedScenic] = useState<SearchResult | null>(null);
  const [scenicCard, setScenicCard] = useState<PoiAiCard | null>(null);
  const [scenicCardLoading, setScenicCardLoading] = useState(false);
  const [ticketPrice, setTicketPrice] = useState(''); // V6.2 关联记账:门票价

  // 酒店搜索
  const [hotelKeyword, setHotelKeyword] = useState('');
  const [hotelCity, setHotelCity] = useState('');
  const [hotelResults, setHotelResults] = useState<SearchResult[]>([]);
  const [hotelLoading, setHotelLoading] = useState(false);
  const [selectedHotel, setSelectedHotel] = useState<SearchResult | null>(null);
  const [hotelPrice, setHotelPrice] = useState(''); // V6.2 关联记账:房价

  // 交通
  const [transportPrice, setTransportPrice] = useState(''); // V6.2 关联记账:票价
  const [fromResult, setFromResult] = useState<SearchResult | null>(null);
  const [toResult, setToResult] = useState<SearchResult | null>(null);
  const [transportMode, setTransportMode] = useState<TransportMode>('drive');
  const [transportDepart, setTransportDepart] = useState(''); // 大交通起飞 yyyy-mm-ddTHH:mm
  const [transportArrive, setTransportArrive] = useState(''); // 大交通到达
  const [editingItem, setEditingItem] = useState<(ItineraryItem & { poi?: Poi }) | null>(null); // 修改弹窗
  const [linkedTicket, setLinkedTicket] = useState<number | undefined>(undefined);
  const [transportSeg, setTransportSeg] = useState<TransportSegmentType>('inter_city');
  const [routeInfo, setRouteInfo] = useState<{ durationMin: number; distanceM: number } | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);

  // V6.2 拖拽排序:当前拖拽的 item / 悬停目标(来源天id|itemId → 目标天id)
  const [dragItem, setDragItem] = useState<{ itemId: string; fromDayId: string } | null>(null);
  const [dragOverDayId, setDragOverDayId] = useState<string | null>(null);

  // ── 地图 ──
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const tempMarkerRef = useRef<any>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  // 用 ref 保存最新 daySummaries,避免定时器/事件回调读到旧闭包
  const daySummariesRef = useRef(daySummaries);
  daySummariesRef.current = daySummaries;

  // 机场节点(到达/返程),供地图画出机场↔首末天锚点段
  const [airports, setAirports] = useState<{ arr?: { lng: number; lat: number; name: string }; dep?: { lng: number; lat: number; name: string } }>({});
  const airportsRef = useRef(airports);
  airportsRef.current = airports;

  // ── 加载数据 ──
  const load = useCallback(async () => {
    if (!id) return;
    const t = await db.getTrip(id);
    if (!t) { navigate('/'); return; }
    setTrip(t);
    const allDays = await db.listDays(id);
    setDays(allDays);
    setSpent(await db.sumExpenses(id));
    setTransports(await db.listTransports(id));

    const summaries: Array<{ day: ItineraryDay; items: (ItineraryItem & { poi?: Poi; aiCard?: PoiAiCard })[] }> = [];
    for (const d of allDays) {
      const items = await db.listItems(d.id);
      const enriched: (ItineraryItem & { poi?: Poi; aiCard?: PoiAiCard })[] = [];

      // 直接附加有坐标的 POI;缺失的保留原 item(仅无地图点),绝不覆盖坐标
      // (此前的"自动修坐标"用全范围搜索会误盖正确坐标,已移除)
      for (const it of items) {
        const poi = it.poiId ? await db.getPoi(it.poiId) : null;
        if (poi && poi.lng !== 0 && poi.lat !== 0) {
          const card = await db.getPoiCard(poi.id).catch(() => null);
          enriched.push({ ...it, poi, aiCard: card ?? undefined });
        } else {
          enriched.push(it);
        }
      }

      summaries.push({ day: d, items: enriched });
    }
    setDaySummaries(summaries);
    // 解析机场节点(到达/返程),供地图画机场段
    const ts = await db.listTransports(id);
    const sorted = [...allDays].sort((a, b) => a.daySeq - b.daySeq);
    const first = sorted[0], last = sorted[sorted.length - 1];
    const arrT = findDepartTransport(ts, first.date);
    const depT = findReturnTransport(ts, last.date);
    const [arrC, depC] = await Promise.all([
      arrT ? resolveTransportHubCoord(arrT.toPlace ?? '', arrT.mode) : null,
      depT ? resolveTransportHubCoord(depT.fromPlace ?? '', depT.mode) : null,
    ]);
    setAirports({
      arr: arrC ? { lng: arrC[0], lat: arrC[1], name: arrT!.toPlace || '' } : undefined,
      dep: depC ? { lng: depC[0], lat: depC[1], name: depT!.fromPlace || '' } : undefined,
    });
    // V6.2:自动备份到云端(防抖,避免每次编辑都请求)
    scheduleBackup(id);
  }, [id]);

  // ── 自动云备份(防抖) ──
  const backupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleBackup = useCallback((tripId: string) => {
    if (backupTimer.current) clearTimeout(backupTimer.current);
    backupTimer.current = setTimeout(async () => {
      try {
        const { backupTrip } = await import('../services/sync');
        await backupTrip(tripId);
        console.log('[云备份] 已同步到云端:', tripId.slice(0, 8));
      } catch { /* 静默失败,不影响主流程 */ }
    }, 800); // 800ms 防抖
  }, []);

  const ready = !!trip;

  useEffect(() => { load(); }, [load]);

  // ── 初始化地图 ──
  useEffect(() => {
    if (!ready) return;
    const init = async () => {
      try {
        const AMap = await loadAMap();
        if (!mapContainerRef.current) return;
        const map = new AMap.Map(mapContainerRef.current, {
          zoom: 6, center: [100.0, 37.5], mapStyle: 'amap://styles/dark',
        });
        mapRef.current = map;
        // 等地图完全就绪后再渲染覆盖物
        map.on('complete', () => renderMapOverlays());
        // 兜底:1 秒后强制渲染一次(防止 complete 事件不触发)
        setTimeout(() => renderMapOverlays(), 1000);
      } catch (e: any) {
        setMapError('地图加载失败: ' + e.message);
      }
    };
    init();
    return () => { if (mapRef.current) { mapRef.current.destroy(); mapRef.current = null; } };
  }, [ready]);

  // daySummaries / 机场变化时重新渲染覆盖物
  useEffect(() => {
    if (!mapRef.current || !ready) return;
    // 延迟一帧,确保 map 容器尺寸已就绪
    const t = setTimeout(() => renderMapOverlays(), 50);
    return () => clearTimeout(t);
  }, [daySummaries, airports, ready]);

    // ── 渲染地图覆盖物 ──
  const renderMapOverlays = () => {
    if (!mapRef.current) return;
    const map = mapRef.current;
    const AMap = (window as any).AMap;
    if (!AMap) { console.warn('[地图] AMap 未就绪'); return; }
    map.clearMap();
    const allPositions: [number, number][] = [];

    // 读 ref(最新数据),避免闭包捕获旧值
    const summaries = daySummariesRef.current;
    // V6.2b:统计坐标重叠,自动错开(避免同点 marker 叠盖)
    const posCount = new Map<string, number>();     // 坐标 → 总点数
    const posDone = new Map<string, number>();      // 坐标 → 已处理第几个
    summaries.forEach((ds) => {
      ds.items.forEach((it) => {
        if (it.poi && it.poi.lng !== 0 && it.poi.lat !== 0) {
          const key = `${it.poi.lng},${it.poi.lat}`;
          posCount.set(key, (posCount.get(key) || 0) + 1);
        }
      });
    });

    summaries.forEach((ds, di) => {
      const color = DAY_COLORS[di % DAY_COLORS.length];
      const path: [number, number][] = [];
      let seq = 0; // 当天内景点序号
      ds.items.forEach((it) => {
        if (it.poi && it.poi.lng !== 0 && it.poi.lat !== 0) {
          seq++;
          const pos: [number, number] = [it.poi.lng, it.poi.lat];
          const key = `${it.poi.lng},${it.poi.lat}`;
          const total = posCount.get(key) || 0;
          const idx = (posDone.get(key) || 0) + 1;
          posDone.set(key, idx);
          // 若同坐标有多个点:第2+个向下偏移,避免叠盖
          const off = total > 1 ? new AMap.Pixel(0, idx * 18 - 9) : new AMap.Pixel(-13, -13);
          const marker = new AMap.Marker({
            position: pos, offset: off,
            content: `<div style="width:26px;height:26px;border-radius:50%;background:${color};border:2px solid #fff;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:11px;box-shadow:0 2px 6px rgba(0,0,0,0.6);">${ds.day.daySeq}-${seq}</div>`,
          });
          marker.on('click', () => {
            new AMap.InfoWindow({
              content: `<div style="color:#222;font-size:13px;font-weight:bold;padding:2px 4px;">Day ${ds.day.daySeq}-${seq} · ${it.poi!.name}</div><div style="color:#555;font-size:12px;padding:2px 4px;">${it.note || ''}</div>`,
              offset: new AMap.Pixel(0, -30),
            }).open(map, pos);
          });
          map.add(marker);
          allPositions.push(pos);
          path.push(pos);
        }
      });

      // V6.2:同天相邻景点带箭头连线(方向标识)
      if (path.length >= 2) {
        map.add(new AMap.Polyline({
          path, strokeColor: color, strokeWeight: 5, strokeOpacity: 0.85,
          lineJoin: 'round', isOutline: true, outlineColor: 'rgba(0,0,0,0.3)', borderWeight: 1,
          showDir: true, dirColor: color, dirStrokeColor: '#ffffff',
        }));
      }
    });

    // 稳健的每日 POI / 锚点提取器(首/末「有坐标 POI」,而非首/末 item,避免 buffer/交通节点截断主线)
    const poiOf = (ds: typeof summaries[number]) => (ds?.items || []).filter((it) => it.poi && it.poi.lng !== 0 && it.poi.lat !== 0);
    const firstPoiOf = (ds: typeof summaries[number]) => poiOf(ds)[0]?.poi;
    const lastPoiOf = (ds: typeof summaries[number]) => { const a = poiOf(ds); return a[a.length - 1]?.poi; };
    const anchorOf = (ds: typeof summaries[number], preferLast: boolean) => {
      const items = preferLast ? [...(ds?.items || [])].reverse() : (ds?.items || []);
      return items.find((it) => it.itemType === 'hotel' && it.poi && it.poi.lng !== 0 && it.poi.lat !== 0)?.poi
        || (preferLast ? lastPoiOf(ds) : firstPoiOf(ds));
    };
    const poiDays = summaries.filter((ds) => poiOf(ds).length > 0); // 有景点坐标的天(空天被桥接跳过)

    // 跨天虚线:相邻「有 POI 的天」首尾相连,空天/纯交通天自动桥接
    for (let i = 0; i < poiDays.length - 1; i++) {
      const from = lastPoiOf(poiDays[i]); const to = firstPoiOf(poiDays[i + 1]);
      if (!from || !to) continue;
      map.add(new AMap.Polyline({
        path: [[from.lng, from.lat], [to.lng, to.lat]],
        strokeColor: '#ffffff', strokeWeight: 2, strokeOpacity: 0.4,
        strokeStyle: 'dashed', lineDash: [4, 8],
      }));
    }

    // 机场段:到达机场 ↔ 首「有锚点」天,末「有锚点」天 ↔ 返程机场(橙色粗线);锚点桥接到最近有景点的天
    const ap = airportsRef.current;
    const firstA = poiDays[0], lastA = poiDays[poiDays.length - 1];
    const drawAirportLeg = (air: { lng: number; lat: number }, anchor: import('../types').Poi | undefined, dir: 'in' | 'out') => {
      // 机场标记只要有坐标就画,确保赶飞机日也能在地图上看到机场
      allPositions.push([air.lng, air.lat]);
      map.add(new AMap.Marker({
        position: [air.lng, air.lat],
        content: `<div style="background:#ffa07a;color:#1a1a2e;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.5);">✈️ 机场</div>`,
      }));
      // 连线仅在存在锚点(酒店/景点)时画;无锚点(纯赶飞机日)→ 桥接到最近有景点天
      if (!anchor) return;
      map.add(new AMap.Polyline({
        path: dir === 'in' ? [[air.lng, air.lat], [anchor.lng, anchor.lat]] : [[anchor.lng, anchor.lat], [air.lng, air.lat]],
        strokeColor: '#ffa07a', strokeWeight: 3, strokeOpacity: 0.7, strokeStyle: 'dashed', lineDash: [6, 6],
      }));
    };
    if (ap.arr) drawAirportLeg(ap.arr, firstA ? anchorOf(firstA, false) : undefined, 'in');
    if (ap.dep) drawAirportLeg(ap.dep, lastA ? anchorOf(lastA, true) : undefined, 'out');

    if (import.meta.env.DEV) console.log(`[地图] 渲染: ${allPositions.length} 个点`);
    if (allPositions.length > 0) {
      // 手动计算视野边界(比 setFitView(null) 可靠)
      const bounds = allPositions.reduce<[number[], number[]]>(
        (acc, p) => {
          acc[0][0] = Math.min(acc[0][0], p[0]); acc[0][1] = Math.min(acc[0][1], p[1]);
          acc[1][0] = Math.max(acc[1][0], p[0]); acc[1][1] = Math.max(acc[1][1], p[1]);
          return acc;
        },
        [[Infinity, Infinity], [-Infinity, -Infinity]],
      );
      const sw = new AMap.LngLat(bounds[0][0], bounds[0][1]);
      const ne = new AMap.LngLat(bounds[1][0], bounds[1][1]);
      map.setBounds(new AMap.Bounds(sw, ne), false, [80, 80, 80, 80]);
    } else if (!mapError) {
      map.setCenter([105.0, 35.0]);
      map.setZoom(5);
    }
  };

  const flyTo = (lng: number, lat: number, zoom = 14) => {
    if (!mapRef.current) return;
    mapRef.current.setZoomAndCenter(zoom, [lng, lat]);
  };

  // V6.2b:聚焦某个景点(左侧列表点击) — 定位 + 高亮标记
  const focusPoi = async (itemId: string) => {
    if (!mapRef.current) return;
    // 找到该 item 的 poi 坐标
    for (const ds of daySummariesRef.current) {
      const it = ds.items.find((x) => x.id === itemId);
      if (it?.poi && it.poi.lng !== 0 && it.poi.lat !== 0) {
        flyTo(it.poi.lng, it.poi.lat, 14);
        // 临时高亮:黄色呼吸式描边圈(透明填充,不遮挡编号)
        clearTempMarker();
        const AMap = (window as any).AMap;
        const icon = new AMap.CircleMarker({
          center: [it.poi.lng, it.poi.lat],
          radius: 24, fillColor: '#ffd166', fillOpacity: 0.1,
          strokeColor: '#ffd166', strokeWeight: 5,
        });
        mapRef.current.add(icon);
        tempMarkerRef.current = icon;
        new AMap.InfoWindow({
          content: `<div style="color:#222;font-size:14px;font-weight:bold;padding:2px 4px;">${it.poi.name}</div><div style="color:#555;font-size:12px;padding:2px 4px;">${it.note || ''}</div>`,
          offset: new AMap.Pixel(0, -20),
        }).open(mapRef.current, [it.poi.lng, it.poi.lat]);
        return;
      }
    }
  };

  const setTempMarker = (lng: number, lat: number) => {
    if (!mapRef.current) return;
    const AMap = window.AMap;
    if (tempMarkerRef.current) mapRef.current.remove(tempMarkerRef.current);
    tempMarkerRef.current = new AMap.CircleMarker({
      center: [lng, lat], radius: 16, fillColor: '#fff', fillOpacity: 0.3,
      strokeColor: '#ffd166', strokeWeight: 3,
    });
    mapRef.current.add(tempMarkerRef.current);
    flyTo(lng, lat, 14);
  };

  const clearTempMarker = () => {
    if (mapRef.current && tempMarkerRef.current) {
      mapRef.current.remove(tempMarkerRef.current);
      tempMarkerRef.current = null;
    }
  };

  // ── 单日常用工具 ──
  const handleOptimizeDay = async (day: ItineraryDay, items: (ItineraryItem & { poi?: Poi })[], silent = false) => {
    const poiItems = items.filter((it) => it.poi && it.poi.lng !== 0 && it.poi.lat !== 0);
    if (poiItems.length < 2) { if (!silent) alert('至少需要 2 个有坐标的景点'); return; }

    const n = poiItems.length;
    const durationMatrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    const tasks: { i: number; j: number; fromLng: number; fromLat: number; toLng: number; toLat: number }[] = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        tasks.push({
          i, j,
          fromLng: poiItems[i].poi!.lng, fromLat: poiItems[i].poi!.lat,
          toLng: poiItems[j].poi!.lng, toLat: poiItems[j].poi!.lat,
        });
      }
    }

    const BATCH = 5;
    for (let b = 0; b < tasks.length; b += BATCH) {
      const batch = tasks.slice(b, b + BATCH);
      const results = await Promise.all(batch.map(async (t) => {
        try { return await getDuration([t.fromLng, t.fromLat], [t.toLng, t.toLat], 'walk'); } catch { return { durationMin: 15 }; }
      }));
      batch.forEach((t, idx) => { durationMatrix[t.i][t.j] = results[idx].durationMin; });
    }

    const duration = (i: number, j: number) => durationMatrix[i]?.[j] ?? 15;
    const result = solveTsp({ count: n, duration });
    const saved = savings(poiItems.map((_, i) => i), result.order, duration);

    if (saved <= 0) { if (!silent) alert('当前顺序已是最优路径，无需优化'); return; }
    if (!silent && !confirm(`预计节省 ${saved} 分钟，确认优化？`)) return;

    // 应用新顺序
    for (let i = 0; i < result.order.length; i++) {
      const item = poiItems[result.order[i]];
      if (item && item.orderSeq !== i) await db.moveItem(day.id, item.id, i);
    }
    await load();
  };

  // ── 单日行程时长统计(V6.2):按距离+交通方式智能计算路上时间 + 游览时间 ──
  const calcDayTiming = (
    ds: { items: (ItineraryItem & { poi?: Poi })[] },
  ): { driveMin: number; visitMin: number } => {
    // 按每个节点的 transportMode 决定该段通勤速度
    const pois = ds.items
      .filter((it) => it.poi && it.poi.lng !== 0 && it.poi.lat !== 0);
    let driveMin = 0;
    for (let i = 0; i < pois.length - 1; i++) {
      const a = pois[i].poi!; const b = pois[i + 1].poi!;
      const mode = pois[i + 1].transportMode || 'walk';
      const km = haversineKm(a.lng, a.lat, b.lng, b.lat);
      // 智能选速:距离决定合理通勤(跨城 walk 会被强制升到驾车/火车,避免 89h 这类离谱值)
      const speedKmh = smartTransportSpeed(mode, km);
      driveMin += Math.round((km / speedKmh) * 60);
    }
    const visitMin = ds.items.reduce((s, it) => s + (it.visitMinutes ?? 0), 0);
    return { driveMin, visitMin };
  };

  const fmtMin = (min: number) =>
    min >= 60 ? `${Math.floor(min / 60)}h${min % 60 ? `${min % 60}m` : ''}` : `${min}m`;

  // V6.2 交通方式 → 预估速度(km/h),用于时长粗算
  const transportSpeedKmh = (mode: TransportMode): number => {
    switch (mode) {
      case 'drive': return 60;      // 自驾/打车城区
      case 'transit': return 30;    // 公交/地铁
      case 'train': return 250;     // 高铁
      case 'flight': return 800;    // 飞机
      default: return 5;            // 步行
    }
  };

  // V6.2b:智能选速——按距离修正不合理的交通方式(跨城步行→升为驾车/火车)
  const smartTransportSpeed = (mode: TransportMode, km: number): number => {
    // 步行 >15km 不合理,自动升为驾车
    if (mode === 'walk' && km > 15) return 60;
    // 驾车 >300km 不合理,自动升为火车
    if (mode === 'drive' && km > 300) return 250;
    // 公交 >50km 不合理,升为火车
    if (mode === 'transit' && km > 50) return 250;
    return transportSpeedKmh(mode);
  };

  // ── 全局顺路优化(V6.0):跨天防折返 + 全程最短 ──
  // ── 全局顺路优化预览状态 ──
  const [optimizePreview, setOptimizePreview] = useState<{
    savedMin: number;
    moves: Array<{ poiName: string; fromDay: number; toDay: number }>;
    chain: Array<{ name: string; day: number }>;
  } | null>(null);

  // ── 全局优化:起点终点选择 ──
  const [optimizeSetup, setOptimizeSetup] = useState<{
    // 引擎输入:每天锚点骨架 + 全部景点(带城市)
    days: DayAnchor[];
    pois: ItineraryPoi[];
    startIdx: number; // 起点=某天锚点 在 days 的索引
    endIdx: number;   // 终点=某天锚点 在 days 的索引
  } | null>(null);

  /** 提取每天锚点:优先酒店,无酒店用当天第一个有坐标景点;city 用当天景点兜底(同城必然);返回引擎 DayAnchor */
  const getDayAnchors = async (): Promise<DayAnchor[]> => {
    const anchors: DayAnchor[] = [];
    for (const ds of daySummaries) {
      // 当天景点的 city 兜底(代表该地城市,酒店与景点必然同城)
      const dayCity = ds.items.find((it) => it.poi?.city)?.poi?.city;
      const hotelItem = ds.items.find((it) => it.itemType === 'hotel' && it.poi && it.poi.lng !== 0 && it.poi.lat !== 0);
      if (hotelItem?.poi) {
        anchors.push({ daySeq: ds.day.daySeq, dayId: ds.day.id, poi: hotelItem.poi, fromHotel: true, city: hotelItem.poi.city || dayCity });
        continue;
      }
      const poiItem = ds.items.find((it) => it.itemType !== 'hotel' && it.poi && it.poi.lng !== 0 && it.poi.lat !== 0);
      if (poiItem?.poi) {
        anchors.push({ daySeq: ds.day.daySeq, dayId: ds.day.id, poi: poiItem.poi, fromHotel: false, city: poiItem.poi.city || dayCity });
        continue;
      }
      // 仅大交通的天(如回程日):用机场/车站坐标兜底,使该天可选为起点/终点
      const dayTrans = dayTransports(transports, ds.day.date);
      let hub: [number, number] | null = null;
      let hubName = '';
      for (const t of dayTrans) {
        const c = await resolveTransportHubCoord(t.toPlace ?? '', t.mode)
          ?? await resolveTransportHubCoord(t.fromPlace ?? '', t.mode);
        if (c) { hub = c; hubName = t.toPlace || t.fromPlace || ''; break; }
      }
      if (hub) {
        anchors.push({ daySeq: ds.day.daySeq, dayId: ds.day.id, poi: { id: `hub-${ds.day.date}`, name: hubName || '交通枢纽', lng: hub[0], lat: hub[1], category: 'poi' }, fromHotel: false, city: dayCity });
      }
    }
    return anchors;
  };

  /** 清洗景点名用于搜索:去括号/去噪音词 */
  const cleanPoiName = (name: string): string => {
    let n = name
      .replace(/[（(].*?[)）]/g, '')      // 去括号内容
      .replace(/抵达|睡到自然醒|出发|看日落|拍照|吃瓜|骑骆驼/g, '')
      .replace(/^[\s·+]+|[\s·+]+$/g, '')
      .split(/[+＋]/)[0]                  // 复合名取第一个(如"黑独山+胭脂山"取"黑独山")
      .trim();
    if (!n && name) n = name.split(/[+＋]/)[0].trim();
    return n;
  };

  /** 逆地理绑定城市(不动坐标,避免误覆盖正确坐标);只对没有 city 的补(不受 fixed 限制) */
  const enrichPoiCities = async (pois: Array<{ poi: Poi; daySeq: number; itemId: string }>): Promise<void> => {
    // 关键:只要没有 city 就补,不能因 fixed 跳过(否则优化过一次后 city 永远空,引擎失效)
    const toFix = pois.filter((p) => !p.poi.city);
    if (toFix.length === 0) return;
    // 并发(限 5,防高德频控)
    const BATCH = 5;
    for (let b = 0; b < toFix.length; b += BATCH) {
      const batch = toFix.slice(b, b + BATCH);
      await Promise.all(batch.map(async (p) => {
        const fixedPoi = { ...p.poi, fixed: true as const };
        try {
          // 仅逆地理绑定城市,保留原坐标(坐标精度是地图正确性的命脉)
          const city = await reverseGeocode(p.poi.lng, p.poi.lat);
          if (city) fixedPoi.city = city;
        } catch { /* 保底:标记 fixed 避免重复 */ }
        await db.upsertPoi(fixedPoi).catch(() => {});
      }));
    }
  };

  /** 打开起点终点选择面板 */
  const handleGlobalOptimize = async () => {
    if (!id) return;
    // 1. 收集所有景点 + 酒店(酒店也需逆地理绑定城市,作为该天锚点城市)
    const rawPois: Array<{ poi: Poi; daySeq: number; itemId: string }> = [];
    for (const ds of daySummaries) {
      for (const it of ds.items) {
        if (it.poi && it.poi.lng !== 0 && it.poi.lat !== 0) {
          rawPois.push({ poi: it.poi, daySeq: ds.day.daySeq, itemId: it.id });
        }
      }
    }
    if (rawPois.length < 2) {
      alert(`当前只有 ${rawPois.length} 个带坐标的景点(需≥2)。\n请先在行程中添加景点,或检查景点坐标是否有效。`);
      return;
    }
    // 2. 先逆地理纠错(写库,填充 poi.city + 修坐标)
    await enrichPoiCities(rawPois);
    // 3. 刷新数据,让 daySummaries 里的 poi 带最新 city
    await load();
    // 4. 纠错后再取 anchors(此时有 city)
    const dayAnchors = await getDayAnchors();
    if (dayAnchors.length < 2) {
      alert('需要有至少 2 天可作为起点/终点锚点。\n请为至少 2 天添加带坐标的景点、酒店,或往返大交通。');
      return;
    }
    // 5. 重新加载景点(酒店纠错仅用于锚点城市,不入引擎分配;过滤 non-poi)
    const reloaded: ItineraryPoi[] = [];
    for (const ds of daySummaries) {
      for (const it of ds.items) {
        if (it.itemType === 'hotel' || !it.poi || it.poi.lng === 0 || it.poi.lat === 0) continue;
        const fresh = await db.getPoi(it.poi.id).catch(() => null);
        const p = fresh ?? it.poi;
        reloaded.push({ id: it.poi.id, poi: p, city: p.city, srcDaySeq: ds.day.daySeq });
      }
    }
    // 默认:起点=第一天锚点,终点=最后一天锚点
    if (import.meta.env.DEV) {
      console.log('%c[诊断] 引擎输入', 'color:#ff9800;font-weight:bold');
      console.log('  days:', dayAnchors.map(d => `D${d.daySeq}:${d.city || '∅'}(${d.poi.name})`).join(' | '));
      console.log('  pois:', reloaded.map(p => `${p.poi.name}[${p.city || '∅'}]`).join(' | '));
    }
    setOptimizeSetup({ days: dayAnchors, pois: reloaded, startIdx: 0, endIdx: dayAnchors.length - 1 });
  };

  /** 基于选定的起点终点计算优化预览(引擎:城市硬约束+连住平摊) */
  const computeOptimizePreview = async () => {
    if (!optimizeSetup || !id) return;
    const { days, pois, startIdx, endIdx } = optimizeSetup;
    if (startIdx === endIdx) { alert('起点和终点天不能相同'); return; }
    if (startIdx < 0 || endIdx < 0 || startIdx >= days.length || endIdx >= days.length) { alert('请选择有效的起点/终点天'); return; }

    try {
      const startDay = days[startIdx].daySeq;
      const endDay = days[endIdx].daySeq;
      const startMark = days[startIdx].fromHotel ? '🏨' : '📍';
      const endMark = days[endIdx].fromHotel ? '🏨' : '📍';

      // V6.3 第4步:过渡日(换城市的天)获取驾车路径,供引擎做顺路校验
      const transitionRoutes: Record<number, [number, number][]> = {};
      const anchorByDay = new Map<number, Poi>();
      days.forEach((d) => anchorByDay.set(d.daySeq, d.poi));
      const sortedDays = days.map((d) => d.daySeq).sort((a, b) => a - b);
      for (let i = 1; i < sortedDays.length; i++) {
        const prev = anchorByDay.get(sortedDays[i - 1]);
        const cur = anchorByDay.get(sortedDays[i]);
        if (prev && cur) {
          // 换城市的天(距离>80km 视为过渡日) → 调驾车路径
          const dist = haversineKm(prev.lng, prev.lat, cur.lng, cur.lat);
          if (dist > 80) {
            transitionRoutes[sortedDays[i]] = await getDrivingPath([prev.lng, prev.lat], [cur.lng, cur.lat]);
          }
        }
      }

      // V6.3.3 动态容量:基于返程/去程大交通 mode+起抵时间估算;找不到→按普通天容量2
      // 注意:此处 days 已被 optimizeSetup.days(DayAnchor[])遮蔽,日期/startTime 取自 daySummaries
      const dateBySeq = new Map(daySummaries.map((ds) => [ds.day.daySeq, ds.day.date]));
      const dayBySeq = new Map(daySummaries.map((ds) => [ds.day.daySeq, ds.day]));
      const transports = await db.listTransports(id);
      const poiMins = daySummaries
        .flatMap((ds) => ds.items)
        .filter((it) => it.itemType === 'poi' && it.visitMinutes)
        .map((it) => it.visitMinutes!);
      const avgPoiMin = Math.min(180, Math.max(60,
        (poiMins.length ? poiMins.reduce((a, b) => a + b, 0) / poiMins.length : 90) + 30));
      // 游玩时长表:poiId → visitMinutes(缺省 90)
      const visitMap: Record<string, number> = {};
      daySummaries.flatMap((ds) => ds.items).forEach((it) => {
        if (it.itemType === 'poi' && it.poiId && it.visitMinutes) visitMap[it.poiId] = it.visitMinutes;
      });
      const forbiddenDays: Record<string, number[]> = {}; // V6.3.5 距离感知:不可达景点禁配天
      const coordOf = (x: any): [number, number] | null =>
        !x ? null
          : Array.isArray(x) ? (x[0] && x[1] ? [x[0], x[1]] : null)
          : (x.lng && x.lat && x.lng !== 0 && x.lat !== 0 ? [x.lng, x.lat] : null);

      // V6.3.5 距离感知容量(H→P→A):回程=酒店→景点→机场,出发=机场→景点→酒店;
      // 枢纽坐标优先地理编码(t.fromPlace/toPlace),缺则回退当天酒店锚点;都缺→回退 estimateDayCapacity
      const computeOne = async (ds: number, seg: 'depart' | 'return') => {
        const date = dateBySeq.get(ds);
        if (!date) return 2;
        const day = dayBySeq.get(ds);
        const t = seg === 'return'
          ? findReturnTransport(transports, date)
          : findDepartTransport(transports, date);
        const dayStart = day?.startTime ?? '09:00';
        const dayEnd = day?.endTime ?? '20:00';
        const win = t ? dayWindowMin({ segType: seg, transport: t, dayStart, dayEnd }) : null;
        const anchorCoord = coordOf(seg === 'return' ? days[endIdx].poi : days[startIdx].poi);
        const aHub = t ? await resolveTransportHubCoord(seg === 'return' ? (t.fromPlace ?? '') : (t.toPlace ?? ''), t.mode) : null;
        if (!t || win === null || (!anchorCoord && !aHub)) {
          return estimateDayCapacity({ segType: seg, transport: t, dayStart, dayEnd, avgPoiMin });
        }
        const startCoord = seg === 'return' ? (anchorCoord ?? aHub) : (aHub ?? anchorCoord);
        const endCoord = seg === 'return' ? (aHub ?? anchorCoord) : (anchorCoord ?? aHub);
        if (!startCoord || !endCoord) {
          return estimateDayCapacity({ segType: seg, transport: t, dayStart, dayEnd, avgPoiMin });
        }
        // 候选 = 距「当天所在地(锚点)」≤120km 且有坐标的景点
        const center: [number, number] = (anchorCoord ?? aHub)!;
        const candidates = pois.filter((p) => p.poi.lng && p.poi.lat &&
          haversineKm(p.poi.lng, p.poi.lat, center[0], center[1]) <= 120);
        if (win <= 0) { // 纯赶路日:容量 0,所有候选禁配该天
          candidates.forEach((p) => { forbiddenDays[p.id] = [...(forbiddenDays[p.id] ?? []), ds]; });
          return 0;
        }
        // H→P→A 两段驾车时长,批量并发≤5;各段失败独立回退 haversineKm/40*60
        const est = (coord: [number, number], p: typeof pois[number]) =>
          Math.max(8, Math.round((haversineKm(p.poi.lng, p.poi.lat, coord[0], coord[1]) / 40) * 60));
        const pathList: Array<{ id: string; pathMin: number }> = [];
        for (let b = 0; b < candidates.length; b += 5) {
          const batch = candidates.slice(b, b + 5);
          const vals = await Promise.all(batch.map(async (p) => {
            const a = await getDuration(startCoord, [p.poi.lng, p.poi.lat], 'drive')
              .then((r) => r.durationMin).catch(() => est(startCoord, p));
            const c = await getDuration([p.poi.lng, p.poi.lat], endCoord, 'drive')
              .then((r) => r.durationMin).catch(() => est(endCoord, p));
            return a + c;
          }));
          batch.forEach((p, i) => pathList.push({ id: p.id, pathMin: vals[i] }));
        }
        const { capacity, reachableIds } = estimateReachablePois({
          candidates: pathList.map((c) => ({ id: c.id, pathMin: c.pathMin, visitMin: visitMap[c.id] ?? 90 })),
          windowMin: win,
        });
        // 不可达候选 → 禁配该天
        candidates.forEach((p) => { if (!reachableIds.includes(p.id)) forbiddenDays[p.id] = [...(forbiddenDays[p.id] ?? []), ds]; });
        return capacity;
      };
      const dayCapacity: Record<number, number> = {};
      for (const ds of sortedDays) {
        dayCapacity[ds] = ds === startDay ? await computeOne(ds, 'depart')
          : ds === endDay ? await computeOne(ds, 'return') : 2;
      }

      // 调引擎:地理距离归属 + 连住平摊(按天容量) + 距离感知禁配 + 过渡日顺路校验
      const result = optimizeItinerary({
        days,
        pois,
        maxPerDay: 2,
        dayCapacity,
        forbiddenDays,
        transitionRoutes,
        routeDeviationKm: 30,
      });

      // 诊断:输出引擎分配结果(仅 DEV)
      if (import.meta.env.DEV) {
        console.log('%c[诊断] 引擎分配', 'color:#4caf50;font-weight:bold');
        console.log('  forbidden:', Object.entries(forbiddenDays).map(([id, dsList]) => {
          const p = pois.find((x) => x.id === id);
          return `${p?.poi.name || id}禁D${dsList.join('/D')}`;
        }).join(', ') || '无');
        console.log('  assignments:', result.assignments.map(a => {
          const p = pois.find((x) => x.id === a.poiId);
          return `${p?.poi.name || a.poiId} → Day${a.daySeq}${p && p.srcDaySeq !== a.daySeq ? `(原D${p.srcDaySeq}已移动)` : ''}`;
        }).join(' | '));
        console.log('  unassigned:', result.unassigned.map(u => u.name).join(', ') || '无');
      }

      // 收集未分配警告
      if (result.unassigned.length > 0) {
        const names = result.unassigned.slice(0, 3).map((u) => `「${u.name}」`).join('');
        alert(`⚠️ 部分景点无法分配:${names}${result.unassigned.length > 3 ? ` 等${result.unassigned.length}个` : ''}\n请检查这些景点的城市归属或坐标。`);
      }

      // 构建移动清单:对比原 daySeq 与优化后 daySeq
      const moves: Array<{ poiName: string; fromDay: number; toDay: number }> = [];
      for (const a of result.assignments) {
        const p = pois.find((x) => x.id === a.poiId);
        if (!p) continue;
        if (p.srcDaySeq !== a.daySeq) {
          moves.push({ poiName: p.poi.name, fromDay: p.srcDaySeq, toDay: a.daySeq });
        }
      }

      // 估算节省:当前锚点距离 vs 优化后锚点距离
      const d2m = (a: Poi, b: Poi) => Math.max(8, Math.round((haversineKm(a.lng, a.lat, b.lng, b.lat) / 40) * 60));
      const dayDistance = (poi: Poi, daySeq: number) => {
        const a = anchorByDay.get(daySeq);
        return a ? d2m(a, poi) : 0;
      };
      const curDist = pois.reduce((s, p) => s + dayDistance(p.poi, p.srcDaySeq), 0);
      const optDist = result.assignments.reduce((s, a) => {
        const p = pois.find((x) => x.id === a.poiId);
        return s + (p ? dayDistance(p.poi, a.daySeq) : 0);
      }, 0);
      const saved = Math.max(0, curDist - optDist);

      // 构建 chain:起点 → 各天景点 → 终点
      const byDay = new Map<number, string[]>();
      result.assignments.forEach((a) => {
        const p = pois.find((x) => x.id === a.poiId);
        if (p) {
          const arr = byDay.get(a.daySeq) ?? [];
          arr.push(p.poi.name);
          byDay.set(a.daySeq, arr);
        }
      });
      // 机场作为行程真正起点/终点:到达机场(去程 toPlace)与返程机场(返程 fromPlace)
      const departT = findDepartTransport(transports, dateBySeq.get(startDay) ?? '');
      const returnT = findReturnTransport(transports, dateBySeq.get(endDay) ?? '');
      const arrHub = departT ? await resolveTransportHubCoord(departT.toPlace ?? '', departT.mode) : null;
      const depHub = returnT ? await resolveTransportHubCoord(returnT.fromPlace ?? '', returnT.mode) : null;

      // 构建 chain:✈️到达机场 → 起点 → 各天景点 → 终点 → ✈️返程机场
      const chain: Array<{ name: string; day: number }> = [];
      if (arrHub) chain.push({ name: `✈️ ${departT!.toPlace}`, day: startDay });
      sortedDays.forEach((ds) => {
        if (ds === startDay) chain.push({ name: `${startMark}${days[startIdx].poi.name}`, day: ds });
        (byDay.get(ds) || []).forEach((n) => chain.push({ name: n, day: ds }));
        if (ds === endDay) chain.push({ name: `${endMark}${days[endIdx].poi.name}`, day: ds });
      });
      if (depHub) chain.push({ name: `✈️ ${returnT!.fromPlace}`, day: endDay });

      setOptimizePreview({ savedMin: saved, moves, chain });
      setOptimizeSetup(null);
    } catch (e: any) {
      console.error('优化计算出错:', e);
      alert('优化计算出错: ' + (e?.message || '未知错误'));
    }
  };

  /** 应用已确认的全局优化(起点终点不动,仅移动中间景点) */

  const applyGlobalOptimize = async () => {
    if (!id || !optimizePreview) return;
    // 预览已算出移动清单(preview.moves: poiName / fromDay / toDay),按它执行
    const moves = optimizePreview.moves;
    if (moves.length === 0) { alert('无需移动(各景点已在最合适日期)'); setOptimizePreview(null); return; }

    const seen = new Set<string>();
    let moved = 0;
    for (const mv of moves) {
      const srcDs = daySummaries.find((ds) => ds.items.some((it) => it.poi?.name === mv.poiName));
      const orig = srcDs?.items.find((it) => it.poi?.name === mv.poiName);
      if (!orig) continue;
      // 按名字匹配可能不准,优先用 poi.name 精确匹配唯一 item
      const itemToMove = srcDs?.items.find((it) => it.poi?.name === mv.poiName && !seen.has(it.id));
      if (!itemToMove) continue;
      seen.add(itemToMove.id);
      const targetDay = daySummaries.find((ds) => ds.day.daySeq === mv.toDay)?.day;
      if (!targetDay) continue;
      await db.removeItem(itemToMove.id);
      await db.addItem({
        dayId: targetDay.id,
        poiId: itemToMove.poiId,
        itemType: itemToMove.itemType,
        transportMode: itemToMove.transportMode,
        note: itemToMove.note,
        visitMinutes: itemToMove.visitMinutes,
      });
      moved++;
    }

    if (moved === 0) { alert('未找到需要移动的景点'); setOptimizePreview(null); return; }

    // 每个有酒店的天内部再顺路优化一遍(静默)
    for (const ds of daySummaries) {
      const freshItems = await db.listItems(ds.day.id);
      const freshPois = await Promise.all(freshItems.map(async (it) => ({ ...it, poi: it.poiId ? await db.getPoi(it.poiId) ?? undefined : undefined })));
      if (freshPois.filter((x) => x.poi).length >= 2) await handleOptimizeDay(ds.day, freshPois, true);
    }

    await load();
    setOptimizePreview(null);
    alert(`✅ 全局优化已保存:${moved} 个景点按「最近酒店」重新归位,酒店住宿不变。`);
  };

  /** 复制优化后的行程到新旅程(不改当前行程) */
  /** 复制优化后的行程到新旅程(不改当前行程):包含所有景点+酒店,被移动的项用优化后daySeq */
  const copyOptimizedToNewTrip = async () => {
    if (!trip) return;
    const title = prompt('新旅程标题:', `${trip.title}(优化版)`);
    if (title === null) return;

    // 构建移动映射:poiName -> toDay (从 moves 提取)
    const moveMap = new Map<string, number>();
    if (optimizePreview) {
      for (const mv of optimizePreview.moves) {
        moveMap.set(mv.poiName, mv.toDay);
      }
    }

    try {
      // 1. 创建新旅程(自动生成天数骨架)
      const newTrip = await db.createTrip({
        title,
        destination: trip.destination,
        startDate: trip.startDate,
        endDate: trip.endDate,
        companionCount: trip.companionCount,
        currency: trip.currency,
        cityNodes: trip.cityNodes,
      });
      const newDays = await db.listDays(newTrip.id);

      // 2. 遍历当前所有天的所有景点+酒店,按优化后的daySeq写入
      let copiedItems = 0;
      const usedDaySeqs = new Set<number>();
      for (const ds of daySummaries) {
        for (const it of ds.items) {
          // 计算目标daySeq:被移动的项用moveMap,其余保持原daySeq
          const targetDaySeq = (it.poi?.name && moveMap.has(it.poi.name)) ? moveMap.get(it.poi.name)! : ds.day.daySeq;
          usedDaySeqs.add(targetDaySeq);
          const targetDay = newDays.find((nd) => nd.daySeq === targetDaySeq);
          if (!targetDay) continue;

          // 写入POI
          const poiId = it.poiId || crypto.randomUUID();
          if (it.poi) await db.upsertPoi({ ...it.poi, id: poiId });

          // 写入行程项
          await db.addItem({
            dayId: targetDay.id,
            poiId,
            itemType: it.itemType,
            transportMode: it.transportMode,
            note: it.note,
            visitMinutes: it.visitMinutes,
          });
          copiedItems++;

          // 如果是酒店,同时写入 hotels 表
          if (it.itemType === 'hotel' && it.poi?.lng && it.poi?.lat) {
            await db.addHotel({
              tripId: newTrip.id,
              name: it.poi.name,
              address: it.poi.address,
              lng: it.poi.lng,
              lat: it.poi.lat,
              checkIn: targetDay.date,
              checkOut: targetDay.date,
              poiId,
            });
          }
        }
      }

      if (copiedItems === 0) { alert('暂无可复制的景点'); await db.deleteTrip(newTrip.id); return; }

      // 3. 删除新旅程中的空天
      for (const nd of [...newDays]) {
        if (!usedDaySeqs.has(nd.daySeq)) await db.removeDay(nd.id).catch(() => {});
      }

      // 4. 天内部顺路优化(静默)
      const remainingDays = await db.listDays(newTrip.id);
      for (const rd of remainingDays) {
        const freshItems = await db.listItems(rd.id);
        const freshPois = await Promise.all(freshItems.map(async (it) => ({ ...it, poi: it.poiId ? await db.getPoi(it.poiId) ?? undefined : undefined })));
        if (freshPois.filter((x) => x.poi).length >= 2) await handleOptimizeDay(rd, freshPois, true);
      }

      setOptimizePreview(null);
      const ok = confirm(`✅ 已创建新旅程「${title}」:共 ${copiedItems} 个景点+酒店。是否立即打开查看?`);
      if (ok) navigate(`/trip/${newTrip.id}`);
    } catch (e: any) {
      alert('复制失败: ' + (e?.message || '未知错误'));
    }
  };

  // ── 景点级操作(V6.0):单独删除/修改某个景点 ──
  const handleRemoveItem = async (itemId: string) => {
    if (!confirm('确定删除这个景点？')) return;
    await db.removeItem(itemId);
    // V6.2 联动:删除关联记账
    if (id) {
      const exps = await db.listExpenses(id);
      const linked = exps.filter((e) => e.refId === itemId);
      for (const e of linked) await db.removeExpense(e.id);
    }
    await load();
  };

  /** 打开「修改」弹窗,并预取关联门票金额 */
  const openItemEdit = async (item: ItineraryItem) => {
    if (id) {
      const exps = await db.listExpenses(id);
      const linked = exps.find((e) => e.refType === 'itinerary_item' && e.refId === item.id && e.category === 'ticket');
      setLinkedTicket(linked?.amount);
    }
    setEditingItem(item);
  };

  /** 保存「修改」:批量更新 item + 门票 + 更换景点 */
  const handleSaveItemEdit = async (item: ItineraryItem, patch: EditPatch) => {
    if (!id || !trip) return;
    const { itemPatch, upsertPoi } = buildItemPatch(item, patch);
    if (upsertPoi) await db.upsertPoi(upsertPoi);
    await db.updateItem(item.id, itemPatch);
    if (patch.ticket != null) {
      const act = ticketAction(await db.listExpenses(id), item, patch.ticket, trip, days.find((d) => d.id === item.dayId)?.date);
      if (act.kind === 'update') await db.updateExpense(act.id, { amount: act.amount });
      else if (act.kind === 'add') await db.addExpense(act.exp);
    }
    await load();
    setEditingItem(null);
  };

  // ── V6.2b 拖拽排序 ──
  const handleDragStart = (itemId: string, fromDayId: string) => (e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', itemId);
    e.dataTransfer.effectAllowed = 'move';
    setDragItem({ itemId, fromDayId });
  };

  const handleDragOver = (dayId: string) => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverDayId(dayId);
  };

  const handleDragLeave = () => {
    setDragOverDayId(null);
  };

  // 放置:移动 item 到目标天(同天=排序,跨天=换天)
  const handleDrop = (targetDayId: string, targetOrder: number) => async (e: React.DragEvent) => {
    e.preventDefault();
    const itemId = e.dataTransfer.getData('text/plain') || dragItem?.itemId;
    if (!itemId) return;
    const fromDayId = dragItem?.fromDayId;
    try {
      if (fromDayId === targetDayId) {
        // 同天排序
        await db.moveItem(targetDayId, itemId, targetOrder);
      } else {
        // 跨天移动
        await db.moveItemAcrossDays(itemId, targetDayId, targetOrder);
      }
      await load();
    } catch (err: any) {
      alert('移动失败: ' + (err?.message || '未知错误'));
    } finally {
      setDragItem(null);
      setDragOverDayId(null);
    }
  };

  /** 改大交通起抵时间 */
  const handleEditTransportTime = async (t: Transport) => {
    const depart = prompt('出发时间（yyyy-mm-ddTHH:mm）:', t.departAt.slice(0, 16));
    if (depart === null) return;
    const arrive = prompt('到达时间（yyyy-mm-ddTHH:mm）:', t.arriveAt.slice(0, 16));
    if (arrive === null) return;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(depart) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(arrive)) {
      alert('时间格式错误，应为 yyyy-mm-ddTHH:mm'); return;
    }
    if (depart >= arrive) { alert('到达时间必须晚于出发时间'); return; }
    await db.updateTransport(t.id, { departAt: depart, arriveAt: arrive });
    await load();
  };

  /** 删除大交通(含联动删除关联记账) */
  const handleRemoveTransport = async (t: Transport) => {
    if (!id) return;
    if (!confirm(`确定删除交通（${t.fromPlace ?? ''}→${t.toPlace ?? ''}）？关联记账一并删除`)) return;
    await db.removeTransport(t.id);
    const exps = await db.listExpenses(id);
    for (const e of exps.filter((x) => x.refType === 'transport' && x.refId === t.id)) await db.removeExpense(e.id);
    await load();
  };

  const handleDeleteDay = async (dayId: string) => {
    const ds = daySummaries.find((s) => s.day.id === dayId);
    if (ds && ds.items.length > 0) {
      if (!confirm(`该天已有 ${ds.items.length} 个地点，确定删除？`)) return;
    } else {
      if (!confirm('确定删除此天？')) return;
    }
    await db.removeDay(dayId);
    await load();
    clearAllExpanded();
  };

  const handleAddDay = async () => {
    const input = prompt('请输入新日期（格式：yyyy-mm-dd）');
    if (!input || !/^\d{4}-\d{2}-\d{2}$/.test(input)) {
      if (input) alert('格式错误，请使用 yyyy-mm-dd');
      return;
    }
    await db.addDay(trip?.id!, input);
    await load();
  };

  const handleAdjustDates = () => {
    const start = prompt('修改开始日期（留空不变，格式 yyyy-mm-dd）:', trip?.startDate || '');
    if (start === null) return;
    const end = prompt('修改结束日期（留空不变，格式 yyyy-mm-dd）:', trip?.endDate || '');
    if (end === null) return;
    const patch: Partial<Trip> = {};
    if (start && /^\d{4}-\d{2}-\d{2}$/.test(start)) patch.startDate = start;
    if (end && /^\d{4}-\d{2}-\d{2}$/.test(end)) patch.endDate = end;
    if (Object.keys(patch).length > 0) {
      db.updateTrip(trip!.id, patch);
      load();
    }
  };

  const clearAllExpanded = () => {
    setDetailExpanded({});
    setEditExpanded({});
  };

  // ── 景点搜索 ──
  const handleScenicSearch = async () => {
    if (!scenicKeyword) return;
    setScenicLoading(true); setSelectedScenic(null); setScenicCard(null); clearTempMarker();
    try {
      const city = /青甘|环线|大西北/.test(scenicCity || trip?.destination || '') ? '' : (scenicCity || trip?.destination || '');
      setScenicResults(await searchPoiByJS(scenicKeyword, city));
    } catch (e: any) { alert('搜索失败: ' + e.message); }
    finally { setScenicLoading(false); }
  };

  const handleSelectScenic = async (r: SearchResult) => {
    setSelectedScenic(r); setTempMarker(r.lng, r.lat);
    setScenicCardLoading(true);
    try { setScenicCard(await getPoiCard({ id: r.id, name: r.name, category: 'poi' }, scenicCity || trip?.destination || '')); }
    catch { setScenicCard(null); }
    finally { setScenicCardLoading(false); }
  };

  const handleAddScenic = async () => {
    if (!selectedScenic || !activeDayId || !id) return;
    const day = days.find((d) => d.id === activeDayId);
    await db.upsertPoi({ id: selectedScenic.id, name: selectedScenic.name, lng: selectedScenic.lng, lat: selectedScenic.lat, category: 'poi', address: selectedScenic.address });
    const item = await db.addItem({ dayId: activeDayId, poiId: selectedScenic.id, itemType: 'poi', transportMode: 'walk', note: selectedScenic.name, visitMinutes: scenicCard?.suggestDuration || 90 });
    // V6.2 关联记账:门票价
    const price = parseFloat(ticketPrice);
    if (!isNaN(price) && price > 0 && day) {
      await db.addExpense({
        tripId: id, category: 'ticket', amount: price,
        currency: trip?.currency ?? 'CNY', date: day.date,
        note: `门票 · ${selectedScenic.name}`,
        refType: 'itinerary_item', refId: item.id, dayId: activeDayId,
      });
    }
    setSelectedScenic(null); setScenicCard(null); setScenicResults([]); setScenicKeyword('');
    setTicketPrice('');
    clearTempMarker(); await load();
    // 添加成功后自动关闭编辑面板
    setEditExpanded(prev => ({ ...prev, [activeDayId]: false }));
  };

  // ── 酒店搜索 ──
  const handleHotelSearch = async () => {
    if (!hotelKeyword) return;
    setHotelLoading(true); setSelectedHotel(null); clearTempMarker();
    try {
      const city = /青甘|环线|大西北/.test(hotelCity || trip?.destination || '') ? '' : (hotelCity || trip?.destination || '');
      const results = await searchPoiByJS(hotelKeyword, city);
      setHotelResults(results.filter((r) => r.type.includes('酒店') || r.type.includes('住宿') || r.type.includes('宾馆')));
    } catch (e: any) { alert('搜索失败: ' + e.message); }
    finally { setHotelLoading(false); }
  };

  const handleSelectHotel = (r: SearchResult) => { setSelectedHotel(r); setTempMarker(r.lng, r.lat); };

  const handleAddHotel = async () => {
    if (!selectedHotel || !activeDayId || !id) return;
    const day = days.find((d) => d.id === activeDayId);
    if (!day) return;
    await db.upsertPoi({ id: selectedHotel.id, name: selectedHotel.name, lng: selectedHotel.lng, lat: selectedHotel.lat, category: 'hotel', address: selectedHotel.address });
    const item = await db.addItem({ dayId: activeDayId, poiId: selectedHotel.id, itemType: 'hotel', transportMode: 'walk', note: selectedHotel.name, visitMinutes: 0 });
    await db.addHotel({ tripId: id, name: selectedHotel.name, address: selectedHotel.address, lng: selectedHotel.lng, lat: selectedHotel.lat, checkIn: day.date, checkOut: day.date, poiId: selectedHotel.id });
    // V6.2 关联记账:房价
    const price = parseFloat(hotelPrice);
    if (!isNaN(price) && price > 0) {
      await db.addExpense({
        tripId: id, category: 'hotel', amount: price,
        currency: trip?.currency ?? 'CNY', date: day.date,
        note: `住宿 · ${selectedHotel.name}`,
        refType: 'itinerary_item', refId: item.id, dayId: activeDayId,
      });
    }
    setSelectedHotel(null); setHotelResults([]); setHotelKeyword('');
    setHotelPrice('');
    clearTempMarker(); await load();
    // 添加成功后自动关闭编辑面板
    setEditExpanded(prev => ({ ...prev, [activeDayId]: false }));
  };

  // ── 交通查询 ──
  const handleTransportSearch = async (which: 'from' | 'to', keyword: string) => {
    if (!keyword) return;
    const rawCity = /青甘|环线|大西北/.test(trip?.destination || '') ? '' : (trip?.destination || '');
    try {
      const results = await searchPoiByJS(keyword, rawCity);
      if (results.length === 0) return;
      const r = results[0];
      which === 'from' ? setFromResult(r) : setToResult(r);
      setTempMarker(r.lng, r.lat);
    } catch (e: any) { alert('搜索失败: ' + e.message); }
  };

  const handleQueryRoute = async () => {
    if (!fromResult || !toResult) return;
    setRouteLoading(true);
    try {
      // V6.2:火车/飞机用直线粗估,不调高德(跨城路线高德算不了);顺带预填起抵时间
      if (transportMode === 'train' || transportMode === 'flight') {
        const km = haversineKm(fromResult.lng, fromResult.lat, toResult.lng, toResult.lat);
        const speedKmh = transportSpeedKmh(transportMode);
        const durationMin = Math.round((km / speedKmh) * 60);
        setRouteInfo({ durationMin, distanceM: Math.round(km * 1000) });
        const day = days.find((d) => d.id === activeDayId);
        if (day) {
          const fmtLocal = (d: Date) => {
            const p = (n: number) => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
          };
          const depDt = new Date(`${day.date}T09:00`);
          const arrDt = new Date(depDt.getTime() + durationMin * 60000);
          setTransportDepart(fmtLocal(depDt));
          setTransportArrive(fmtLocal(arrDt));
        }
      } else {
        setRouteInfo(await getDuration([fromResult.lng, fromResult.lat], [toResult.lng, toResult.lat], transportMode));
      }
    } catch (e: any) { alert('路线查询失败: ' + e.message); }
    finally { setRouteLoading(false); }
  };

  const handleAddTransport = async () => {
    if (!fromResult || !toResult || !activeDayId || !id) return;
    const day = days.find((d) => d.id === activeDayId);
    const isBig = transportMode === 'train' || transportMode === 'flight';
    const price = parseFloat(transportPrice);

    if (isBig) {
      // 大交通(火车/飞机):写入 transports 表,引擎与卡片都能读到
      if (!transportDepart || !transportArrive) { alert('请填写起飞/到达时间'); return; }
      if (transportDepart >= transportArrive) { alert('到达时间必须晚于起飞时间'); return; }
      const created = await db.addTransport({
        tripId: id, segType: transportSeg, mode: transportMode as TransportModeType,
        fromPlace: fromResult.name, toPlace: toResult.name,
        departAt: transportDepart, arriveAt: transportArrive,
      });
      if (!isNaN(price) && price > 0 && day) {
        await db.addExpense({
          tripId: id, category: 'transport', amount: price,
          currency: trip?.currency ?? 'CNY', date: transportDepart.slice(0, 10),
          note: `大交通 · ${fromResult.name}→${toResult.name}`,
          refType: 'transport', refId: created.id, dayId: activeDayId,
        });
      }
    } else {
      // 城内通勤(步行/驾车/公交):poi item + note "from→to"
      await db.upsertPoi({ id: fromResult.id, name: fromResult.name, lng: fromResult.lng, lat: fromResult.lat, category: 'poi' });
      const item = await db.addItem({ dayId: activeDayId, poiId: fromResult.id, itemType: 'poi', transportMode, note: `${fromResult.name} → ${toResult.name}`, visitMinutes: 0 });
      if (!isNaN(price) && price > 0 && day) {
        await db.addExpense({
          tripId: id, category: 'transport', amount: price,
          currency: trip?.currency ?? 'CNY', date: day.date,
          note: `交通 · ${fromResult.name} → ${toResult.name}`,
          refType: 'itinerary_item', refId: item.id, dayId: activeDayId,
        });
      }
    }
    setFromResult(null); setToResult(null); setRouteInfo(null);
    setTransportPrice(''); setTransportDepart(''); setTransportArrive('');
    clearTempMarker(); await load();
    // 添加成功后自动关闭编辑面板
    setEditExpanded(prev => ({ ...prev, [activeDayId]: false }));
  };

  const globalOptimizing = useState(false)[0];

  // ── 样式 ──
  const p: React.CSSProperties = { background: 'rgba(255,255,255,0.06)', borderRadius: 8, padding: 12, marginTop: 10 };
  const inp: React.CSSProperties = { background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 6, padding: '8px 10px', color: '#fff', fontSize: 13, width: '100%', outline: 'none' };
  const btn = (bg = '#1677ff'): React.CSSProperties => ({ background: bg, color: '#fff', border: 'none', borderRadius: 6, padding: '8px 16px', fontSize: 13, cursor: 'pointer' });
  const tabBtn = (tab: EditTab): React.CSSProperties => ({
    flex: 1, padding: '8px 0', fontSize: 13, border: 'none', borderRadius: 6,
    cursor: 'pointer', background: activeTab === tab ? '#1677ff' : 'rgba(255,255,255,0.08)',
    color: activeTab === tab ? '#fff' : '#aaa',
  });

  if (!trip) return <p style={{ padding: 24 }}>加载中…</p>;

  const toggleBtn = (m: ViewMode): React.CSSProperties => ({
    padding: '8px 24px', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14, fontWeight: 600,
    background: mode === m ? (m === 'editor' ? '#1677ff' : '#06d6a0') : 'rgba(255,255,255,0.08)',
    color: mode === m ? '#fff' : '#888',
  });

  // 预览模式:渲染 TripPreview(只读,极简)
  if (mode === 'viewer') {
    return (
      <div style={{ height: '100vh', background: '#12121f', color: '#eee', fontFamily: '-apple-system, sans-serif', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 8, padding: '12px 0', background: '#1d1d30', borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
          <button style={toggleBtn('editor')} onClick={() => setMode('editor')}>✍️ 编辑规划</button>
          <button style={toggleBtn('viewer')} onClick={() => setMode('viewer')}>📖 行程预览</button>
          <Link to="/" style={{ marginLeft: 16, color: '#06d6a0', fontSize: 13, display: 'flex', alignItems: 'center' }}>返回列表</Link>
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <TripPreview trip={trip} daySummaries={daySummaries} />
        </div>
      </div>
    );
  }

  return (
    <>
    <div style={{ display: 'flex', height: '100vh', background: '#1a1a2e', color: '#eee', fontFamily: '-apple-system, sans-serif' }}>
      {/* 左侧面板 */}
      <div style={{
        width: 400, minWidth: 400, height: '100vh', overflow: 'auto',
        background: 'rgba(26,26,46,0.97)', borderRight: '1px solid rgba(255,255,255,0.08)',
        padding: 20, zIndex: 10,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <Link to="/" style={{ color: '#06d6a0', fontSize: 13, textDecoration: 'none' }}>← 返回列表</Link>
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={toggleBtn('editor')} onClick={() => setMode('editor')}>✍️ 编辑</button>
            <button style={toggleBtn('viewer')} onClick={() => setMode('viewer')}>📖 预览</button>
          </div>
        </div>
        <div style={{ padding: '14px 16px', borderRadius: 12, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', marginBottom: 12 }}>
          <h1 style={{ fontSize: 20, margin: 0, color: '#ffd166', fontWeight: 700 }}>{trip.title}</h1>
          <p style={{ fontSize: 12, color: '#9a9ab0', margin: '6px 0 0' }}>
            {trip.destination} · {trip.startDate} ~ {trip.endDate}
            {trip.cityNodes?.length ? ` · ${trip.cityNodes.map((c) => `${c.city}${c.nights}晚`).join('·')}` : ''}
          </p>
        </div>
        {!online && <div style={{ background: 'rgba(255,209,102,0.12)', padding: 6, borderRadius: 6, margin: '8px 0', fontSize: 12, color: '#ffd166' }}>当前为离线/弱网模式</div>}

        {trip.totalBudget && (
          <div style={{ marginBottom: 10, display: 'flex', gap: 12, fontSize: 13 }}>
            <span>已花 ¥{spent.toFixed(0)}</span>
            <span style={{ color: spent > trip.totalBudget ? '#c00' : '#2e7d32' }}>剩余 ¥{Math.max(0, trip.totalBudget - spent).toFixed(0)}</span>
            <Link to={`/trip/${trip.id}/bookkeeping`} style={{ color: '#1677ff', marginLeft: 'auto' }}>记账</Link>
            <Link to={`/trip/${trip.id}/overview`} style={{ color: '#06d6a0' }}>📊 概览</Link>
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          <button onClick={handleAdjustDates} style={{ ...btn('rgba(255,255,255,0.1)'), flex: 1, fontSize: 12 }}>调整日期</button>
          <button onClick={handleGlobalOptimize} style={{ ...btn('#06d6a0'), flex: 2, fontSize: 12 }} title="跨天防折返优化,全程最短">
            ♻️ 全局顺路优化
          </button>
          <button onClick={() => setShowMap(!showMap)} style={{ ...btn(showMap ? 'rgba(255,255,255,0.1)' : '#1677ff'), fontSize: 12 }}>
            {showMap ? '收起地图' : '展开地图'}
          </button>
        </div>

        <div style={{ fontSize: 13, color: '#06d6a0', fontWeight: 600, marginBottom: 6 }}>点击某天查看行程 · 拖拽景点可排序/跨天</div>

        <div style={{ fontSize: 13, color: '#06d6a0', fontWeight: 600, marginBottom: 6 }}>点击某天查看行程</div>

        {days.map((d, i) => {
          const ds = daySummaries.find((s) => s.day.id === d.id);
          const names = ds?.items.map((it) => it.poi?.name).filter(Boolean) ?? [];
          const isActive = activeDayId === d.id;
          const detOpen = detailExpanded[d.id] || false;
          const edtOpen = editExpanded[d.id] || false;
          const color = DAY_COLORS[i % DAY_COLORS.length];
          const hasValidCoords = ds?.items.some((it) => it.poi && it.poi.lng !== 0 && it.poi.lat !== 0);

          return (
            <div
              key={d.id}
              onDragOver={handleDragOver(d.id)}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop(d.id, ds?.items.length ?? 0)}
              style={{
                marginBottom: 8, borderRadius: 10,
                outline: dragOverDayId === d.id ? '2px dashed #06d6a0' : 'none',
                outlineOffset: 2,
                transition: 'background 0.1s',
              }}
            >
              <div
                onClick={() => {
                  // V6.2b:主体点击只「展开」行程明细(收起交给右上角收起按钮),避免点景点误收起
                  if (!detOpen) {
                    setDetailExpanded({ ...detailExpanded, [d.id]: true });
                    setEditExpanded({ ...editExpanded, [d.id]: false });
                    if (ds && ds.items.length > 0 && ds.items[0].poi && mapRef.current) {
                      flyTo(ds.items[0].poi.lng, ds.items[0].poi.lat, 10);
                    }
                  }
                }}
                style={{
                  padding: '12px 14px', borderRadius: 10,
                  borderLeft: `3px solid ${color}`,
                  background: isActive ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.06)',
                  cursor: 'pointer',
                  transition: 'background 0.15s',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 10, color: '#ffd166', letterSpacing: 1 }}>DAY {d.daySeq} · {d.date}</div>
                    <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>{names.join(' → ') || '自由日'}</div>
                    <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>{names.length} 个地点</div>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {/* V6.2b:独立的收起/展开按钮 */}
                    <button
                      onClick={(e) => { e.stopPropagation(); setDetailExpanded(prev => ({ ...prev, [d.id]: !detOpen })); setEditExpanded({}); }}
                      title={detOpen ? '收起当日行程' : '展开当日行程'}
                      style={{ background: 'rgba(255,255,255,0.12)', color: '#ddd', border: 'none', borderRadius: 4, padding: '4px 8px', fontSize: 12, cursor: 'pointer' }}
                    >
                      {detOpen ? '▲ 收起' : '▼ 展开'}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setActiveDayId(d.id); setActiveTab('scenic'); setDetailExpanded({}); setEditExpanded({ [d.id]: true }); }}
                      style={{ background: '#1677ff', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}
                    >
                      + 添加
                    </button>
                  </div>
                </div>

                {/* 行程明细（展开时） */}
                {detOpen && (
                  <div style={{ marginTop: 10, borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 10 }}>
                    {ds && ds.items.length > 0 && (() => {
                      const timing = calcDayTiming(ds);
                      return (
                        <div style={{ fontSize: 12, color: '#7eb8e0', padding: '6px 10px', borderRadius: 6, background: 'rgba(126,184,224,0.1)', marginBottom: 8 }}>
                          ⏱ 单日总时长 ~{fmtMin(timing.driveMin + timing.visitMin)} = 路上 {fmtMin(timing.driveMin)} + 游览 {fmtMin(timing.visitMin)}
                        </div>
                      );
                    })()}
                    {ds?.items.length === 0 ? (
                      <div style={{ fontSize: 12, color: '#888' }}>暂无排点</div>
                    ) : (
                      <div style={{ margin: 0 }}>
                        {ds!.items.map((it, idx) => (
                          <div
                            key={it.id}
                            draggable
                            onDragStart={handleDragStart(it.id, ds!.day.id)}
                            onDragEnd={() => { setDragItem(null); setDragOverDayId(null); }}
                            style={{
                              fontSize: 13, padding: '6px 4px', borderBottom: idx < ds!.items.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                              cursor: 'grab',
                              background: dragItem?.itemId === it.id ? 'rgba(6,214,160,0.12)' : 'transparent',
                              borderRadius: 6,
                            }}
                          >
                            <span style={{ cursor: 'grab', color: '#555', fontSize: 14, userSelect: 'none' }} title="拖拽排序/跨天">⋮⋮</span>
                            <div
                              style={{ flex: 1, overflow: 'hidden', cursor: it.poi ? 'pointer' : 'default' }}
                              onClick={(e) => { e.stopPropagation(); it.poi && focusPoi(it.id); }}
                              title={it.poi ? '点击地图定位' : ''}
                            >
                              <span style={{ color: '#888' }}>{idx + 1}.</span>{' '}
                              <strong>{it.poi?.name || it.note || it.itemType}</strong>
                              {it.visitMinutes != null && it.visitMinutes > 0 && <span style={{ color: '#888', fontSize: 11 }}> · {it.visitMinutes}min</span>}
                              {it.itemType === 'hotel' && <span style={{ color: '#7ec8ff', fontSize: 11, marginLeft: 4 }}>🏨</span>}
                              {it.itemType === 'transport' && <span style={{ color: '#ffa07a', fontSize: 11, marginLeft: 4 }}>🚗</span>}
                            </div>
                            <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                              <button
                                onClick={() => openItemEdit(it)}
                                title="修改名称/时长/门票/更换景点"
                                style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 4, padding: '2px 8px', fontSize: 11, color: '#ddd', cursor: 'pointer' }}
                              >修改</button>
                              <button
                                onClick={() => handleRemoveItem(it.id)}
                                title="删除此节点"
                                style={{ background: 'rgba(255,0,0,0.15)', border: 'none', borderRadius: 4, padding: '2px 8px', fontSize: 11, color: '#ff6b6b', cursor: 'pointer' }}
                              >🗑删除</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {/* 大交通行(恒渲染,不随景点清空隐藏) */}
                    {dayTransports(transports, d.date).map((t) => (
                      <div key={t.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 12, color: '#ffa07a', padding: '5px 4px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {modeIcon(t.mode)} {t.fromPlace ?? ''}→{t.toPlace ?? ''} · {fmtDT(t.departAt)}→{fmtDT(t.arriveAt)}
                        </span>
                        <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                          <button
                            onClick={() => handleEditTransportTime(t)}
                            title="修改起抵时间"
                            style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 4, padding: '2px 8px', fontSize: 11, color: '#ddd', cursor: 'pointer' }}
                          >⏱起抵</button>
                          <button
                            onClick={() => handleRemoveTransport(t)}
                            title="删除此交通"
                            style={{ background: 'rgba(255,0,0,0.15)', border: 'none', borderRadius: 4, padding: '2px 8px', fontSize: 11, color: '#ff6b6b', cursor: 'pointer' }}
                          >🗑</button>
                        </span>
                      </div>
                    ))}
                    {/* 操作行(恒渲染) */}
                    <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                      {hasValidCoords && ds!.items.length >= 2 && (
                        <button onClick={() => handleOptimizeDay(d, ds!.items)} style={{ ...btn('#06d6a0'), fontSize: 12 }}>顺路优化</button>
                      )}
                      <button onClick={() => handleDeleteDay(d.id)} style={{ ...btn('#c00'), fontSize: 12 }}>删除此天</button>
                    </div>
                  </div>
                )}
              </div>

              {/* 编辑面板（点击「+ 添加」展开） */}
              {edtOpen && (
                <div style={p}>
                  <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
                    <button style={tabBtn('scenic')} onClick={() => setActiveTab('scenic')}>景点</button>
                    <button style={tabBtn('hotel')} onClick={() => setActiveTab('hotel')}>酒店</button>
                    <button style={tabBtn('transport')} onClick={() => setActiveTab('transport')}>交通</button>
                    <button onClick={() => setEditExpanded(prev => ({ ...prev, [d.id]: false }))} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: 16 }}>×</button>
                  </div>

                  {/* 景点 Tab */}
                  {activeTab === 'scenic' && (
                    <div>
                      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                        <input placeholder="城市" value={scenicCity} onChange={(e) => setScenicCity(e.target.value)} style={{ ...inp, flex: 1 }} />
                        <input placeholder="搜索景点" value={scenicKeyword} onChange={(e) => setScenicKeyword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleScenicSearch()} style={{ ...inp, flex: 2 }} />
                        <button style={btn()} onClick={handleScenicSearch} disabled={scenicLoading}>{scenicLoading ? '…' : '搜索'}</button>
                      </div>
                      {scenicResults.length > 0 && !selectedScenic && (
                        <div style={{ maxHeight: 160, overflow: 'auto' }}>
                          {scenicResults.map((r) => (
                            <div key={r.id} onClick={() => handleSelectScenic(r)} style={{ padding: '8px 10px', borderRadius: 6, marginBottom: 4, background: 'rgba(255,255,255,0.05)', cursor: 'pointer', fontSize: 13 }}>
                              <div>{r.name}</div><div style={{ fontSize: 11, color: '#888' }}>{r.address}</div>
                            </div>
                          ))}
                        </div>
                      )}
                      {selectedScenic && (
                        <div style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 8, padding: 12, marginTop: 8 }}>
                          <div style={{ fontWeight: 'bold', marginBottom: 4 }}>{selectedScenic.name}</div>
                          <div style={{ fontSize: 12, color: '#aaa', marginBottom: 8 }}>{selectedScenic.address} · {selectedScenic.lng.toFixed(4)}, {selectedScenic.lat.toFixed(4)}</div>
                          {scenicCardLoading ? <div style={{ fontSize: 12, color: '#888' }}>正在生成 AI 卡片…</div>
                            : scenicCard && <div style={{ fontSize: 12, marginBottom: 8 }}><div style={{ color: '#ffd166' }}>⭐ {scenicCard.rating} · {scenicCard.suggestDuration} min</div><div>{scenicCard.recommendReason}</div></div>}
                          {/* V6.2 关联记账:门票价 */}
                          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                            <input type="number" placeholder="门票价(选填)" value={ticketPrice} onChange={(e) => setTicketPrice(e.target.value)} style={{ ...inp, width: '40%' }} />
                          </div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button style={btn()} onClick={handleAddScenic}>添加到 Day {d.daySeq}</button>
                            <button onClick={() => { setSelectedScenic(null); setScenicCard(null); setTicketPrice(''); clearTempMarker(); }} style={{ ...btn('rgba(255,255,255,0.15)') }}>重新选择</button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* 酒店 Tab */}
                  {activeTab === 'hotel' && (
                    <div>
                      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                        <input placeholder="城市" value={hotelCity} onChange={(e) => setHotelCity(e.target.value)} style={{ ...inp, flex: 1 }} />
                        <input placeholder="搜索酒店" value={hotelKeyword} onChange={(e) => setHotelKeyword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleHotelSearch()} style={{ ...inp, flex: 2 }} />
                        <button style={btn()} onClick={handleHotelSearch} disabled={hotelLoading}>{hotelLoading ? '…' : '搜索'}</button>
                      </div>
                      {hotelResults.length > 0 && !selectedHotel && (
                        <div style={{ maxHeight: 160, overflow: 'auto' }}>
                          {hotelResults.map((r) => (
                            <div key={r.id} onClick={() => handleSelectHotel(r)} style={{ padding: '8px 10px', borderRadius: 6, marginBottom: 4, background: 'rgba(255,255,255,0.05)', cursor: 'pointer', fontSize: 13 }}>
                              <div>{r.name}</div><div style={{ fontSize: 11, color: '#888' }}>{r.address}</div>
                            </div>
                          ))}
                        </div>
                      )}
                      {selectedHotel && (
                        <div style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 8, padding: 12, marginTop: 8 }}>
                          <div style={{ fontWeight: 'bold', marginBottom: 4 }}>{selectedHotel.name}</div>
                          <div style={{ fontSize: 12, color: '#aaa', marginBottom: 8 }}>{selectedHotel.address}</div>
                          {/* V6.2 关联记账:房价 */}
                          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                            <input type="number" placeholder="房价/晚(选填)" value={hotelPrice} onChange={(e) => setHotelPrice(e.target.value)} style={{ ...inp, width: '40%' }} />
                          </div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button style={btn()} onClick={handleAddHotel}>添加到 Day {d.daySeq}</button>
                            <button onClick={() => { setSelectedHotel(null); setHotelPrice(''); clearTempMarker(); }} style={{ ...btn('rgba(255,255,255,0.15)') }}>重新选择</button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* 交通 Tab */}
                  {activeTab === 'transport' && (
                    <div>
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>起点</div>
                        <input placeholder="搜索起点" onBlur={(e) => e.target.value && handleTransportSearch('from', e.target.value)} style={inp} />
                        {fromResult && <div style={{ fontSize: 11, color: '#06d6a0', marginTop: 2 }}>已选: {fromResult.name}</div>}
                      </div>
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>终点</div>
                        <input placeholder="搜索终点" onBlur={(e) => e.target.value && handleTransportSearch('to', e.target.value)} style={inp} />
                        {toResult && <div style={{ fontSize: 11, color: '#06d6a0', marginTop: 2 }}>已选: {toResult.name}</div>}
                      </div>
                      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                        {(['walk', 'drive', 'transit', 'train', 'flight'] as TransportMode[]).map((m) => (
                          <button key={m} onClick={() => { setTransportMode(m); if (m !== 'train' && m !== 'flight') { setTransportDepart(''); setTransportArrive(''); setRouteInfo(null); } }} style={{ flex: 1, padding: '6px 0', fontSize: 12, border: 'none', borderRadius: 6, cursor: 'pointer', background: transportMode === m ? '#1677ff' : 'rgba(255,255,255,0.08)', color: transportMode === m ? '#fff' : '#aaa' }}>
                            {m === 'walk' ? '步行' : m === 'drive' ? '驾车' : m === 'transit' ? '公交' : m === 'train' ? '火车' : '飞机'}
                          </button>
                        ))}
                      </div>
                      <button style={btn()} onClick={handleQueryRoute} disabled={routeLoading || !fromResult || !toResult}>
                        {routeLoading ? '查询中…' : '查询路线'}
                      </button>
                      {routeInfo && (
                        <div style={{ background: 'rgba(6,214,160,0.1)', borderRadius: 8, padding: 12, marginTop: 8 }}>
                          <div style={{ color: '#06d6a0', fontWeight: 'bold' }}>
                            {transportMode === 'walk' ? '步行' : transportMode === 'drive' ? '驾车' : transportMode === 'transit' ? '公交' : transportMode === 'train' ? '火车' : '飞机'} · {routeInfo.durationMin} min · {(routeInfo.distanceM / 1000).toFixed(1)} km
                          </div>
                          {isBigTransportMode(transportMode) && (
                            <>
                              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                                {(['inter_city', 'round_trip'] as TransportSegmentType[]).map((s) => (
                                  <button key={s} onClick={() => setTransportSeg(s)} style={{ flex: 1, padding: '5px 0', fontSize: 12, border: 'none', borderRadius: 6, cursor: 'pointer', background: transportSeg === s ? '#1677ff' : 'rgba(255,255,255,0.08)', color: transportSeg === s ? '#fff' : '#aaa' }}>
                                    {s === 'inter_city' ? '城市间' : '往返'}
                                  </button>
                                ))}
                              </div>
                              <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
                                <input type="datetime-local" value={transportDepart} onChange={(e) => setTransportDepart(e.target.value)} style={{ ...inp, width: '48%' }} />
                                <span style={{ alignSelf: 'center', fontSize: 12, color: '#888' }}>→</span>
                                <input type="datetime-local" value={transportArrive} onChange={(e) => setTransportArrive(e.target.value)} style={{ ...inp, width: '48%' }} />
                              </div>
                            </>
                          )}
                          {/* V6.2 关联记账:票价 */}
                          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                            <input type="number" placeholder="票价(选填)" value={transportPrice} onChange={(e) => setTransportPrice(e.target.value)} style={{ ...inp, width: '40%' }} />
                          </div>
                          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                            <button style={btn()} onClick={handleAddTransport}>添加到 Day {d.daySeq}</button>
                            <button onClick={() => { setRouteInfo(null); setTransportPrice(''); setTransportDepart(''); setTransportArrive(''); }} style={{ ...btn('rgba(255,255,255,0.15)') }}>取消</button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        <button onClick={handleAddDay} style={{ marginTop: 12, padding: '10px 0', width: '100%', borderRadius: 8, border: '1px dashed #555', background: 'transparent', color: '#aaa', fontSize: 13, cursor: 'pointer' }}>
          + 添加一天
        </button>
      </div>

      {/* 右侧地图 */}
      <div style={{ flex: 1, height: '100vh', position: 'relative' }}>
        {showMap ? (
          <>
            {mapError ? (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#c00' }}>{mapError}</div>
            ) : (
              <div ref={mapContainerRef} style={{ height: '100%' }} />
            )}
            {/* 空态遮罩层:旅程加载完成 且 没有任何带坐标 POI 时提示 */}
            {(() => {
              const tp = daySummaries.reduce((n, ds) => n + ds.items.filter(it => it.poi && it.poi.lng !== 0 && it.poi.lat !== 0).length, 0);
              if (tp > 0) return null; // 有坐标 → 不提示
              return (
                <div style={{ position: 'absolute', inset: 0, background: 'rgba(26,26,46,0.85)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', zIndex: 100, gap: 8 }}>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>🗺️</div>
                  <div style={{ fontSize: 16, fontWeight: 600, color: '#ffd166' }}>暂无景点坐标</div>
                  <div style={{ fontSize: 13, color: '#aaa', marginTop: 4, textAlign: 'center' }}>
                    {trip ? (
                      <>先在左侧「+添加」搜索景点<br/>或前往旅程列表<strong><u onClick={() => navigate('/')} style={{cursor:'pointer'}}>点击这里</u></strong>导入青甘大环线示例</>
                    ) : '正在加载…'}
                  </div>
                </div>
              );
            })()}
          </>
        ) : (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555' }}>
          </div>
        )}
      </div>

      {/* 全局优化:起点终点选择遮罩 */}
      {optimizeSetup && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,10,20,0.72)', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#1d1d30', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 14, width: 520, maxWidth: '92vw', maxHeight: '82vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }}>
            <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
              <div style={{ color: '#06d6a0', fontSize: 17, fontWeight: 700 }}>♻️ 全局顺路优化 · 选择起点终点</div>
              <div style={{ color: '#aaa', fontSize: 12, marginTop: 4 }}>起点和终点固定不变,仅优化中间景点的顺序与归属天</div>
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
              <div style={{ fontSize: 12, color: '#ffd166', marginBottom: 6 }}>🛫 起点(某天锚点)</div>
              <select
                value={optimizeSetup.startIdx}
                onChange={(e) => setOptimizeSetup({ ...optimizeSetup, startIdx: +e.target.value })}
                style={{ width: '100%', padding: 8, borderRadius: 6, background: '#222', color: '#eee', border: '1px solid #444', marginBottom: 14, fontSize: 13 }}
              >
                {optimizeSetup.days.map((da, i) => (
                  <option key={da.dayId} value={i}>Day{da.daySeq} · {da.fromHotel ? '🏨' : '📍'}{da.poi.name}</option>
                ))}
              </select>

              <div style={{ fontSize: 12, color: '#ffd166', marginBottom: 6 }}>🛬 终点(某天锚点)</div>
              <select
                value={optimizeSetup.endIdx}
                onChange={(e) => setOptimizeSetup({ ...optimizeSetup, endIdx: +e.target.value })}
                style={{ width: '100%', padding: 8, borderRadius: 6, background: '#222', color: '#eee', border: '1px solid #444', marginBottom: 14, fontSize: 13 }}
              >
                {optimizeSetup.days.map((da, i) => (
                  <option key={da.dayId} value={i}>Day{da.daySeq} · {da.fromHotel ? '🏨' : '📍'}{da.poi.name}</option>
                ))}
              </select>

              {optimizeSetup.startIdx === optimizeSetup.endIdx && (
                <div style={{ color: '#ff6b6b', fontSize: 12 }}>⚠️ 起点和终点天不能相同</div>
              )}
              <div style={{ fontSize: 11, color: '#888', marginTop: 8 }}>
                以「天锚点」为界(🏨=该天有酒店,📍=该天首个景点):起点天 → 经 {optimizeSetup.pois.length} 个景点 → 终点天。
                每个景点归到最近的城市天,跨城不搬,连住自动平摊。
              </div>
            </div>
            <div style={{ padding: '14px 20px', borderTop: '1px solid rgba(255,255,255,0.1)', display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setOptimizeSetup(null)} style={{ ...btn('rgba(255,255,255,0.1)') }}>取消</button>
              <button
                onClick={computeOptimizePreview}
                disabled={optimizeSetup.startIdx === optimizeSetup.endIdx}
                style={{ ...btn('#06d6a0'), color: '#001', fontWeight: 700, opacity: optimizeSetup.startIdx === optimizeSetup.endIdx ? 0.4 : 1 }}
              >
                计算优化预览
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 全局优化预览遮罩 */}
      {optimizePreview && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,10,20,0.72)', zIndex: 500, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#1d1d30', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 14, width: 520, maxWidth: '92vw', maxHeight: '82vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }}>
            {/* 标题 */}
            <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
              <div style={{ color: '#06d6a0', fontSize: 17, fontWeight: 700 }}>♻️ 全局顺路优化 · 预览</div>
              <div style={{ color: '#7eb8e0', fontSize: 13, marginTop: 4 }}>
                全程线性推进不走回头路 · 预计缩短道路约 <strong style={{ color: '#ffd166' }}>{optimizePreview.savedMin}</strong> 分钟
              </div>
            </div>

            {/* 变化清单 */}
            <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
              {/* 优化后路线(按天) */}
              <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>优化后路线(按天串联)</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
                {optimizePreview.chain.map((c, i) => (
                  <span key={i} style={{ fontSize: 12, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '3px 8px', color: '#ddd', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ color: '#ffd166' }}>D{c.day}</span>{c.name}
                    {i < optimizePreview.chain.length - 1 && <span style={{ color: '#888' }}>→</span>}
                  </span>
                ))}
              </div>

              {/* 移动清单 */}
              {optimizePreview.moves.length === 0 ? (
                <div style={{ fontSize: 13, color: '#06d6a0' }}>✓ 各景点都在最合适的日期,无需移动。</div>
              ) : (
                <>
                  <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>将调整以下 {optimizePreview.moves.length} 个景点的日期:</div>
                  {optimizePreview.moves.map((m, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 6, marginBottom: 4, background: 'rgba(255,255,255,0.04)', fontSize: 13 }}>
                      <span style={{ color: '#eee', flex: 1 }}>{m.poiName}</span>
                      <span style={{ color: '#ff6b6b', fontSize: 12 }}>Day {m.fromDay}</span>
                      <span style={{ color: '#888' }}>→</span>
                      <span style={{ color: '#06d6a0', fontSize: 12 }}>Day {m.toDay}</span>
                    </div>
                  ))}
                </>
              )}
            </div>

            {/* 操作 */}
            <div style={{ padding: '14px 20px', borderTop: '1px solid rgba(255,255,255,0.1)', display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button onClick={() => setOptimizePreview(null)} style={{ ...btn('rgba(255,255,255,0.1)') }}>取消</button>
              <button onClick={copyOptimizedToNewTrip} style={{ ...btn('rgba(6,214,160,0.25)'), color: '#06d6a0' }}>
                📋 复制到新的行程
              </button>
              <button onClick={applyGlobalOptimize} style={{ ...btn('#06d6a0'), color: '#001', fontWeight: 700 }}>
                确认保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>

    {/* 修改弹窗 */}
    <ItemEditModal
      key={editingItem?.id ?? 'none'}
      item={editingItem}
      defaultCity={trip?.destination ?? ''}
      currency={trip?.currency ?? 'CNY'}
      linkedTicket={linkedTicket}
      onCancel={() => setEditingItem(null)}
      onSave={(p) => (editingItem ? handleSaveItemEdit(editingItem, p) : Promise.resolve())}
    />
    </>
  );
}