import { useEffect, useState } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { db } from '../services/db';
import { getPoiCard } from '../services/llm';
import { useStagedStore } from '../stores/stagedStore';
import type { Poi, PoiAiCard } from '../types';

export default function PoiDetail() {
  const { id: tripId } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const poiId = searchParams.get('poiId');
  const poiName = searchParams.get('name');
  const poiLng = searchParams.get('lng');
  const poiLat = searchParams.get('lat');
  const poiAddr = searchParams.get('addr');
  const city = searchParams.get('city') || '';

  const [poi, setPoi] = useState<Poi | null>(null);
  const [card, setCard] = useState<PoiAiCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [cardLoading, setCardLoading] = useState(false);

  const { addToStaged } = useStagedStore();

  useEffect(() => {
    if (!poiId) return;
    const load = async () => {
      setLoading(true);
      let p = await db.getPoi(poiId);
      if (!p && poiName && poiLng && poiLat) {
        p = {
          id: poiId,
          name: poiName,
          lng: parseFloat(poiLng),
          lat: parseFloat(poiLat),
          address: poiAddr || undefined,
          category: 'poi' as const,
        };
        await db.upsertPoi(p);
      }
      setPoi(p);
      setLoading(false);

      if (p) {
        setCardLoading(true);
        try {
          const c = await getPoiCard({ id: p.id, name: p.name, category: p.category }, city || '');
          setCard(c);
        } finally {
          setCardLoading(false);
        }
      }
    };
    load();
  }, [poiId]);

  if (loading) return <p>加载中…</p>;
  if (!poi) return <p>景点不存在</p>;

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: 24 }}>
      <Link to={`/trip/${tripId}/search`}>&larr; 返回检索</Link>
      <h1>{poi.name}</h1>
      {poi.address && <p style={{ color: '#888' }}>{poi.address}</p>}

      {/* 操作按钮 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <button
          onClick={() => {
            addToStaged({
              id: poi.id,
              name: poi.name,
              address: poi.address || '',
              lng: poi.lng,
              lat: poi.lat,
              type: poi.category || 'poi',
            });
          }}
          style={{ padding: '8px 16px' }}
        >
          + 加入暂存箱
        </button>
      </div>

      {/* AI 卡片 */}
      <div style={{ border: '1px solid #e0e0e0', borderRadius: 8, padding: 16, background: '#fafafa' }}>
        <h2 style={{ marginTop: 0 }}>AI 景点卡片</h2>
        {cardLoading ? (
          <p style={{ color: '#aaa' }}>正在生成卡片…</p>
        ) : card ? (
          <>
            <div style={{ marginBottom: 12 }}>
              <strong>推荐理由</strong>
              <p>{card.recommendReason}</p>
            </div>
            <div style={{ marginBottom: 12 }}>
              <strong>避坑指南</strong>
              <p>{card.pitfallGuide}</p>
            </div>
            <div style={{ marginBottom: 12 }}>
              <strong>建议游玩时长</strong>
              <p>{card.suggestDuration} 分钟</p>
            </div>
            {card.tips.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <strong>小贴士</strong>
                <ul>
                  {card.tips.map((tip, i) => (
                    <li key={i}>{tip}</li>
                  ))}
                </ul>
              </div>
            )}
            <div>
              <strong>评分</strong>
              <p>{'★'.repeat(Math.round(card.rating))} {card.rating}</p>
            </div>
            {card.llmModel && (
              <p style={{ color: '#aaa', fontSize: 12, marginTop: 8 }}>
                由 {card.llmModel} 生成
              </p>
            )}
          </>
        ) : (
          <p style={{ color: '#aaa' }}>卡片生成失败,请检查网络或 LLM Key 配置</p>
        )}
      </div>
    </div>
  );
}