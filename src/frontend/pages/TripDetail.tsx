import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { db } from '../services/db';
import { useOnlineStatus } from '../utils/useOnlineStatus';
import { solveTsp, savings, solveOpenPath, haversineKm } from '../utils/tsp';
import { getDuration, searchPoiByJS, reverseGeocode, getDrivingPath } from '../services/amap';
import { getPoiCard } from '../services/llm';
import { loadAMap } from '../services/amapLoader';
import { optimizeItinerary } from '../services/itineraryEngine';
import type { ItineraryPoi, DayAnchor } from '../services/itineraryEngine';
import TripPreview from '../components/TripPreview';
import type { Trip, ItineraryDay, ItineraryItem, Poi, PoiAiCard, Hotel, TransportMode } from '../types';

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

  // ── 加载数据 ──
  const load = useCallback(async () => {
    if (!id) return;
    const t = await db.getTrip(id);
    if (!t) { navigate('/'); return; }
    setTrip(t);
    const allDays = await db.listDays(id);
    setDays(allDays);
    setSpent(await db.sumExpenses(id));

    const summaries: Array<{ day: ItineraryDay; items: (ItineraryItem & { poi?: Poi; aiCard?: PoiAiCard })[] }> = [];
    for (const d of allDays) {
      const items = await db.listItems(d.id);
      const enriched: (ItineraryItem & { poi?: Poi; aiCard?: PoiAiCard })[] = [];

      // 有坐标 POI 直接附加;缺失的留给修复
      const fixTasks: ItineraryItem[] = [];
      for (const it of items) {
        const poi = it.poiId ? await db.getPoi(it.poiId) : null;
        if (poi && poi.lng !== 0 && poi.lat !== 0) {
          const card = await db.getPoiCard(poi.id).catch(() => null);
          enriched.push({ ...it, poi, aiCard: card ?? undefined });
        } else {
          fixTasks.push(it);
        }
      }

      // 修复:尽力而为,失败不阻塞(保留原 item,仅无地图点)
      if (fixTasks.length > 0) {
        const cityHint = /青甘|环线|大西北|之旅|行程/.test(t.destination) ? '' : (t.destination || '');
        const fixes = await Promise.all(
          fixTasks.map(async (it): Promise<ItineraryItem | { item: ItineraryItem; poi: Poi } | null> => {
            const name = it.note || it.itemType;
            const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000));
            try {
              const results = await Promise.race([searchPoiByJS(name, cityHint), timeout]);
              const lngResults = (results || []).find((r) => r.lng !== 0 && r.lat !== 0);
              if (!lngResults) return null;
              const poiId = it.poiId ?? crypto.randomUUID();
              await db.upsertPoi({
                id: poiId, name: lngResults.name, lng: lngResults.lng, lat: lngResults.lat,
                category: it.itemType === 'hotel' ? 'hotel' : 'poi', address: lngResults.address,
              });
              if (!it.poiId) {
                await db.updateItem(it.id, { poiId });
              }
              const poi: Poi = {
                id: poiId, name: lngResults.name, lng: lngResults.lng, lat: lngResults.lat,
                category: it.itemType === 'hotel' ? 'hotel' as const : 'poi' as const, address: lngResults.address,
              };
              return { item: it, poi };
            } catch {
              return null;
            }
          }),
        );
        for (const fix of fixes) {
          if (fix && 'item' in fix && 'poi' in fix) {
            enriched.push({ ...fix.item, poi: fix.poi });
          } else if (fix) {
            enriched.push(fix);
          }
        }
        // 修复失败的 item 也保留(有名字,仅无地图点)
        for (const it of fixTasks) {
          if (!enriched.some((e) => e.id === it.id)) {
            enriched.push(it);
          }
        }
      }

      summaries.push({ day: d, items: enriched });
    }
    setDaySummaries(summaries);
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

  // daySummaries 变化时重新渲染覆盖物
  useEffect(() => {
    if (!mapRef.current || !ready) return;
    // 延迟一帧,确保 map 容器尺寸已就绪
    const t = setTimeout(() => renderMapOverlays(), 50);
    return () => clearTimeout(t);
  }, [daySummaries, ready]);

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

    // 跨天虚线
    for (let i = 0; i < summaries.length - 1; i++) {
      const prev = summaries[i].items; const next = summaries[i + 1].items;
      if (prev.length === 0 || next.length === 0) continue;
      const from = prev[prev.length - 1].poi; const to = next[0].poi;
      if (!from || !to || from.lng === 0 || to.lng === 0) continue;
      map.add(new AMap.Polyline({
        path: [[from.lng, from.lat], [to.lng, to.lat]],
        strokeColor: '#ffffff', strokeWeight: 2, strokeOpacity: 0.4,
        strokeStyle: 'dashed', lineDash: [4, 8],
      }));
    }

    console.log(`[地图] 渲染: ${allPositions.length} 个点`);
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

  /** 提取每天锚点:优先酒店,无酒店用当天第一个有坐标景点;返回引擎 DayAnchor */
  const getDayAnchors = (): DayAnchor[] => {
    const anchors: DayAnchor[] = [];
    for (const ds of daySummaries) {
      const hotelItem = ds.items.find((it) => it.itemType === 'hotel' && it.poi && it.poi.lng !== 0 && it.poi.lat !== 0);
      if (hotelItem?.poi) {
        anchors.push({ daySeq: ds.day.daySeq, dayId: ds.day.id, poi: hotelItem.poi, fromHotel: true, city: hotelItem.poi.city });
      } else {
        const poiItem = ds.items.find((it) => it.itemType !== 'hotel' && it.poi && it.poi.lng !== 0 && it.poi.lat !== 0);
        if (poiItem?.poi) {
          anchors.push({ daySeq: ds.day.daySeq, dayId: ds.day.id, poi: poiItem.poi, fromHotel: false, city: poiItem.poi.city });
        }
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

  /** 逆地理纠错 + 按名重查坐标:绑定城市,坐标偏差>50km 自动修正(优先一次,已 fixed 跳过) */
  const enrichPoiCities = async (pois: Array<{ poi: Poi; daySeq: number; itemId: string }>): Promise<void> => {
    const toFix = pois.filter((p) => !p.poi.fixed);
    if (toFix.length === 0) return;
    // 并发(限 5,防高德频控)
    const BATCH = 5;
    for (let b = 0; b < toFix.length; b += BATCH) {
      const batch = toFix.slice(b, b + BATCH);
      await Promise.all(batch.map(async (p) => {
        const fixedPoi = { ...p.poi, fixed: true as const };
        try {
          // 1) 按名字重查坐标:与当前偏差>50km → 修正
          const keyword = cleanPoiName(p.poi.name);
          let lng = p.poi.lng, lat = p.poi.lat;
          if (keyword) {
            const results = await searchPoiByJS(keyword);
            const hit = results.find((r) => r.lng !== 0 && r.lat !== 0);
            if (hit) {
              const dev = haversineKm(p.poi.lng, p.poi.lat, hit.lng, hit.lat);
              if (dev > 50) {
                lng = hit.lng; lat = hit.lat;
                fixedPoi.lng = lng; fixedPoi.lat = lat;
                fixedPoi.address = hit.address || fixedPoi.address;
              }
            }
          }
          // 2) 逆地理绑定城市(用修正后坐标)
          const city = await reverseGeocode(lng, lat);
          if (city) fixedPoi.city = city;
        } catch { /* 保底:标记 fixed 避免重复 */ }
        await db.upsertPoi(fixedPoi).catch(() => {});
      }));
    }
  };

  /** 打开起点终点选择面板 */
  const handleGlobalOptimize = async () => {
    if (!id) return;
    const dayAnchors = getDayAnchors();
    if (dayAnchors.length < 2) {
      alert('需要有至少 2 天包含景点(或酒店)作为起点/终点锚点。\n请先在行程中为至少 2 天添加带坐标的景点或酒店。');
      return;
    }
    // 收集所有景点
    const rawPois: Array<{ poi: Poi; daySeq: number; itemId: string }> = [];
    for (const ds of daySummaries) {
      for (const it of ds.items) {
        if (it.itemType !== 'hotel' && it.poi && it.poi.lng !== 0 && it.poi.lat !== 0) {
          rawPois.push({ poi: it.poi, daySeq: ds.day.daySeq, itemId: it.id });
        }
      }
    }
    if (rawPois.length < 2) {
      alert(`当前只有 ${rawPois.length} 个带坐标的景点(需≥2)。\n请先在行程中添加景点,或检查景点坐标是否有效。`);
      return;
    }
    // 逆地理纠错(异步,不阻塞)
    await enrichPoiCities(rawPois);
    // 重新加载(纠错后 poi 有 city)
    const reloaded: ItineraryPoi[] = [];
    for (const rp of rawPois) {
      const fresh = await db.getPoi(rp.poi.id);
      reloaded.push({ id: rp.poi.id, poi: fresh ?? rp.poi, city: fresh?.city ?? rp.poi.city, srcDaySeq: rp.daySeq });
    }
    // 默认:起点=第一天锚点,终点=最后一天锚点
    setOptimizeSetup({ days: dayAnchors, pois: reloaded, startIdx: 0, endIdx: dayAnchors.length - 1 });
  };

  /** 基于选定的起点终点计算优化预览(引擎:城市硬约束+连住平摊) */
  const computeOptimizePreview = async () => {
    if (!optimizeSetup) return;
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

      // 调引擎:城市硬约束 + 连住平摊(每日≤2) + 过渡日顺路校验
      const result = optimizeItinerary({
        days,
        pois,
        maxPerDay: 2,
        transitionRoutes,
        routeDeviationKm: 30,
      });

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
      const chain: Array<{ name: string; day: number }> = [];
      sortedDays.forEach((ds) => {
        if (ds === startDay) chain.push({ name: `${startMark}${days[startIdx].poi.name}`, day: ds });
        (byDay.get(ds) || []).forEach((n) => chain.push({ name: n, day: ds }));
        if (ds === endDay) chain.push({ name: `${endMark}${days[endIdx].poi.name}`, day: ds });
      });

      setOptimizePreview({ savedMin: saved, moves, chain });
      setOptimizeSetup(null);
    } catch (e: any) {
      console.error('优化计算出错:', e);
      alert('优化计算出错: ' + (e?.message || '未知错误'));
    }
  };

  /** 应用已确认的全局优化(起点终点不动,仅移动中间景点) */
  /** 根据 optimizePreview 反推优化后的完整序列(酒店+景点,按链顺序) */
  const buildOptimizedAll = () => {
    if (!optimizePreview) return null;
    const chainNames = optimizePreview.chain.map((c) => c.name);
    const ordered = chainNames
      .map((name) => {
        const isHotel = String(name).startsWith('🏨');
        const rawName = isHotel ? String(name).slice(2) : name;
        for (const ds of daySummaries) {
          const found = ds.items.find((it) => it.poi?.name === rawName);
          if (found && found.poi) return { poi: found.poi, daySeq: ds.day.daySeq, itemId: found.id, hotel: isHotel || found.itemType === 'hotel' };
        }
        return null;
      })
      .filter(Boolean) as Array<{ poi: Poi; daySeq: number; itemId: string; hotel: boolean }>;
    return ordered;
  };

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
  const copyOptimizedToNewTrip = async () => {
    if (!optimizePreview || !trip) return;
    const ordered = buildOptimizedAll();
    if (!ordered || ordered.length === 0) { alert('暂无可复制的景点'); return; }

    const title = prompt('新旅程标题:', `${trip.title}(优化版)`);
    if (title === null) return;

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

      // 2. 按优化后的 daySeq 把景点写入对应天
      for (const item of ordered) {
        const targetDay = newDays.find((nd) => nd.daySeq === item.daySeq);
        if (!targetDay) continue;
        const poiId = item.poi.id || crypto.randomUUID();
        await db.upsertPoi({ ...item.poi, id: poiId, category: item.hotel ? 'hotel' : 'poi' });
        await db.addItem({
          dayId: targetDay.id,
          poiId,
          itemType: item.hotel ? 'hotel' : 'poi',
          transportMode: 'walk',
          note: item.poi.name,
          visitMinutes: 90,
        });
        if (item.hotel && item.poi.lng && item.poi.lat) {
          await db.addHotel({
            tripId: newTrip.id,
            name: item.poi.name,
            address: item.poi.address,
            lng: item.poi.lng,
            lat: item.poi.lat,
            checkIn: targetDay.date,
            checkOut: targetDay.date,
            poiId,
          });
        }
      }

      // 3. 删除新旅程中没有任何景点的空天
      const filledDaySeqs = new Set(ordered.map((o) => o.daySeq));
      for (const nd of [...newDays]) {
        if (!filledDaySeqs.has(nd.daySeq)) {
          await db.removeDay(nd.id).catch(() => {});
        }
      }

      // 4. 天内部顺路优化(静默)
      const remainingDays = await db.listDays(newTrip.id);
      for (const rd of remainingDays) {
        const freshItems = await db.listItems(rd.id);
        const freshPois = await Promise.all(freshItems.map(async (it) => ({ ...it, poi: it.poiId ? await db.getPoi(it.poiId) ?? undefined : undefined })));
        if (freshPois.filter((x) => x.poi).length >= 2) await handleOptimizeDay(rd, freshPois, true);
      }

      setOptimizePreview(null);
      const ok = confirm(`✅ 已创建新旅程「${title}」。是否立即打开查看?`);
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

  const handleEditVisitMinutes = async (item: ItineraryItem) => {
    const input = prompt('修改游览时长(分钟):', String(item.visitMinutes ?? 90));
    if (input === null) return;
    const mins = parseInt(input, 10);
    if (isNaN(mins) || mins < 0) { alert('请输入有效分钟数'); return; }
    await db.updateItem(item.id, { visitMinutes: mins });
    await load();
  };

  const handleEditNote = async (item: ItineraryItem) => {
    const input = prompt('修改备注/名称:', item.note || '');
    if (input === null) return;
    await db.updateItem(item.id, { note: input.trim() });
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
      // V6.2:火车/飞机用直线粗估,不调高德(跨城路线高德算不了)
      if (transportMode === 'train' || transportMode === 'flight') {
        const km = haversineKm(fromResult.lng, fromResult.lat, toResult.lng, toResult.lat);
        const speedKmh = transportSpeedKmh(transportMode);
        setRouteInfo({ durationMin: Math.round((km / speedKmh) * 60), distanceM: Math.round(km * 1000) });
      } else {
        setRouteInfo(await getDuration([fromResult.lng, fromResult.lat], [toResult.lng, toResult.lat], transportMode));
      }
    } catch (e: any) { alert('路线查询失败: ' + e.message); }
    finally { setRouteLoading(false); }
  };

  const handleAddTransport = async () => {
    if (!fromResult || !toResult || !activeDayId || !id) return;
    const day = days.find((d) => d.id === activeDayId);
    await db.upsertPoi({ id: fromResult.id, name: fromResult.name, lng: fromResult.lng, lat: fromResult.lat, category: 'poi' });
    const item = await db.addItem({ dayId: activeDayId, poiId: fromResult.id, itemType: 'poi', transportMode, note: `${fromResult.name} → ${toResult.name}`, visitMinutes: 0 });
    // V6.2 关联记账:票价
    const price = parseFloat(transportPrice);
    if (!isNaN(price) && price > 0 && day) {
      await db.addExpense({
        tripId: id, category: 'transport', amount: price,
        currency: trip?.currency ?? 'CNY', date: day.date,
        note: `交通 · ${fromResult.name} → ${toResult.name}`,
        refType: 'itinerary_item', refId: item.id, dayId: activeDayId,
      });
    }
    setFromResult(null); setToResult(null); setRouteInfo(null);
    setTransportPrice('');
    clearTempMarker(); await load();
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
                      onClick={(e) => { e.stopPropagation(); setDetailExpanded(prev => ({ ...prev, [d.id]: !detOpen })); }}
                      title={detOpen ? '收起当日行程' : '展开当日行程'}
                      style={{ background: 'rgba(255,255,255,0.12)', color: '#ddd', border: 'none', borderRadius: 4, padding: '4px 8px', fontSize: 12, cursor: 'pointer' }}
                    >
                      {detOpen ? '▲ 收起' : '▼ 展开'}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setActiveDayId(d.id); setActiveTab('scenic'); setDetailExpanded(prev => ({ ...prev, [d.id]: false })); setEditExpanded(prev => ({ ...prev, [d.id]: !prev[d.id] })); }}
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
                      <>
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
                                  onClick={() => handleEditVisitMinutes(it)}
                                  title="修改游览时长"
                                  style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 4, padding: '2px 8px', fontSize: 11, color: '#ddd', cursor: 'pointer' }}
                                >⏱时长</button>
                                <button
                                  onClick={() => handleEditNote(it)}
                                  title="修改名称/备注"
                                  style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 4, padding: '2px 8px', fontSize: 11, color: '#ddd', cursor: 'pointer' }}
                                >✏️改名</button>
                                <button
                                  onClick={() => handleRemoveItem(it.id)}
                                  title="删除此景点"
                                  style={{ background: 'rgba(255,0,0,0.15)', border: 'none', borderRadius: 4, padding: '2px 8px', fontSize: 11, color: '#ff6b6b', cursor: 'pointer' }}
                                >🗑删除</button>
                              </div>
                            </div>
                          ))}
                        </div>
                        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                          {hasValidCoords && (
                            <button onClick={() => handleOptimizeDay(d, ds!.items)} style={{ ...btn('#06d6a0'), fontSize: 12 }}>顺路优化</button>
                          )}
                          <button onClick={() => handleDeleteDay(d.id)} style={{ ...btn('#c00'), fontSize: 12 }}>删除此天</button>
                        </div>
                      </>
                    )}
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
                          <button key={m} onClick={() => setTransportMode(m)} style={{ flex: 1, padding: '6px 0', fontSize: 12, border: 'none', borderRadius: 6, cursor: 'pointer', background: transportMode === m ? '#1677ff' : 'rgba(255,255,255,0.08)', color: transportMode === m ? '#fff' : '#aaa' }}>
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
                          {/* V6.2 关联记账:票价 */}
                          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                            <input type="number" placeholder="票价(选填)" value={transportPrice} onChange={(e) => setTransportPrice(e.target.value)} style={{ ...inp, width: '40%' }} />
                          </div>
                          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                            <button style={btn()} onClick={handleAddTransport}>添加到 Day {d.daySeq}</button>
                            <button onClick={() => { setRouteInfo(null); setTransportPrice(''); }} style={{ ...btn('rgba(255,255,255,0.15)') }}>取消</button>
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
  );
}