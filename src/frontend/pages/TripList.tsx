import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '../services/db';
import type { Trip } from '../types';
import CreateWizard from '../components/CreateWizard';
import { listBackedUpTrips, restoreTrip, reconcile, removeTripEverywhere } from '../services/sync';
import { isAuthConfigured, signOut } from '../services/auth';
import { C, btn, btnGhost, btnSmall, PageHeader, EmptyState } from '../components/ui';

/** 更新时间格式:今天显示时刻,今年显示月日,更早显示年月日 */
function fmtUpdatedAt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function TripList() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [showWizard, setShowWizard] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const navigate = useNavigate();

  const load = async () => {
    setTrips(await db.listTrips());
  };

  useEffect(() => {
    load();
    // 打开时:自动双向 reconcile(换设备拉取+本地推送),代替旧的单向备份
    runReconcile();
  }, []);

  // 自动同步:先 reconcile,再刷新列表
  const runReconcile = async () => {
    const { pushed, pulled } = await reconcile();
    await load();
    if (pushed || pulled) console.log('[云同步]', `推送 ${pushed} 个,拉取 ${pulled} 个`);
  };

  // 从云端恢复(换设备/浏览器时):拉取云端有但本地没有的旅程
  const handleRestoreFromCloud = async () => {
    setRestoring(true);
    try {
      const cloudIds = await listBackedUpTrips();
      const localIds = new Set((await db.listTrips()).map((t) => t.id));
      const missing = cloudIds.map((c) => c.id).filter((id) => !localIds.has(id));
      if (missing.length === 0) {
        alert('云端没有需要恢复的旅程(都已在本地)。');
      } else {
        let ok = 0;
        for (const id of missing) {
          const r = await restoreTrip(id);
          if (r) ok++;
        }
        alert(`✅ 已从云端恢复 ${ok}/${missing.length} 个旅程。`);
        await load();
      }
    } catch (e: any) {
      alert('恢复失败: ' + (e?.message || '请确认后端已启动(start-dev.sh)'));
    } finally { setRestoring(false); }
  };

  const remove = async (id: string) => {
    if (!confirm('确定删除此旅程?\n(本地和云端备份都会删除,删除后不可恢复)')) return;
    // 必须先删云端:只删本地的话,下次 reconcile 发现"云端有、本地无"会把它拉回来
    const cloudOk = await removeTripEverywhere(id);
    if (!cloudOk) {
      alert('云端备份删除失败(可能网络问题),本次仅删除了本地副本。\n下次同步时它可能会重新出现,请稍后重试删除。');
    }
    await load();
  };

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: 24 }}>
      <PageHeader
        title="我的旅程"
        subtitle="规划 · 优化 · 记账 · 云备份"
        right={isAuthConfigured() && (
          <button onClick={async () => { await signOut(); }} style={{ ...btnGhost, ...btnSmall, color: '#ff6b6b' }}>
            退出登录
          </button>
        )}
      />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <button onClick={() => setShowWizard(!showWizard)} style={{ ...btn(C.success, '#00251a'), fontWeight: 700 }}>
          {showWizard ? '取消' : '+ 新建旅程'}
        </button>
        <button onClick={handleRestoreFromCloud} disabled={restoring} style={{ ...btnGhost, ...btnSmall }} title="换设备/浏览器后,从云端拉回旅程">
          {restoring ? '恢复中…' : '☁️ 从云端恢复'}
        </button>
      </div>

      {showWizard && <CreateWizard onClose={() => setShowWizard(false)} />}

      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {trips.map((t) => (
          <li
            key={t.id}
            style={{
              padding: '15px 16px',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 12,
              marginBottom: 10,
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              background: 'rgba(255,255,255,0.03)',
              transition: 'background 0.15s, border-color 0.15s',
            }}
            onClick={() => navigate(`/trip/${t.id}`)}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.16)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <strong style={{ fontSize: 15 }}>{t.title}</strong>
              <div style={{ color: '#9a9ab2', fontSize: 13, marginTop: 4 }}>
                {t.destination} · {t.startDate} ~ {t.endDate} · {t.status}
                {t.updatedAt && (
                  <span style={{ color: '#6a6a80' }}> · 更新于 {fmtUpdatedAt(t.updatedAt)}</span>
                )}
                {t.cityNodes && t.cityNodes.length > 0 && (
                  <div style={{ color: C.success, fontSize: 12, marginTop: 3, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {t.cityNodes.map((c, i) => <span key={i}>🏨 {c.city} {c.nights}晚</span>)}
                  </div>
                )}
              </div>
            </div>
            <button onClick={(e) => { e.stopPropagation(); remove(t.id); }} style={{ ...btnGhost, ...btnSmall, color: '#ff6b6b', flexShrink: 0 }}>
              删除
            </button>
          </li>
        ))}
      </ul>

      {trips.length === 0 && !showWizard && (
        <EmptyState>还没有旅程,点击上方按钮新建</EmptyState>
      )}
    </div>
  );
}