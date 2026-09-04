import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useDayStore } from '../stores/dayStore';
import { useOptimize } from './useOptimize';
import { addMinutes } from '../utils/time';
import type { ItineraryItem } from '../types';

export default function OptimizePage() {
  const { id, n } = useParams<{ id: string; n: string }>();
  const navigate = useNavigate();
  const { items, loadDay, clearDay } = useDayStore();
  const {
    loading,
    preview,
    error,
    canUndo,
    runOptimize,
    handleConfirm,
    handleCancel,
    handleUndo,
  } = useOptimize();

  const [dayId, setDayId] = useState<string | null>(null);

  useEffect(() => {
    if (!id || !n) return;
    const init = async () => {
      const { db } = await import('../services/db');
      const days = await db.listDays(id);
      const daySeq = Number(n);
      const d = days.find((d) => d.daySeq === daySeq);
      if (d) {
        setDayId(d.id);
        await loadDay(d.id);
      }
    };
    init();
    return () => clearDay();
  }, [id, n]);

  const sorted = [...items].sort((a, b) => a.orderSeq - b.orderSeq);

  const displayTimes = sorted.map((it, i) => {
    const arrive = it.arriveTime ?? '09:00';
    const leave = it.leaveTime ?? addMinutes(arrive, it.visitMinutes ?? 90);
    return { arrive, leave };
  });

  const handleApply = async () => {
    if (!dayId) return;
    await handleConfirm(dayId);
    navigate(`/trip/${id}/day/${n}`);
  };

  const handleCancelOpt = () => {
    handleCancel();
    navigate(`/trip/${id}/day/${n}`);
  };

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: 24 }}>
      <Link to={`/trip/${id}/day/${n}`}>&larr; 返回时间轴</Link>
      <h1>路线优化 · Day {n}</h1>

      {sorted.length < 2 ? (
        <p style={{ color: '#aaa' }}>景点数量不足,无法优化(至少需要 2 个景点)</p>
      ) : (
        <>
          {/* 当前顺序 */}
          <h2>当前顺序</h2>
          <ol style={{ paddingLeft: 20 }}>
            {sorted.map((it, i) => (
              <li key={it.id} style={{ marginBottom: 6 }}>
                <span style={{ color: '#888', fontSize: 12 }}>{displayTimes[i]?.arrive}</span>
                {' '}{it.note ?? it.itemType}
                {it.visitMinutes != null ? ` · ${it.visitMinutes}min` : ''}
              </li>
            ))}
          </ol>

          {!preview ? (
            <div style={{ marginTop: 16 }}>
              <button
                onClick={() => dayId && runOptimize(dayId)}
                disabled={loading}
                style={{ padding: '8px 20px', fontSize: 15, background: '#1677ff', color: '#fff', border: 'none', borderRadius: 6 }}
              >
                {loading ? '计算最优路线中…' : '一键顺路优化'}
              </button>
              {error && <p style={{ color: '#c00', marginTop: 8 }}>{error}</p>}
              {canUndo && (
                <button onClick={handleUndo} style={{ marginLeft: 12, padding: '8px 20px', fontSize: 15, color: '#c00' }}>
                  撤销优化
                </button>
              )}
            </div>
          ) : (
            <div style={{ marginTop: 16 }}>
              <div style={{ padding: 12, background: '#e6f7e6', borderRadius: 8, marginBottom: 16 }}>
                <span style={{ fontWeight: 'bold', color: '#2e7d32', fontSize: 16 }}>
                  预计节省 {preview.savedMinutes} 分钟
                </span>
              </div>

              <h2>优化后顺序</h2>
              <ol style={{ paddingLeft: 20 }}>
                {preview.newOrder.map((origIdx, newIdx) => {
                  const it = sorted[origIdx];
                  if (!it) return null;
                  return (
                    <li key={it.id} style={{ marginBottom: 6, color: '#1677ff' }}>
                      {it.note ?? it.itemType}
                      {it.visitMinutes != null ? ` · ${it.visitMinutes}min` : ''}
                    </li>
                  );
                })}
              </ol>

              <div style={{ marginTop: 20, display: 'flex', gap: 12 }}>
                <button onClick={handleApply} style={{ padding: '8px 20px', fontSize: 15, background: '#1677ff', color: '#fff', border: 'none', borderRadius: 6 }}>
                  确认新顺序
                </button>
                <button onClick={handleCancelOpt} style={{ padding: '8px 20px', fontSize: 15 }}>
                  取消
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}