import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { db, setActiveDb } from '../db';
import { reconcile, backupTrip } from '../sync';

// 复现并回归线上问题：添加景点后，同步会把它抹掉（要加两次才生效）
//
// 根因：备份发生在修改【之后】。若云端用服务端 now() 作为 updated_at，
// 它必然大于本地 trip.updatedAt → 下次 reconcile 判定「云端更新」
// → restoreTrip 用云端快照整体覆盖本地 → 新加的内容被回滚。
//
// 修复：① 所有内容变更都 touchTrip（刷新本地 updatedAt）
//       ② 备份成功后前端把 updatedAt 对齐到快照 savedAt
//       ③ 后端 updated_at 存 snap.savedAt（而非服务端 now）
// → 两边收敛为相等，reconcile 跳过，不再覆盖。
describe('添加数据后同步不应覆盖（回归）', () => {
  const USER = 'bump-user';
  let cloudSnap: any = null;
  let cloudUpdatedAt = '';

  beforeEach(async () => {
    cloudSnap = null; cloudUpdatedAt = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: any) => {
      const u = String(url);
      if (u.endsWith('/snapshot') && (!opts || !opts.method || opts.method === 'GET')) {
        return { ok: true, json: async () => (cloudSnap ? [{ id: cloudSnap.trip.id, updatedAt: cloudUpdatedAt }] : []) } as any;
      }
      if (u.includes('/snapshot/') && (!opts || !opts.method || opts.method === 'GET')) {
        if (!cloudSnap) return { ok: false, status: 404, json: async () => ({}) } as any;
        return { ok: true, status: 200, json: async () => cloudSnap } as any;
      }
      if (opts?.method === 'PUT') {
        cloudSnap = JSON.parse(opts.body);
        // 后端已改为存快照自带的 savedAt
        cloudUpdatedAt = cloudSnap.savedAt;
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    }));
    await setActiveDb(USER);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await setActiveDb(null);
  });

  it('添加景点 → 备份 → 再同步，景点仍在', async () => {
    const trip = await db.createTrip({
      title: '测试', destination: 'x',
      startDate: '2026-09-25', endDate: '2026-09-25',
      companionCount: 1, currency: 'CNY', totalBudget: 0,
    });
    const day = (await db.listDays(trip.id))[0];

    // 添加景点（应刷新 trip.updatedAt）
    await db.upsertPoi({ id: 'poi-wuwei', name: '武威文庙', lng: 102.6, lat: 37.9, category: 'poi', address: '武威市' });
    await db.addItem({ dayId: day.id, poiId: 'poi-wuwei', itemType: 'poi', transportMode: 'walk', note: '武威文庙', visitMinutes: 90 });
    expect((await db.listItems(day.id)).length).toBe(1);

    // 自动备份（真实流程）
    await backupTrip(trip.id);
    expect(cloudSnap).not.toBeNull();

    // 备份后本地时间戳应对齐到云端值
    const localTrip = await db.getTrip(trip.id);
    expect(localTrip!.updatedAt).toBe(cloudUpdatedAt);

    // 再同步一次 → 时间相等 → 跳过，绝不覆盖
    await reconcile();
    const after = await db.listItems(day.id);
    expect(after.length, '添加的景点被同步覆盖了').toBe(1);
    expect(after[0].note).toBe('武威文庙');

    await db.deleteTrip(trip.id);
  });

  it('多设备场景：云端更新的快照仍应能拉取下来', async () => {
    const trip = await db.createTrip({
      title: '测试2', destination: 'y',
      startDate: '2026-10-01', endDate: '2026-10-01',
      companionCount: 1, currency: 'CNY', totalBudget: 0,
    });
    const day = (await db.listDays(trip.id))[0];
    await backupTrip(trip.id);

    // 模拟另一台设备更新了云端：含新景点、savedAt 更晚
    cloudSnap = {
      trip: { ...trip, updatedAt: new Date(Date.now() + 60_000).toISOString() },
      days: [{ id: day.id, tripId: trip.id, daySeq: 1, date: day.date }],
      items: [{ id: 'i-remote', dayId: day.id, itemType: 'poi', orderSeq: 0, transportMode: 'walk', note: '远端加的景点', visitMinutes: 60 }],
      pois: [{ id: 'poi-remote', name: '远端加的景点', lng: 100, lat: 30, category: 'poi' }],
      aiCards: [], hotels: [], transports: [], expenses: [],
      savedAt: new Date(Date.now() + 60_000).toISOString(),
    };
    cloudUpdatedAt = cloudSnap.savedAt;

    await reconcile();
    // 注意：restoreTrip 会重建旅程 → day id 会变，须重新取
    const daysAfter = await db.listDays(trip.id);
    const all = daysAfter.length ? await db.listItems(daysAfter[0].id) : [];
    expect(all.some((i) => i.note === '远端加的景点'), '云端更新未被拉取').toBe(true);

    await db.deleteTrip(trip.id);
  });
});
