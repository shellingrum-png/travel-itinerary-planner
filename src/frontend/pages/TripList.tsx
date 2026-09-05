import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db } from '../services/db';
import type { Trip } from '../types';
import seedData from '../seed.json';
import CreateWizard from '../components/CreateWizard';
import { listBackedUpTrips, restoreTrip, backupTrip } from '../services/sync';

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
    // 打开时:把本地所有旅程备份到云端(防止换设备丢失)
    backupAllLocal();
  }, []);

  // 本地旅程都备份到云端
  const backupAllLocal = async () => {
    try {
      const local = await db.listTrips();
      for (const t of local) await backupTrip(t.id);
    } catch { /* 静默 */ }
  };

  // 从云端恢复(换设备/浏览器时):拉取云端有但本地没有的旅程
  const handleRestoreFromCloud = async () => {
    setRestoring(true);
    try {
      const cloudIds = await listBackedUpTrips();
      const localIds = new Set((await db.listTrips()).map((t) => t.id));
      const missing = cloudIds.filter((id) => !localIds.has(id));
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
    if (!confirm('确定删除此旅程?(不会删除云端备份)')) return;
    await db.deleteTrip(id);
    await load();
  };

  const importSeed = async () => {
    setImporting(true);
    try {
      const s = seedData as any;
      const trip = await db.createTrip({
        title: s.trip.title,
        destination: s.trip.destination,
        startDate: s.trip.startDate,
        endDate: s.trip.endDate,
        companionCount: s.trip.companionCount,
        currency: s.trip.currency,
        totalBudget: s.trip.totalBudget,
      });
      const days = await db.listDays(trip.id);
      for (const sd of s.days) {
        const day = days.find((d) => d.daySeq === sd.daySeq);
        if (!day) continue;
        await db.updateItem(day.id, { note: sd.theme });

        for (const lm of (sd.landmarks || [])) {
          const poiId = crypto.randomUUID();
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
      <h1>我的旅程</h1>

      <button onClick={() => setShowWizard(!showWizard)} style={{ background: '#06d6a0', color: '#001', border: 'none', padding: '8px 16px', borderRadius: 6, fontWeight: 600 }}>
        {showWizard ? '取消' : '+ 新建旅程'}
      </button>

      <button
        onClick={importSeed}
        disabled={importing}
        style={{ marginLeft: 8, background: '#1677ff', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 4 }}
      >
        {importing ? '导入中…' : '导入青甘大环线'}
      </button>

      <button
        onClick={handleRestoreFromCloud}
        disabled={restoring}
        style={{ marginLeft: 8, background: 'rgba(255,255,255,0.1)', color: '#ddd', border: '1px solid #444', padding: '6px 12px', borderRadius: 4 }}
        title="换设备/浏览器后,从云端拉回旅程"
      >
        {restoring ? '恢复中…' : '☁️ 从云端恢复'}
      </button>

      {showWizard && <CreateWizard onClose={() => setShowWizard(false)} />}

      <ul style={{ marginTop: 16, listStyle: 'none', padding: 0 }}>
        {trips.map((t) => (
          <li
            key={t.id}
            style={{
              padding: 12,
              border: '1px solid #eee',
              borderRadius: 8,
              marginBottom: 8,
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
            onClick={() => navigate(`/trip/${t.id}`)}
          >
            <div>
              <strong>{t.title}</strong>
              <div style={{ color: '#888', fontSize: 14 }}>
                {t.destination} · {t.startDate} ~ {t.endDate} · {t.status}
                {t.cityNodes && t.cityNodes.length > 0 && (
                  <div style={{ color: '#06d6a0', fontSize: 12, marginTop: 2 }}>
                    {t.cityNodes.map((c) => `${c.city}${c.nights}晚`).join(' · ')}
                  </div>
                )}
              </div>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                remove(t.id);
              }}
            >
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