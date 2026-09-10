import { describe, it, expect, afterAll } from 'vitest';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { db, setActiveDb, migrateLegacyDb, LEGACY_DB_NAME } from '../db';

// 验证：旧版单库(travel_planner)数据能迁移到账号库，老用户数据不丢
describe('旧库迁移', () => {
  const USER = 'legacy-user-9999';
  afterAll(async () => { await setActiveDb(null); });

  it('旧库有数据 → 迁移到账号库', async () => {
    // 1. 造一个"旧版单库"并写入数据（模拟升级前的用户数据）
    const legacy = new Dexie(LEGACY_DB_NAME);
    legacy.version(1).stores({
      trips: 'id, status',
      itineraryDays: 'id, tripId, daySeq',
      pois: 'id, name, mapPoiId',
      poiAiCards: 'poiId, cacheKey',
      itineraryItems: 'id, dayId, orderSeq',
      transports: 'id, tripId',
      hotels: 'id, tripId',
      expenses: 'id, tripId, date, dirty',
      routeCache: 'id, fetchedAt',
      poiSearchCache: 'key, fetchedAt',
      settings: 'key',
    });
    legacy.version(2).stores({ tripTemplates: 'id, cities, daysCount' });
    await legacy.open();
    await legacy.table('trips').add({
      id: 'legacy-trip-1', title: '旧的青甘大环线', status: 'planning',
      destination: '青甘', startDate: '2026-09-25', endDate: '2026-09-26',
      companionCount: 2, currency: 'CNY', totalBudget: 8000,
    });
    await legacy.table('itineraryDays').add({ id: 'd1', tripId: 'legacy-trip-1', daySeq: 1, date: '2026-09-25' });
    legacy.close();

    // 2. 模拟用户首次登录新版本
    await setActiveDb(USER);
    expect((await db.listTrips()).length).toBe(0);  // 账号库初始为空

    const migrated = await migrateLegacyDb(USER);
    expect(migrated).toBe(true);

    // 3. 老数据必须出现在账号库里
    const trips = await db.listTrips();
    expect(trips.length).toBe(1);
    expect(trips[0].id).toBe('legacy-trip-1');
    expect(trips[0].title).toBe('旧的青甘大环线');
    expect((await db.listDays('legacy-trip-1')).length).toBe(1);

    // 清理
    await db.deleteTrip('legacy-trip-1');
    await setActiveDb(null);
  });

  it('账号库已有数据时，不重复迁移（避免覆盖新数据）', async () => {
    // 重新造旧库
    const legacy = new Dexie(LEGACY_DB_NAME);
    legacy.version(1).stores({ trips: 'id, status', itineraryDays: 'id, tripId, daySeq' });
    legacy.version(2).stores({ tripTemplates: 'id, cities, daysCount' });
    await legacy.open();
    await legacy.table('trips').clear();
    await legacy.table('trips').add({ id: 'old-1', title: '旧数据', status: 'planning' });
    legacy.close();

    // 账号库里先有数据
    await setActiveDb(USER);
    const mine = await db.createTrip({
      title: '账号库已有', destination: 'x',
      startDate: '2026-01-01', endDate: '2026-01-01',
      companionCount: 1, currency: 'CNY', totalBudget: 0,
    });

    const migrated = await migrateLegacyDb(USER);
    expect(migrated).toBe(false);                       // 不迁移
    const trips = await db.listTrips();
    expect(trips.length).toBe(1);
    expect(trips[0].title).toBe('账号库已有');           // 新数据未被覆盖

    await db.deleteTrip(mine.id);
    await setActiveDb(null);
  });

  it('旧库不存在 → 返回 false，不报错', async () => {
    const legacy = new Dexie(LEGACY_DB_NAME);
    await legacy.delete();
    await setActiveDb('brand-new-user-0000');
    expect(await migrateLegacyDb('brand-new-user-0000')).toBe(false);
    await setActiveDb(null);
  });
});
