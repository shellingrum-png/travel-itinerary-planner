import { describe, it, expect, afterAll } from 'vitest';
import 'fake-indexeddb/auto';
import { db, setActiveDb, getActiveDb } from '../db';

// 验证：切换账号时数据物理隔离，不会互相清空/污染
describe('按账号分库隔离', () => {
  const USER_A = 'user-aaaa-1111';
  const USER_B = 'user-bbbb-2222';

  afterAll(async () => {
    await setActiveDb(null);
  });

  it('用户A的数据在切到B后仍然存在（关键：换号不丢数据）', async () => {
    // A 登录并创建旅程
    await setActiveDb(USER_A);
    const tripA = await db.createTrip({
      title: 'A的旅程', destination: '青海',
      startDate: '2026-09-25', endDate: '2026-09-27',
      companionCount: 2, currency: 'CNY', totalBudget: 1000,
    });
    expect((await db.listTrips()).length).toBe(1);

    // 切到 B —— 模仿换账号登录
    await setActiveDb(USER_B);
    expect((await db.listTrips()).length).toBe(0);   // B 看不到 A 的数据
    const tripB = await db.createTrip({
      title: 'B的旅程', destination: '云南',
      startDate: '2026-10-01', endDate: '2026-10-02',
      companionCount: 1, currency: 'CNY', totalBudget: 500,
    });
    expect((await db.listTrips()).length).toBe(1);

    // 切回 A —— A 的数据必须还在（旧实现这里会丢）
    await setActiveDb(USER_A);
    const backA = await db.listTrips();
    expect(backA.length).toBe(1);
    expect(backA[0].id).toBe(tripA.id);
    expect(backA[0].title).toBe('A的旅程');

    // 再切回 B，B 也还在
    await setActiveDb(USER_B);
    const backB = await db.listTrips();
    expect(backB.length).toBe(1);
    expect(backB[0].id).toBe(tripB.id);

    // 清理
    await setActiveDb(USER_A); await db.deleteTrip(tripA.id);
    await setActiveDb(USER_B); await db.deleteTrip(tripB.id);
  });

  it('未登录（anon）与已登录账号之间也隔离', async () => {
    await setActiveDb(USER_A);
    const before = (await db.listTrips()).length;

    await setActiveDb(null);   // 登出
    expect((await db.listTrips()).length).toBe(0);  // anon 库为空

    await setActiveDb(USER_A); // 再登录
    expect((await db.listTrips()).length).toBe(before);
  });

  it('数据库名按账号区分', async () => {
    await setActiveDb(USER_A);
    expect(getActiveDb().name).toContain(USER_A);
    await setActiveDb(USER_B);
    expect(getActiveDb().name).toContain(USER_B);
    expect(getActiveDb().name).not.toContain(USER_A);
  });
});
