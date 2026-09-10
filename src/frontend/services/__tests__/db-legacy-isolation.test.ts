import { describe, it, expect, afterAll } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { db, setActiveDb, migrateLegacyDb, LEGACY_DB_NAME } from '../db';

// 回归测试：第二个账号登录时【不能】继承旧库数据
// （线上事故：migrateLegacyDb 迁移后没销毁旧库 → 新账号看到别人的旅程）
describe('旧库继承隔离（回归）', () => {
  const USER_A = 'user-a-first';
  const USER_B = 'user-b-second';

  async function seedLegacy() {
    const legacy = new Dexie(LEGACY_DB_NAME);
    legacy.version(1).stores({ trips: 'id, status', itineraryDays: 'id, tripId, daySeq' });
    legacy.version(2).stores({ tripTemplates: 'id, cities, daysCount' });
    await legacy.open();
    await legacy.table('trips').clear();
    await legacy.table('trips').add({ id: 'legacy-1', title: '主人的青甘线', status: 'planning' });
    legacy.close();
  }

  afterAll(async () => {
    await Dexie.delete(LEGACY_DB_NAME).catch(() => {});
    await setActiveDb(null);
  });

  it('第一个账号拿到旧数据，第二个账号必须拿到空库', async () => {
    await seedLegacy();

    // 账号 A 登录 → 应该继承旧数据
    await setActiveDb(USER_A);
    await migrateLegacyDb(USER_A);
    const aTrips = await db.listTrips();
    expect(aTrips.length).toBe(1);
    expect(aTrips[0].id).toBe('legacy-1');

    // 关键断言：旧库已被销毁，B 不可能再继承
    expect(await Dexie.exists(LEGACY_DB_NAME)).toBe(false);

    // 账号 B 登录 → 必须是空库（修复前这里会拿到 legacy-1）
    await setActiveDb(USER_B);
    await migrateLegacyDb(USER_B);
    const bTrips = await db.listTrips();
    expect(bTrips.length).toBe(0);

    // 清理
    await setActiveDb(USER_A); await db.deleteTrip('legacy-1');
    await setActiveDb(null);
  });

  it('迁移会记录历史 id，供清理已污染的数据', async () => {
    const { getLegacyTripIds } = await import('../db');
    await seedLegacy();
    await setActiveDb('user-record-test');
    await migrateLegacyDb('user-record-test');
    const ids = getLegacyTripIds();
    expect(ids).toContain('legacy-1');
    await setActiveDb('user-record-test');
    await db.deleteTrip('legacy-1');
    await setActiveDb(null);
  });
});
