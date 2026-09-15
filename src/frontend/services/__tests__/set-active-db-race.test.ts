import { describe, it, expect, afterAll } from 'vitest';
import 'fake-indexeddb/auto';
import { db, setActiveDb, getActiveDb } from '../db';

// 复现并回归：页面加载时 Supabase 连发多个 auth 事件 → setActiveDb 被并发调用。
// 旧实现两个调用交错:「A 设好新库 → B 的 activeDb.close() 关掉这个新库」
// → 整个库被关 → 后续查询全报 DatabaseClosedError（表现为「1 个旅程同步失败」红条）。
describe('setActiveDb 并发调用不应把数据库关掉（回归）', () => {
  const USER = 'race-user';

  afterAll(async () => { await setActiveDb(null); });

  it('同一账号并发切换后,库仍处于打开状态且可查询', async () => {
    // 模拟 auth 事件连发:同一用户多次并发调用
    await Promise.all([
      setActiveDb(USER),
      setActiveDb(USER),
      setActiveDb(USER),
    ]);
    const activeDb: any = getActiveDb();
    expect(activeDb.isOpen()).toBe(true);
    // 真实查询不报 DatabaseClosedError
    await expect(db.listTrips()).resolves.toBeInstanceOf(Array);
  });

  it('并发切换不同账号,最终库可用', async () => {
    await Promise.all([
      setActiveDb('race-a'),
      setActiveDb('race-b'),
      setActiveDb(USER),
    ]);
    const activeDb: any = getActiveDb();
    expect(activeDb.isOpen()).toBe(true);
    await expect(db.listTrips()).resolves.toBeInstanceOf(Array);
    expect(activeDb.name).toContain(USER);
  });
});
