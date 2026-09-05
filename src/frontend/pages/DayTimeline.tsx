import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useDayStore } from '../stores/dayStore';
import { useStagedStore } from '../stores/stagedStore';
import { addMinutes } from '../utils/time';
import { useOptimize } from './useOptimize';
import type { ItineraryItem, TransportMode } from '../types';

const TRANSPORT_MODES: TransportMode[] = ['walk', 'drive', 'transit', 'train', 'flight'];
const MODE_LABELS: Record<TransportMode, string> = { walk: '步行', drive: '驾车', transit: '公交', train: '火车', flight: '飞机' };

export default function DayTimeline() {
  const { id, n } = useParams<{ id: string; n: string }>();
  const navigate = useNavigate();
  const {
    dayId,
    items,
    conflicts,
    loadDay,
    addItem,
    updateItem,
    removeItem,
    setVisitMinutes,
    recalcTimeline,
    clearDay,
  } = useDayStore();

  const [newNote, setNewNote] = useState('');
  const [newType, setNewType] = useState<'poi' | 'buffer'>('poi');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editMinutes, setEditMinutes] = useState('');
  const [loadingRoute, setLoadingRoute] = useState<string | null>(null);
  const [expandedConflicts, setExpandedConflicts] = useState(false);
  const { staged, removeFromStaged } = useStagedStore();
  const {
    loading: optimizeLoading,
    preview: optimizePreview,
    error: optimizeError,
    canUndo,
    runOptimize,
    handleConfirm,
    handleCancel,
    handleUndo,
  } = useOptimize();

  useEffect(() => {
    if (!id || !n) return;
    const init = async () => {
      const { db } = await import('../services/db');
      const days = await db.listDays(id);
      const daySeq = Number(n);
      const d = days.find((d) => d.daySeq === daySeq);
      if (d) {
        await loadDay(d.id);
      }
    };
    init();
    return () => clearDay();
  }, [id, n]);

  const sorted = [...items].sort((a, b) => a.orderSeq - b.orderSeq);

  // 显示时间:优先用数据库中的 arriveTime/leaveTime,缺失时级联推算
  const displayTimes = sorted.map((it, i) => {
    const arrive = it.arriveTime ?? '09:00';
    const leave = it.leaveTime ?? addMinutes(arrive, it.visitMinutes ?? 90);
    return { arrive, leave };
  });

  // 初次加载/数据变化时,若时间未推算则自动级联
  useEffect(() => {
    if (sorted.length > 0 && !sorted[0].arriveTime) {
      recalcTimeline();
    }
  }, [items.length]);

  // 切换出行方式 → 调路径 API
  const handleChangeTransport = async (fromIdx: number, toIdx: number, mode: TransportMode) => {
    const from = sorted[fromIdx];
    const to = sorted[toIdx];
    if (!from || !to) return;

    const routeKey = `${from.id}->${to.id}`;
    setLoadingRoute(routeKey);

    // 更新 to 节点的 transportMode
    await updateItem(to.id, { transportMode: mode });

    try {
      const { getDuration } = await import('../services/amap');
      // 需要 POI 坐标来调路径 API，从 db 拿
      const { db } = await import('../services/db');
      let fromLng = 0, fromLat = 0, toLng = 0, toLat = 0;
      let hasCoords = true;

      if (from.poiId) {
        const poi = await db.getPoi(from.poiId);
        if (poi && poi.lng !== 0 && poi.lat !== 0) { fromLng = poi.lng; fromLat = poi.lat; }
        else { hasCoords = false; }
      } else { hasCoords = false; }
      if (to.poiId) {
        const poi = await db.getPoi(to.poiId);
        if (poi && poi.lng !== 0 && poi.lat !== 0) { toLng = poi.lng; toLat = poi.lat; }
        else { hasCoords = false; }
      } else { hasCoords = false; }

      if (!hasCoords) {
        // 无坐标 → 用默认通勤估算
        const defaults: Record<TransportMode, number> = { walk: 15, drive: 5, transit: 20, train: 60, flight: 120 };
        const dur = defaults[mode] || 15;
        await applyCommute(from, to, dur);
        return;
      }

      const result = await getDuration([fromLng, fromLat], [toLng, toLat], mode);
      await applyCommute(from, to, result.durationMin);
    } catch {
      // 失败用默认值
      const defaults: Record<TransportMode, number> = { walk: 15, drive: 5, transit: 20, train: 60, flight: 120 };
      await applyCommute(from, to, defaults[mode] || 15);
    } finally {
      setLoadingRoute(null);
    }
  };

  const applyCommute = async (from: ItineraryItem, to: ItineraryItem, durationMin: number) => {
    const fromLeave = from.leaveTime ?? from.arriveTime ?? '09:00';
    const newArrive = addMinutes(fromLeave, durationMin);
    const newLeave = addMinutes(newArrive, to.visitMinutes ?? 90);
    await updateItem(to.id, { arriveTime: newArrive, leaveTime: newLeave });
  };

  const handleAdd = async () => {
    if (!newNote.trim() || !dayId) return;
    await addItem({
      dayId,
      itemType: newType,
      transportMode: 'walk',
      note: newNote.trim(),
    });
    setNewNote('');
  };

  const handleStagedAdd = async (s: { id: string; name: string; lng: number; lat: number }) => {
    if (!dayId) return;
    const { db } = await import('../services/db');
    await db.upsertPoi({
      id: s.id,
      name: s.name,
      lng: s.lng,
      lat: s.lat,
      category: 'poi',
    });
    await addItem({
      dayId,
      poiId: s.id,
      itemType: 'poi',
      transportMode: 'walk',
      note: s.name,
      visitMinutes: 90,
    });
    removeFromStaged(s.id);
  };

  const handleEditMinutes = async (itemId: string) => {
    const mins = parseInt(editMinutes, 10);
    if (isNaN(mins) || mins < 0) return;
    await setVisitMinutes(itemId, mins);
    setEditingId(null);
    setEditMinutes('');
  };

  const handleDelete = async (itemId: string) => {
    await removeItem(itemId);
  };

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: 24 }}>
      <Link to={`/trip/${id}`}>&larr; 返回旅程</Link>
      <h1>Day {n}</h1>

      {conflicts.length > 0 && (
        <div style={{ background: '#fff3cd', padding: 8, borderRadius: 6, marginBottom: 12 }}>
          <div
            onClick={() => setExpandedConflicts(!expandedConflicts)}
            style={{ cursor: 'pointer', fontWeight: 'bold', display: 'flex', justifyContent: 'space-between' }}
          >
            <span>⚠️ {conflicts.length} 个冲突</span>
            <span>{expandedConflicts ? '收起' : '展开'}</span>
          </div>
          {expandedConflicts && (
            <div style={{ marginTop: 8 }}>
              {conflicts.map((c, i) => (
                <div key={i} style={{ color: c.level === 'red' ? '#d32f2f' : '#856404', marginBottom: 4 }}>
                  {c.level === 'red' ? '🔴' : '⚠️'} {c.message}
                  <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                    {c.type === 'overlap' && '建议: 调整游览时长或删除冲突节点'}
                    {c.type === 'closed' && '建议: 调整日期或更换景点'}
                    {c.type === 'tight_transit' && '建议: 预留更多通勤时间或改出行方式'}
                    {c.type === 'over_budget' && '建议: 调整预算或控制消费'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 操作栏: 一键优化 + 撤销 */}
      {sorted.length >= 2 && (
        <div style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
          {!optimizePreview ? (
            <button
              onClick={() => dayId && runOptimize(dayId)}
              disabled={optimizeLoading}
              style={{ padding: '6px 12px' }}
            >
              {optimizeLoading ? '计算中…' : '一键顺路优化'}
            </button>
          ) : (
            <>
              <span style={{ color: '#1677ff', fontWeight: 'bold' }}>
                预计节省 {optimizePreview.savedMinutes} 分钟
              </span>
              <button onClick={() => dayId && handleConfirm(dayId)} style={{ padding: '6px 12px', background: '#1677ff', color: '#fff', border: 'none', borderRadius: 4 }}>
                确认新顺序
              </button>
              <button onClick={handleCancel} style={{ padding: '6px 12px' }}>
                取消
              </button>
            </>
          )}
          {canUndo && !optimizePreview && (
            <button onClick={handleUndo} style={{ padding: '6px 12px', color: '#c00' }}>
              撤销优化
            </button>
          )}
          {optimizeError && <span style={{ color: '#c00', fontSize: 13 }}>{optimizeError}</span>}
        </div>
      )}

      {sorted.length === 0 ? (
        <p style={{ color: '#aaa' }}>今天还没有安排,去暂存箱换个景点进来</p>
      ) : (
        <ol style={{ paddingLeft: 20 }}>
          {sorted.map((it, i) => {
            const next = sorted[i + 1];
            const routeKey = `${it.id}->${next?.id}`;
            return (
              <li key={it.id} style={{ marginBottom: 10, padding: 8, border: '1px solid #eee', borderRadius: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong>
                    {displayTimes[i]?.arrive || '--:--'} – {displayTimes[i]?.leave || '--:--'}
                  </strong>
                  <button
                    onClick={() => handleDelete(it.id)}
                    style={{ color: '#c00', border: 'none', background: 'none', cursor: 'pointer' }}
                  >
                    删除
                  </button>
                </div>
                <div>
                  {it.note ?? it.itemType}
                  {it.visitMinutes != null ? ` · ${it.visitMinutes}min` : ''}
                </div>

                {/* 通勤方式选择（两个节点之间） */}
                {next && (
                  <div style={{ marginTop: 6, padding: '4px 8px', background: '#f5f5f5', borderRadius: 4, fontSize: 13 }}>
                    <span style={{ color: '#888' }}>↓ 通勤: </span>
                    {TRANSPORT_MODES.map((mode) => (
                      <button
                        key={mode}
                        onClick={() => handleChangeTransport(i, i + 1, mode)}
                        disabled={loadingRoute === routeKey}
                        style={{
                          marginLeft: 4,
                          padding: '2px 6px',
                          fontSize: 12,
                          fontWeight: it.transportMode === mode ? 'bold' : 'normal',
                          border: it.transportMode === mode ? '2px solid #1677ff' : '1px solid #ddd',
                          borderRadius: 4,
                          background: it.transportMode === mode ? '#e6f0ff' : '#fff',
                          cursor: 'pointer',
                        }}
                      >
                        {MODE_LABELS[mode]}
                      </button>
                    ))}
                    {loadingRoute === routeKey && <span style={{ marginLeft: 8, color: '#aaa' }}>计算中…</span>}
                  </div>
                )}

                {/* 编辑游览时长 */}
                {editingId === it.id ? (
                  <div style={{ marginTop: 4 }}>
                    <input
                      type="number"
                      value={editMinutes}
                      onChange={(e) => setEditMinutes(e.target.value)}
                      placeholder="分钟"
                      style={{ width: 80 }}
                    />
                    <button onClick={() => handleEditMinutes(it.id)}>确认</button>
                    <button onClick={() => setEditingId(null)}>取消</button>
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      setEditingId(it.id);
                      setEditMinutes(String(it.visitMinutes ?? 90));
                    }}
                    style={{ fontSize: 12, marginTop: 4 }}
                  >
                    改游览时长
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {/* 暂存箱 */}
      {staged.length > 0 && (
        <div style={{ marginTop: 16, padding: 12, border: '1px solid #ffc107', borderRadius: 8, background: '#fffde7' }}>
          <h3 style={{ margin: 0 }}>暂存箱 ({staged.length})</h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            {staged.map((s) => (
              <span
                key={s.id}
                style={{
                  padding: '4px 12px',
                  border: '1px solid #ddd',
                  borderRadius: 12,
                  fontSize: 13,
                  cursor: 'pointer',
                  background: '#fff',
                }}
                onClick={() => handleStagedAdd(s)}
                title="点击添加到当天"
              >
                + {s.name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 添加节点 */}
      <div style={{ marginTop: 20, padding: 12, border: '1px dashed #ccc', borderRadius: 8 }}>
        <select value={newType} onChange={(e) => setNewType(e.target.value as 'poi' | 'buffer')}>
          <option value="poi">景点</option>
          <option value="buffer">缓冲/休息</option>
        </select>
        <input
          placeholder="名称"
          value={newNote}
          onChange={(e) => setNewNote(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
        />
        <button onClick={handleAdd} disabled={!newNote.trim()}>
          添加
        </button>
      </div>
    </div>
  );
}