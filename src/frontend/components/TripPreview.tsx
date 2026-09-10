import { useEffect, useRef, useState } from 'react';
import { loadAMap } from '../services/amapLoader';
import { timePeriod } from '../utils/time';
import type { Trip, ItineraryDay, ItineraryItem, Poi, PoiAiCard } from '../types';

interface DaySummary {
  day: ItineraryDay;
  items: (ItineraryItem & { poi?: Poi; aiCard?: PoiAiCard })[];
  hotel?: { name: string; lng: number; lat: number };
}

interface TripPreviewProps {
  trip: Trip;
  daySummaries: DaySummary[];
}

const DAY_COLORS = [
  '#ff6b6b', '#ffd166', '#06d6a0', '#118ab2', '#ef476f',
  '#073b4c', '#f77f00', '#8338ec', '#3a86ff', '#ff006e',
];

/** 城市宏观轨迹:从 city_nodes 或模板预置坐标构建 */
const CITY_COORDS: Record<string, [number, number]> = {
  兰州: [103.8154, 36.0647],
  西宁: [101.778, 36.617],
  张掖: [100.4545, 38.9315],
  敦煌: [94.662, 40.141],
  瓜州: [96.241, 40.252],
  格尔木: [94.9, 36.4],
  大柴旦: [95.36, 37.855],
  青海湖: [100.178, 36.89],
  茶卡: [99.08, 36.793],
  西安: [108.94, 34.34],
};

export default function TripPreview({ trip, daySummaries }: TripPreviewProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const [selectedPoi, setSelectedPoi] = useState<(DaySummary['items'][number]) | null>(null);
  const [copied, setCopied] = useState(false);

  // 初始化宏观轨迹地图
  useEffect(() => {
    if (!mapContainerRef.current) return;
    let destroyed = false;
    loadAMap().then((AMap: any) => {
      if (destroyed || !mapContainerRef.current) return;
      const map = new AMap.Map(mapContainerRef.current, {
        zoom: 6, center: [100.0, 37.5], mapStyle: 'amap://styles/dark',
      });
      mapRef.current = map;

      // 宏观轨迹 = 每天住宿点连线(粗线)
      const path: [number, number][] = [];
      daySummaries.forEach((ds, i) => {
        const hotel = ds.hotel;
        const city = trip.cityNodes?.[i]?.city;
        const coord = (hotel && hotel.lng && hotel.lat)
          ? [hotel.lng, hotel.lat] as [number, number]
          : (city ? CITY_COORDS[city] : undefined) ?? CITY_COORDS[city ?? ''] ?? undefined;
        if (!coord) return;
        path.push(coord);
      });

      // 粗线:城市间宏观轨迹
      if (path.length >= 2) {
        const line = new AMap.Polyline({
          path,
          strokeColor: '#06d6a0',
          strokeWeight: 8,
          strokeOpacity: 0.6,
          lineJoin: 'round',
        });
        map.add(line);
      }

      // Marker:仅每日住宿地 + 大交通枢纽
      daySummaries.forEach((ds, i) => {
        const hotel = ds.hotel;
        const city = trip.cityNodes?.[i]?.city;
        const coord = (hotel && hotel.lng && hotel.lat)
          ? [hotel.lng, hotel.lat] as [number, number]
          : (city ? CITY_COORDS[city] : undefined);
        if (!coord) return;
        const color = DAY_COLORS[i % DAY_COLORS.length];
        const marker = new AMap.CircleMarker({
          center: coord, radius: 16,
          fillColor: color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2,
        });
        const label = new AMap.Text({
          text: String(ds.day.daySeq),
          position: coord,
          style: { color: '#fff', fontSize: '12px', fontWeight: '700', backgroundColor: 'transparent', border: 'none' },
          offset: new AMap.Pixel(-5, -7),
        });
        marker.on('click', () => {
          new AMap.InfoWindow({
            content: `<b>Day ${ds.day.daySeq}</b> · ${hotel?.name ?? city ?? ''}<br/><small>${ds.day.note || ''}</small>`,
            offset: new AMap.Pixel(0, -15),
          }).open(map, coord);
        });
        map.add(marker); map.add(label);
      });

      if (path.length > 0) {
        map.setFitView(null, false, [60, 60, 60, 60]);
      }
    }).catch(() => {});
    return () => {
      destroyed = true;
      if (mapRef.current) { mapRef.current.destroy(); mapRef.current = null; }
    };
  }, [trip, daySummaries]);

  const copyAddress = async (addr: string) => {
    try {
      // navigator.clipboard 是 SecureContext-only(http://纯IP 下不可用),降级到 execCommand
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(addr);
      } else {
        const ta = document.createElement('textarea');
        ta.value = addr;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  const openNavigation = (poi: Poi) => {
    window.open(`https://uri.amap.com/navigation?to=${poi.lng},${poi.lat},${encodeURIComponent(poi.name)}&mode=car&callnative=0`, '_blank');
  };

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 104px)', background: '#12121f', color: '#eee' }}>
      {/* 左侧大纲 */}
      <div style={{ width: 420, minWidth: 420, overflow: 'auto', background: 'rgba(18,18,31,0.97)', borderRight: '1px solid rgba(255,255,255,0.08)', padding: 20 }}>
        <h2 style={{ margin: '0 0 4px', color: '#ffd166', fontSize: 20 }}>{trip.title}</h2>
        <div style={{ fontSize: 12, color: '#888', marginBottom: 16 }}>
          {trip.destination} · {trip.startDate} ~ {trip.endDate} · {trip.cityNodes?.map((c) => `${c.city}${c.nights}晚`).join(' · ') || ''}
        </div>

        {daySummaries.map((ds, i) => {
          const color = DAY_COLORS[i % DAY_COLORS.length];
          const pois = ds.items.filter((it) => it.itemType === 'poi');
          const hotels = ds.items.filter((it) => it.itemType === 'hotel');
          const transports = ds.items.filter((it) => it.itemType === 'transport');
          const city = trip.cityNodes?.[i]?.city;

          return (
            <div key={ds.day.id} style={{ marginBottom: 14, borderRadius: 10, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.03)' }}>
              {/* Day 头部 */}
              <div style={{ padding: '10px 14px', background: `${color}22`, borderLeft: `4px solid ${color}` }}>
                <div style={{ fontSize: 11, color: '#ffd166', letterSpacing: 1 }}>
                  DAY {ds.day.daySeq} · {city || ''} {ds.day.note ? `• ${ds.day.note}` : ''}
                </div>
                {transports.length > 0 && (
                  <div style={{ fontSize: 13, marginTop: 4 }}>
                    {transports.map((t) => (
                      <div key={t.id} style={{ color: '#ffa07a' }}>🚗 {stripPrefix(t, t.note || '')}</div>
                    ))}
                  </div>
                )}
              </div>

              {/* 景点列表 */}
              <div style={{ padding: '8px 14px' }}>
                {pois.length === 0 && hotels.length === 0 && (
                  <div style={{ fontSize: 12, color: '#777' }}>自由日 · 无排点</div>
                )}
                {pois.map((it, idx) => (
                  <div
                    key={it.id}
                    onClick={() => setSelectedPoi(it)}
                    style={{
                      padding: '8px 0', borderBottom: idx < pois.length - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none',
                      cursor: it.poi ? 'pointer' : 'default',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 600 }}>
                      <span style={{ color: '#999', fontSize: 12 }}>{timeSlot(it)}</span>
                      <span>{it.poi?.name || it.note || '景点'}</span>
                    </div>
                    {it.note && it.note !== (it.poi?.name ?? '') && (
                      <div style={{ fontSize: 12, color: '#888', marginTop: 2, marginLeft: 48 }}>{it.note}</div>
                    )}
                  </div>
                ))}
              </div>

              {/* 住宿 */}
              {hotels.length > 0 && (
                <div style={{ padding: '8px 14px', borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: 13, color: '#7ec8ff' }}>
                  🏨 住宿：{hotels.map((h) => h.poi?.name || h.note).join('、')}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 右侧:宏观轨迹地图 + 景点详情卡 */}
      <div style={{ flex: 1, position: 'relative' }}>
        <div ref={mapContainerRef} style={{ position: 'absolute', inset: 0 }} />

        {/* 底部景点详情卡 */}
        {selectedPoi && selectedPoi.poi && (
          <div style={{
            position: 'absolute', bottom: 16, left: 16, right: 16,
            background: 'rgba(18,18,31,0.96)', border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: 12, padding: 16, boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
            maxHeight: '45%', overflow: 'auto',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 8 }}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#fff' }}>{selectedPoi.poi.name}</div>
                {selectedPoi.poi.address && (
                  <div style={{ fontSize: 13, color: '#aaa', marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>📍 {selectedPoi.poi.address}</span>
                    <button onClick={() => copyAddress(selectedPoi.poi!.address!)} style={miniBtn}>
                      {copied ? '✓ 已复制' : '复制'}
                    </button>
                    <button onClick={() => openNavigation(selectedPoi.poi!)} style={{ ...miniBtn, background: '#06d6a0', color: '#001' }}>
                      高德导航直达
                    </button>
                  </div>
                )}
              </div>
              <button onClick={() => setSelectedPoi(null)} style={{ background: 'none', border: 'none', color: '#888', fontSize: 18, cursor: 'pointer' }}>✕</button>
            </div>

            {/* AI 避坑指南(常驻,精简2条大字) */}
            {selectedPoi.aiCard?.pitfallGuide && (
              <div style={{ background: 'rgba(255,209,102,0.08)', border: '1px solid rgba(255,209,102,0.3)', borderRadius: 8, padding: 10, marginTop: 8 }}>
                <div style={{ fontSize: 12, color: '#ffd166', fontWeight: 700, marginBottom: 4 }}>⚠️ 避坑提醒</div>
                <div style={{ fontSize: 14, lineHeight: 1.6 }}>
                  {extractPitfalls(selectedPoi.aiCard.pitfallGuide)}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 显示时间段(若 item 有时间)或序号 */
function timeSlot(it: DaySummary['items'][number]): string {
  if (it.arriveTime) return timePeriod(it.arriveTime);
  return '';
}

function stripPrefix(it: DaySummary['items'][number], note: string): string {
  return note || it.itemType;
}

function extractPitfalls(guide: string): string {
  // 精简为 2 条:按分隔符拆,取前 2 条
  const parts = guide.split(/[。；;，,.！!]|\d+[、．.]/).filter((s) => s.trim().length > 4);
  const top2 = parts.slice(0, 2);
  return top2.length > 0 ? top2.map((s) => `• ${s.trim()}`).join('\n') : guide.slice(0, 60);
}

const miniBtn: React.CSSProperties = {
  padding: '2px 8px', borderRadius: 4, border: '1px solid #555',
  background: '#222', color: '#ddd', fontSize: 12, cursor: 'pointer',
};