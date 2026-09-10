import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import MapView from '../components/MapView';
import type { MarkerDef } from '../components/MapView';
import { useStagedStore } from '../stores/stagedStore';

const WEB_KEY = import.meta.env.VITE_AMAP_WEB_KEY || '9a5f6f729b7e6e7577d18d31a5d52e97';
// 生产设 VITE_AMAP_PROXY=proxy → 同源代理 /api/amap/place(隐藏 Web 服务 key)
// 未设置(开发)→ 直连 restapi,用 .env 里的 Web 服务 key
const AMAP_PROXY: string | null = import.meta.env.VITE_AMAP_PROXY === 'proxy' ? '/api' : null;

interface SearchResult {
  id: string;
  name: string;
  address: string;
  lng: number;
  lat: number;
  type: string;
}

export default function PoiSearch() {
  const { id: tripId } = useParams<{ id: string }>();
  const [city, setCity] = useState('西宁');
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const { staged, addToStaged, removeFromStaged } = useStagedStore();

  const search = async () => {
    if (!city || !keyword) return;
    setLoading(true);
    setError(null);
    try {
      const cacheKey = `${city}|${keyword}`;
      // 优先走后端代理(隐藏 key);失败回退直连 restapi
      const url = AMAP_PROXY
        ? `${AMAP_PROXY}/api/amap/place?keywords=${encodeURIComponent(keyword)}&city=${encodeURIComponent(city)}`
        : `https://restapi.amap.com/v3/place/text?key=${WEB_KEY}&keywords=${encodeURIComponent(keyword)}&city=${encodeURIComponent(city)}&offset=20`;
      const data = await fetch(url).then((r) => r.json());

      if (data.status !== '1') {
        setError(data.info || '检索失败');
        setResults([]);
        return;
      }

      const mapped: SearchResult[] = (data.pois || []).map((p: any) => {
        const [lng, lat] = p.location.split(',').map(Number);
        return {
          id: p.id,
          name: p.name,
          address: p.address || '',
          lng,
          lat,
          type: p.type || '',
        };
      });
      setResults(mapped);
      setSelected(null);
    } catch {
      setError('网络错误,请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  const addToStagedLocal = (r: SearchResult) => {
    addToStaged({
      id: r.id,
      name: r.name,
      address: r.address,
      lng: r.lng,
      lat: r.lat,
      type: r.type,
    });
  };

  const removeFromStagedLocal = (r: SearchResult) => {
    removeFromStaged(r.id);
  };

  const markers: MarkerDef[] = (selected ? [selected, ...results] : results).map((r) => ({
    id: r.id,
    name: r.name,
    lng: r.lng,
    lat: r.lat,
  }));

  const center: [number, number] | undefined =
    results.length > 0 ? [results[0].lng, results[0].lat] : undefined;

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: 24 }}>
      <Link to={`/trip/${tripId}`}>&larr; 返回旅程</Link>
      <h1>景点检索</h1>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          placeholder="城市"
          value={city}
          onChange={(e) => setCity(e.target.value)}
          style={{ width: 120 }}
        />
        <input
          placeholder="关键词"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          style={{ flex: 1 }}
        />
        <button onClick={search} disabled={loading || !city || !keyword}>
          {loading ? '搜索中…' : '搜索'}
        </button>
      </div>

      {error && <p style={{ color: '#c00' }}>{error}</p>}

      <div style={{ display: 'flex', gap: 16 }}>
        {/* 结果列表 */}
        <div style={{ flex: 1, maxHeight: 400, overflow: 'auto' }}>
          {results.map((r) => (
            <div
              key={r.id}
              onClick={() => setSelected(r)}
              style={{
                padding: 8,
                marginBottom: 4,
                border: selected?.id === r.id ? '2px solid #1677ff' : '1px solid #eee',
                borderRadius: 6,
                cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <strong>{r.name}</strong>
                <div style={{ display: 'flex', gap: 4 }}>
                  <Link
                    to={`/trip/${tripId}/poi?poiId=${r.id}&name=${encodeURIComponent(r.name)}&lng=${r.lng}&lat=${r.lat}&addr=${encodeURIComponent(r.address)}&city=${encodeURIComponent(city)}`}
                    onClick={(e) => e.stopPropagation()}
                    style={{ fontSize: 12 }}
                  >
                    详情
                  </Link>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      addToStagedLocal(r);
                    }}
                    disabled={staged.some((s) => s.id === r.id)}
                    style={{ fontSize: 12 }}
                  >
                    {staged.some((s) => s.id === r.id) ? '已加入' : '+ 暂存'}
                  </button>
                </div>
              </div>
              <div style={{ color: '#888', fontSize: 13 }}>{r.address}</div>
            </div>
          ))}
          {results.length === 0 && !loading && keyword && (
            <p style={{ color: '#aaa' }}>暂无结果,换个关键词试试</p>
          )}
        </div>

        {/* 地图 */}
        <div style={{ flex: 1, minHeight: 400 }}>
          <MapView
            center={center}
            markers={markers}
            onMarkerClick={(m) => {
              const r = results.find((r) => r.id === m.id);
              if (r) setSelected(r);
            }}
            style={{ height: 400 }}
          />
        </div>
      </div>

      {/* 暂存箱 */}
      {staged.length > 0 && (
        <div style={{ marginTop: 20, padding: 12, border: '1px solid #ffc107', borderRadius: 8, background: '#fffde7' }}>
          <h3>暂存箱 ({staged.length})</h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {staged.map((s) => (
              <span
                key={s.id}
                style={{
                  padding: '4px 8px',
                  border: '1px solid #ddd',
                  borderRadius: 12,
                  fontSize: 13,
                  cursor: 'pointer',
                }}
                onClick={() => removeFromStagedLocal(s)}
                title="点击移除"
              >
                {s.name} ✕
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}