import { useEffect, useRef, useState } from 'react';
import { loadAMap } from '../services/amapLoader';

export interface MarkerDef {
  id: string;
  name: string;
  lng: number;
  lat: number;
}

interface Props {
  center?: [number, number];
  markers: MarkerDef[];
  onMarkerClick?: (marker: MarkerDef) => void;
  style?: React.CSSProperties;
  className?: string;
}

export default function MapView({ center, markers, onMarkerClick, style, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadAMap()
      .then((AMap) => {
        if (!containerRef.current) return;
        const defaultCenter = center ?? [116.397, 39.908]; // 默认北京
        const map = new AMap.Map(containerRef.current, {
          zoom: 13,
          center: defaultCenter,
        });
        mapRef.current = map;
        setLoading(false);
      })
      .catch((e) => {
        setError('地图加载失败,请检查网络');
        setLoading(false);
      });
  }, []);

  // 更新中心
  useEffect(() => {
    if (!mapRef.current || !center) return;
    mapRef.current.setCenter(center);
  }, [center?.[0], center?.[1]]);

  // 更新 markers
  useEffect(() => {
    if (!mapRef.current || loading) return;
    const AMap = window.AMap;
    if (!AMap) return;

    // 清除旧 markers
    markersRef.current.forEach((m) => mapRef.current.remove(m));
    markersRef.current = [];

    const newMarkers = markers.map((m) => {
      const marker = new AMap.Marker({
        position: [m.lng, m.lat],
        title: m.name,
      });
      marker.on('click', () => onMarkerClick?.(m));
      mapRef.current.add(marker);
      return marker;
    });

    markersRef.current = newMarkers;

    // 自动 fitView
    if (markers.length > 0) {
      mapRef.current.setFitView(null, false, [60, 60, 60, 60]);
    }
  }, [markers, loading]);

  return (
    <div style={{ position: 'relative', ...style }} className={className}>
      {loading && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f5f5', zIndex: 1 }}>
          地图加载中…
        </div>
      )}
      {error && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f5f5', zIndex: 1, color: '#c00' }}>
          {error}
        </div>
      )}
      <div ref={containerRef} style={{ width: '100%', height: '100%', minHeight: 300 }} />
    </div>
  );
}