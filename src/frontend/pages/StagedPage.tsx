import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { db } from '../services/db';
import { useStagedStore } from '../stores/stagedStore';
import { C, btn, btnGhost, btnSmall, card, PageHeader, EmptyState } from '../components/ui';
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
    <div style={{ maxWidth: 640, margin: '0 auto', padding: 24 }}>
      <Link to={`/trip/${tripId}`} style={{ color: C.success, fontSize: 13 }}>&larr; 返回旅程</Link>
      <PageHeader title="暂存箱" right={
        staged.length > 0 ? (
          <button onClick={() => { if (confirm('确定清空暂存箱?')) clearStaged(); }} style={{ ...btnGhost, ...btnSmall, color: C.danger }}>
            清空全部
          </button>
        ) : undefined
      } />

      {staged.length === 0 ? (
        <EmptyState>
          <div style={{ marginBottom: 12 }}>暂存箱为空,去搜索景点添加吧</div>
          <Link to={`/trip/${tripId}/search`} style={{ color: C.primary }}>去搜索景点</Link>
        </EmptyState>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {staged.map((s) => (
            <div key={s.id} style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <strong style={{ fontSize: 14 }}>{s.name}</strong>
                  {s.address && <div style={{ fontSize: 12, color: '#6a6a80', marginTop: 2 }}>{s.address}</div>}
                  <div style={{ fontSize: 11, color: '#5a5a70', marginTop: 2 }}>坐标: {s.lng.toFixed(4)}, {s.lat.toFixed(4)}</div>
                </div>
                <button onClick={() => removeFromStaged(s.id)} style={{ ...btnGhost, ...btnSmall, color: C.danger, flexShrink: 0 }}>
                  移除
                </button>
              </div>
              {dayForItem(s.id) ? (
                <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {days.map((d) => (
                    <button key={d.id} onClick={() => handleAddToDay(s, d.id)} style={{ ...btn(), ...btnSmall }}>
                      Day {d.daySeq}
                    </button>
                  ))}
                  <button onClick={() => setAddingDay(null)} style={{ ...btnGhost, ...btnSmall }}>取消</button>
                </div>
              ) : (
                <button onClick={() => setAddingDay(s.id)} style={{ ...btnGhost, ...btnSmall, marginTop: 10 }}>
                  + 添加到行程
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}