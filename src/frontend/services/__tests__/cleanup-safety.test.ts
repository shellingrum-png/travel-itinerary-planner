import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { db, setActiveDb, migrateLegacyDb, LEGACY_DB_NAME, getLegacyTripIds } from '../db';
import { reconcile } from '../sync';

// 真实调用 reconcile（mock 掉 fetch），验证：
//  a) 继承来的脏数据（云端不属于本账号）被清掉
//  b) 主账号自己的数据（云端有）绝不会被误删
describe('reconcile 脏数据清理', () => {
  const USER = 'cleanup-user';

  // 用 mock 控制云端快照列表
  let cloudTrips: { id: string; updatedAt: string }[] = [];
  let cloudSnaps: Record<string, any> = {};
  const putTrips: string[] = [];

  beforeEach(async () => {
    cloudTrips = [];
    cloudSnaps = {};
    putTrips.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: any) => {
      const u = String(url);
      // 快照列表
      if (u.endsWith('/snapshot') && (!opts || opts.method === undefined || opts.method === 'GET')) {
        return { ok: true, json: async () => cloudTrips } as any;
      }
      // 单条快照读取
      if (u.includes('/snapshot/') && (!opts || opts.method === undefined || opts.method === 'GET')) {
        const id = u.split('/snapshot/')[1];
        const snap = cloudSnaps[id];
        if (!snap) return { ok: false, status: 404, json: async () => ({}) } as any;
        return { ok: true, status: 200, json: async () => snap } as any;
      }
      if (opts?.method === 'PUT') {
        putTrips.push(u.split('/snapshot/')[1]);
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    }));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await Dexie.delete(LEGACY_DB_NAME).catch(() => {});
    await setActiveDb(null);
  });

  it('继承来的脏数据（云端没有）被清理；自己的数据被推送而非删除', async () => {
    // 造旧库 + 迁移（生成 legacy id 记录）
    const legacy = new Dexie(LEGACY_DB_NAME);
    legacy.version(1).stores({ trips: 'id, status', itineraryDays: 'id, tripId, daySeq' });
    legacy.version(2).stores({ tripTemplates: 'id, cities, daysCount' });
    await legacy.open();
    await legacy.table('trips').clear();
    await legacy.table('trips').add({ id: 'inherited-dirty', title: '别人账号的旅程', status: 'planning' });
    legacy.close();

    await setActiveDb(USER);
    await migrateLegacyDb(USER);
    expect(getLegacyTripIds()).toContain('inherited-dirty');

    // 自己新建一条（不在遗产清单里）
    const mine = await db.createTrip({
      title: '我自己的旅程', destination: 'x',
      startDate: '2026-01-01', endDate: '2026-01-01',
      companionCount: 1, currency: 'CNY', totalBudget: 0,
    });

    // 云端：两条都没有
    cloudTrips = [];
    await reconcile();

    const after = await db.listTrips();
    const ids = after.map((t) => t.id);
    expect(ids).not.toContain('inherited-dirty');  // ✅ 脏数据被清
    expect(ids).toContain(mine.id);                // ✅ 自己的保留
    expect(putTrips).toContain(mine.id);           // ✅ 自己的被推送

    await db.deleteTrip(mine.id);
    await setActiveDb(null);
  });

  it('id 在遗产清单但云端【有】→ 不能删（保护主账号数据）', async () => {
    // 手动登记一个"遗产 id"
    localStorage.setItem('travel_legacy_claimed_ids', JSON.stringify(['shared-id']));
    await setActiveDb('guard-user');
    const t = await db.createTrip({
      title: '主账号的数据', destination: 'x',
      startDate: '2026-01-01', endDate: '2026-01-01',
      companionCount: 1, currency: 'CNY', totalBudget: 0,
    }, 'shared-id');

    // 云端【有】这条（属于本账号），给一个较旧的 updatedAt 使本地保持不动
    const oldTs = new Date(Date.now() - 86400_000).toISOString();
    cloudTrips = [{ id: 'shared-id', updatedAt: oldTs }];
    cloudSnaps['shared-id'] = {
      trip: { id: 'shared-id', title: '主账号的数据', destination: 'x', startDate: '2026-01-01', endDate: '2026-01-01', companionCount: 1, currency: 'CNY', totalBudget: 0, status: 'planning', updatedAt: oldTs },
      days: [], items: [], pois: [], aiCards: [], hotels: [], transports: [], expenses: [], savedAt: oldTs,
    };
    await reconcile();

    const ids = (await db.listTrips()).map((x) => x.id);
    expect(ids).toContain('shared-id');   // ✅ 未被误删

    await db.deleteTrip('shared-id');
    await setActiveDb(null);
  });
});
