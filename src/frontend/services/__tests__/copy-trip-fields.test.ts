import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import 'fake-indexeddb/auto';
import { db, setActiveDb } from '../db';

// 回归：复制到新行程时必须带上 totalBudget 等字段。
//
// 线上表现：复制出的行程「看不到记账」—— 因为详情页的花费区以
// `trip.totalBudget` 为显示条件，而复制时漏了它 → 整块 UI 被隐藏，
// 用户以为记账没复制过来（其实 expenses 都在）。
describe('复制行程字段完整性（回归）', () => {
  const USER = 'copy-fields-user';

  beforeEach(async () => { await setActiveDb(USER); });
  afterAll(async () => { await setActiveDb(null); });

  it('createTrip 保留 totalBudget（详情页花费区的显示条件）', async () => {
    // 源行程带预算
    const src = await db.createTrip({
      title: '原版', destination: '青甘',
      startDate: '2026-09-25', endDate: '2026-09-25',
      companionCount: 2, currency: 'CNY', totalBudget: 15000,
      cityNodes: [{ city: '西宁', nights: 1 }] as any,
    });
    expect(src.totalBudget).toBe(15000);

    // 模拟复制：带上所有业务字段
    const copy = await db.createTrip({
      title: '原版(优化版)',
      destination: src.destination,
      startDate: src.startDate,
      endDate: src.endDate,
      companionCount: src.companionCount,
      currency: src.currency,
      totalBudget: src.totalBudget,   // ← 本次修复补上
      cityNodes: src.cityNodes,
    });

    expect(copy.totalBudget, '复制后应保留预算,否则花费区被隐藏').toBe(15000);
    expect(copy.companionCount).toBe(2);
    expect(copy.currency).toBe('CNY');
    expect(copy.destination).toBe('青甘');
    expect(copy.cityNodes).toEqual([{ city: '西宁', nights: 1 }]);
    // 新行程状态应为 planning,标题应可改
    expect(copy.status).toBe('planning');
    expect(copy.title).toBe('原版(优化版)');

    await db.deleteTrip(src.id);
    await db.deleteTrip(copy.id);
  });

  it('源行程未设预算时,复制后也不应有预算（不凭空造数）', async () => {
    const src = await db.createTrip({
      title: '无预算', destination: 'x',
      startDate: '2026-10-01', endDate: '2026-10-01',
      companionCount: 1, currency: 'CNY', totalBudget: undefined,
    });
    const copy = await db.createTrip({
      title: '无预算(副本)', destination: src.destination,
      startDate: src.startDate, endDate: src.endDate,
      companionCount: src.companionCount, currency: src.currency,
      totalBudget: src.totalBudget, cityNodes: src.cityNodes,
    });
    expect(copy.totalBudget).toBeUndefined();

    await db.deleteTrip(src.id);
    await db.deleteTrip(copy.id);
  });
});
