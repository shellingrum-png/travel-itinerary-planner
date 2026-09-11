import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { db, setActiveDb } from '../db';
import { removeTripEverywhere, reconcile } from '../sync';

// 复现线上问题：删除旅程后它又自己回来了
//
// 根因：TripList 的删除只调 db.deleteTrip（删本地），从未调 removeBackup（删云端）。
// → 云端仍有快照 → 下次 reconcile 判定「云端有、本地无」→ restoreTrip 拉回来。
describe('删除旅程应先删云端（回归）', () => {
  const USER = 'delete-user';
  let cloud: Map<string, any>;
  let putCount = 0;

  beforeEach(async () => {
    cloud = new Map();
    putCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: any) => {
      const u = String(url);
      const m = u.match(/\/snapshot\/([^/?]+)$/);
      if (u.endsWith('/snapshot') && (!opts || !opts.method || opts.method === 'GET')) {
        return { ok: true, json: async () => [...cloud.entries()].map(([id, s]) => ({ id, updatedAt: s.savedAt })) } as any;
      }
      if (m && opts?.method === 'DELETE') {
        cloud.delete(m[1]);
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
      }
      if (m && (!opts || !opts.method || opts.method === 'GET')) {
        const s = cloud.get(m[1]);
        return s ? { ok: true, status: 200, json: async () => s } as any
                 : { ok: false, status: 404, json: async () => ({}) } as any;
      }
      if (opts?.method === 'PUT') {
        const id = u.split('/snapshot/')[1];
        cloud.set(id, JSON.parse(opts.body));
        putCount++;
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    }));
    await setActiveDb(USER);
  });

  afterAll(async () => { vi.unstubAllGlobals(); await setActiveDb(null); });

  async function makeTrip(title: string) {
    return db.createTrip({
      title, destination: 'x', startDate: '2026-09-25', endDate: '2026-09-25',
      companionCount: 1, currency: 'CNY', totalBudget: 0,
    });
  }

  it('删除后云端也没了，且 reconcile 不会把它拉回来', async () => {
    const trip = await makeTrip('要删的');
    // 先备份到云端
    const { backupTrip } = await import('../sync');
    await backupTrip(trip.id);
    expect(cloud.has(trip.id), '前置：云端应有备份').toBe(true);

    // 删除（新逻辑：先删云端再删本地）
    const ok = await removeTripEverywhere(trip.id);
    expect(ok).toBe(true);
    expect(cloud.has(trip.id), '云端应已删除').toBe(false);
    expect(await db.getTrip(trip.id), '本地应已删除').toBeNull();

    // 再同步 → 不应复活
    await reconcile();
    expect(await db.getTrip(trip.id), '删除后被同步拉回来了').toBeNull();
    expect((await db.listTrips()).length).toBe(0);
  });

  it('云端删除失败时【不删本地】，避免删了又复活', async () => {
    const trip = await makeTrip('网络故障');
    const { backupTrip } = await import('../sync');
    await backupTrip(trip.id);

    // 让 DELETE 失败
    const realFetch = globalThis.fetch as any;
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: any) => {
      if (opts?.method === 'DELETE') return { ok: false, status: 500, json: async () => ({}) } as any;
      return realFetch(url, opts);
    }));

    const ok = await removeTripEverywhere(trip.id);
    expect(ok, '云端失败应返回 false').toBe(false);
    // 本地必须保留 —— 否则会造成"本地无、云端有"→下次同步复活
    expect(await db.getTrip(trip.id), '云端失败时不该删本地').not.toBeNull();

    await db.deleteTrip(trip.id);
  });
});
