import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { db } from '../services/db';
import { useStagedStore } from '../stores/stagedStore';
import type { ItineraryDay } from '../types';

export default function StagedPage() {
  const { id: tripId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { staged, removeFromStaged, clearStaged } = useStagedStore();
  const [days, setDays] = useState<ItineraryDay[]>([]);
  const [addingDay, setAddingDay] = useState<string | null>(null);

  useEffect(() => {
    if (!tripId) return;
    db.listDays(tripId).then(setDays);
  }, [tripId]);

  const handleAddToDay = async (stagedItem: typeof staged[0], dayId: string) => {
    await db.upsertPoi({
      id: stagedItem.id,
      name: stagedItem.name,
      lng: stagedItem.lng,
      lat: stagedItem.lat,
      category: 'poi',
    });
    await db.addItem({
      dayId,
      poiId: stagedItem.id,
      itemType: 'poi',
      transportMode: 'walk',
      note: stagedItem.name,
      visitMinutes: 90,
    });
    removeFromStaged(stagedItem.id);
  };

  const dayForItem = (itemId: string) => {
    return addingDay === itemId;
  };

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: 24 }}>
      <Link to={`/trip/${tripId}`}>&larr; 返回旅程</Link>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>暂存箱</h1>
        {staged.length > 0 && (
          <button onClick={() => { if (confirm('确定清空暂存箱?')) clearStaged(); }} style={{ fontSize: 12, color: '#c00' }}>
            清空全部
          </button>
        )}
      </div>

      {staged.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <p style={{ color: '#aaa', marginBottom: 16 }}>暂存箱为空,去搜索景点添加吧</p>
          <Link to={`/trip/${tripId}/search`} style={{ color: '#1677ff' }}>去搜索景点</Link>
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {staged.map((s) => (
            <li key={s.id} style={{ padding: 12, border: '1px solid #eee', borderRadius: 8, marginBottom: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <strong>{s.name}</strong>
                  {s.address && <div style={{ fontSize: 13, color: '#888' }}>{s.address}</div>}
                  <div style={{ fontSize: 12, color: '#aaa' }}>坐标: {s.lng.toFixed(4)}, {s.lat.toFixed(4)}</div>
                </div>
                <button onClick={() => removeFromStaged(s.id)} style={{ color: '#c00', border: 'none', background: 'none', cursor: 'pointer' }}>
                  移除
                </button>
              </div>
              {dayForItem(s.id) ? (
                <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {days.map((d) => (
                    <button
                      key={d.id}
                      onClick={() => handleAddToDay(s, d.id)}
                      style={{ padding: '4px 10px', fontSize: 12, background: '#1677ff', color: '#fff', border: 'none', borderRadius: 4 }}
                    >
                      Day {d.daySeq}
                    </button>
                  ))}
                  <button onClick={() => setAddingDay(null)} style={{ padding: '4px 10px', fontSize: 12 }}>取消</button>
                </div>
              ) : (
                <button
                  onClick={() => setAddingDay(s.id)}
                  style={{ marginTop: 8, fontSize: 12, background: '#f0f0f0', border: '1px solid #ddd', borderRadius: 4, padding: '4px 10px' }}
                >
                  + 添加到行程
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}