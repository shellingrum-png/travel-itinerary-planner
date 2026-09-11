import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '../services/db';
import type { Trip } from '../types';
import seedData from '../seed.json';
import CreateWizard from '../components/CreateWizard';
import { listBackedUpTrips, restoreTrip, reconcile, removeTripEverywhere } from '../services/sync';
import { isAuthConfigured, signOut } from '../services/auth';
import { C, btn, btnGhost, btnSmall } from '../components/ui';
import { uuid } from '../utils/uuid';

export default function TripList() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [showWizard, setShowWizard] = useState(false);
  const [importing, setImporting] = useState(false);
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

  const importSeed = async () => {
    setImporting(true);
    try {
      // 幂等导入:找到本地同名旅程复用其 id(避免每次导入生成新 id → 云端堆积同名多份)
      const s = seedData as any;
      const existing = await db.listTrips();
      const sameTitle = existing.find((t) => t.title === s.trip.title);
      const tripId = sameTitle ? sameTitle.id : uuid();

      // 清除旧同名旅程的全部天数+排点(保留 id 与天数骨架可统一重建)
      const oldDays = await db.listDays(tripId);
      for (const d of oldDays) {
        const items = await db.listItems(d.id);
        for (const it of items) await db.removeItem(it.id);
      }

      // 若没有同名旅程,才新建天数骨架;有则沿用现有天数
      if (!sameTitle) {
        await db.createTrip({
          title: s.trip.title,
          destination: s.trip.destination,
          startDate: s.trip.startDate,
          endDate: s.trip.endDate,
          companionCount: s.trip.companionCount,
          currency: s.trip.currency,
          totalBudget: s.trip.totalBudget,
        }, tripId);
      }
      const days = await db.listDays(tripId);
      for (const sd of s.days) {
        const day = days.find((d) => d.daySeq === sd.daySeq);
        if (!day) continue;
        await db.updateItem(day.id, { note: sd.theme });

        for (const lm of (sd.landmarks || [])) {
          const poiId = uuid();
          const name = typeof lm === 'string' ? lm : lm.name;
          const lng = typeof lm === 'object' ? lm.lng : 0;
          const lat = typeof lm === 'object' ? lm.lat : 0;
          await db.upsertPoi({
            id: poiId,
            name,
            lng,
            lat,
            category: 'poi',
          });
          await db.addItem({
            dayId: day.id,
            poiId,
            itemType: 'poi',
            transportMode: 'walk',
            note: name,
            visitMinutes: 90,
          });
        }
      }
      await load();
    } finally {
      setImporting(false);
    }
  };

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>我的旅程</h1>
      <p style={{ color: '#9a9ab0', fontSize: 13, marginTop: 0, marginBottom: 20 }}>规划 · 优化 · 记账 · 云备份</p>

      {isAuthConfigured() && (
        <button
          onClick={async () => { await signOut(); }}
          style={{ ...btnGhost, ...btnSmall, float: 'right', marginTop: -40, color: '#ff6b6b' }}
        >
          退出登录
        </button>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <button onClick={() => setShowWizard(!showWizard)} style={{ ...btn(C.success, '#001'), fontWeight: 700 }}>
          {showWizard ? '取消' : '+ 新建旅程'}
        </button>
        <button onClick={importSeed} disabled={importing} style={{ ...btn(), opacity: importing ? 0.5 : 1, ...btnSmall }}>
          {importing ? '导入中…' : '导入青甘大环线'}
        </button>
        <button onClick={handleRestoreFromCloud} disabled={restoring} style={{ ...btnGhost, border: '1px solid #333', ...btnSmall }} title="换设备/浏览器后,从云端拉回旅程">
          {restoring ? '恢复中…' : '☁️ 从云端恢复'}
        </button>
      </div>

      {showWizard && <CreateWizard onClose={() => setShowWizard(false)} />}

      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {trips.map((t) => (
          <li
            key={t.id}
            style={{
              padding: 16,
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 12,
              marginBottom: 10,
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              background: 'rgba(255,255,255,0.03)',
              transition: 'background 0.15s, transform 0.05s',
            }}
            onClick={() => navigate(`/trip/${t.id}`)}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
          >
            <div>
              <strong style={{ fontSize: 15 }}>{t.title}</strong>
              <div style={{ color: '#9a9ab0', fontSize: 13, marginTop: 4 }}>
                {t.destination} · {t.startDate} ~ {t.endDate} · {t.status}
                {t.cityNodes && t.cityNodes.length > 0 && (
                  <div style={{ color: C.success, fontSize: 12, marginTop: 2, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {t.cityNodes.map((c, i) => <span key={i}>🏨 {c.city} {c.nights}晚</span>)}
                  </div>
                )}
              </div>
            </div>
            <button onClick={(e) => { e.stopPropagation(); remove(t.id); }} style={{ ...btnGhost, ...btnSmall, color: '#ff6b6b' }}>
              删除
            </button>
          </li>
        ))}
      </ul>

      {trips.length === 0 && !showWizard && (
        <p style={{ color: '#aaa' }}>还没有旅程,点击上方按钮新建</p>
      )}
    </div>
  );
}