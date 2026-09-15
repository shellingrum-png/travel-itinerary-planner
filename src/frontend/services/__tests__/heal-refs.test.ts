import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { db, setActiveDb } from '../db';
import { restoreTrip, healExpenseRefs } from '../sync';
import type { TripSnapshot } from '../sync';

// 复现并回归：从云端恢复旅程时，实体 id 被重建 → 账单 refId/dayId 全部悬空
//   → 删景点时按 refId 联动删账单会失效（"行程删了、账单还在"）
//   → 概览「当日花费」只能按日期兜底，可能失准
//
// 修复：restoreTrip 一律沿用快照里的原始 id（day/item/hotel/transport/expense + 账单本身）。
describe('恢复旅程应保持实体 id，账单引用不断链（回归）', () => {
  const USER = 'heal-user';
  let cloudSnap: TripSnapshot | null = null;

  const TRIP = 'trip-heal-1';
  const DAY1 = 'day-1';
  const ITEM_A = 'item-a';   // 景点 天梯山石窟
  const ITEM_H = 'item-h';   // 酒店 item 如家
  const HOTEL_H = 'hotel-h'; // 酒店表记录
  const POI_A = 'poi-a';
  const POI_H = 'poi-h';
  const EXP_TICKET = 'exp-ticket';
  const EXP_HOTEL = 'exp-hotel';

  function makeSnap(): TripSnapshot {
    return {
      trip: {
        id: TRIP, title: '青甘', destination: '青海', startDate: '2026-09-25',
        endDate: '2026-09-27', status: 'planning', companionCount: 2, currency: 'CNY', updatedAt: '2026-09-20T00:00:00.000Z',
      },
      days: [
        { id: DAY1, tripId: TRIP, daySeq: 1, date: '2026-09-25' },
        { id: 'day-2', tripId: TRIP, daySeq: 2, date: '2026-09-26' },
        { id: 'day-3', tripId: TRIP, daySeq: 3, date: '2026-09-27' },
      ],
      items: [
        { id: ITEM_A, dayId: DAY1, orderSeq: 0, itemType: 'poi', poiId: POI_A, transportMode: 'drive' },
        { id: ITEM_H, dayId: DAY1, orderSeq: 1, itemType: 'hotel', poiId: POI_H, transportMode: 'drive' },
      ],
      pois: [
        { id: POI_A, name: '天梯山石窟', lng: 102.6, lat: 37.7, category: 'poi' },
        { id: POI_H, name: '如家商旅酒店', lng: 100.4, lat: 38.9, category: 'hotel' },
      ],
      aiCards: [],
      hotels: [{ id: HOTEL_H, tripId: TRIP, name: '如家商旅酒店', checkIn: '2026-09-25', checkOut: '2026-09-26' }],
      transports: [],
      expenses: [
        { id: EXP_TICKET, tripId: TRIP, category: 'ticket', amount: 30, currency: 'CNY', dirty: 0, refType: 'itinerary_item', refId: ITEM_A, dayId: DAY1, note: '门票 · 天梯山石窟', date: '2026-09-25' },
        { id: EXP_HOTEL, tripId: TRIP, category: 'hotel', amount: 467, currency: 'CNY', dirty: 0, refType: 'itinerary_item', refId: ITEM_H, dayId: DAY1, note: '住宿 · 如家商旅酒店', date: '2026-09-25' },
      ],
      savedAt: '2026-09-20T00:00:00.000Z',
    };
  }

  beforeEach(async () => {
    cloudSnap = makeSnap();
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: any) => {
      const u = String(url);
      if (u.includes('/snapshot/') && (!opts || !opts.method || opts.method === 'GET')) {
        return cloudSnap ? { ok: true, status: 200, json: async () => cloudSnap } as any
                         : { ok: false, status: 404, json: async () => ({}) } as any;
      }
      return { ok: true, json: async () => ({}) } as any;
    }));
    await setActiveDb(USER);
  });

  afterAll(async () => { vi.unstubAllGlobals(); await setActiveDb(null); });

  it('恢复后 day/item/hotel/expense 的 id 原样保留，账单引用不断链', async () => {
    const err = await restoreTrip(TRIP);
    expect(err).toBeNull();

    // day id 保留
    const days = await db.listDays(TRIP);
    expect(days.map((d) => d.id).sort()).toEqual([DAY1, 'day-2', 'day-3'].sort());

    // item id 保留
    expect(await db.listItems(DAY1)).toBeTruthy();
    const items = (await db.listItems(DAY1)).map((i) => i.id);
    expect(items).toContain(ITEM_A);
    expect(items).toContain(ITEM_H);

    // 账单 id 保留 + refId/dayId 命中实体
    const exps = await db.listExpenses(TRIP);
    const ticket = exps.find((e) => e.id === EXP_TICKET)!;
    expect(ticket.refId).toBe(ITEM_A);
    expect(ticket.dayId).toBe(DAY1);
    expect(items).toContain(ticket.refId);
  });

  it('自愈:修复历史遗留的悬空引用（按名称唯一重连，不删不改金额）', async () => {
    await restoreTrip(TRIP);
    // 人为把两条账单的引用打坏,模拟历史数据
    const exps = await db.listExpenses(TRIP);
    for (const e of exps) await db.updateExpense(e.id, { refId: 'stale-' + e.id, dayId: 'stale-day' });

    const before = (await db.listExpenses(TRIP)).reduce((s, e) => s + e.amount, 0);
    const fixed = await healExpenseRefs(TRIP);
    const after = await db.listExpenses(TRIP);

    expect(fixed).toBe(2);
    expect(after.reduce((s, e) => s + e.amount, 0)).toBe(before); // 金额不变
    const ticket = after.find((e) => e.id === EXP_TICKET)!;
    expect(ticket.refId).toBe(ITEM_A);   // 重连到正确 item
    expect(ticket.dayId).toBe(DAY1);     // 重连到正确天
  });

  it('自愈遇到孤儿（行程无对应实体）不动它，不误删', async () => {
    await restoreTrip(TRIP);
    // 打坏两条能匹配的引用(模拟历史数据)
    const exps = await db.listExpenses(TRIP);
    for (const e of exps) await db.updateExpense(e.id, { refId: 'stale-' + e.id, dayId: 'stale-day' });
    // 再造一条 name 匹配不到的孤儿账单,引用也坏
    await db.addExpense({
      tripId: TRIP, category: 'hotel', amount: 999, currency: 'CNY',
      refType: 'itinerary_item', refId: 'ghost', dayId: 'ghost-day',
      note: '住宿 · 九紫吉乃尔大酒店', date: '2026-10-02',
    }, 'exp-orphan');

    const fixed = await healExpenseRefs(TRIP);
    const orphan = (await db.listExpenses(TRIP)).find((e) => e.id === 'exp-orphan')!;
    expect(fixed).toBe(2);                    // 只修那两条能匹配的
    expect(orphan).toBeTruthy();              // 孤儿仍在
    expect(orphan.amount).toBe(999);          // 未改动
    expect(orphan.refId).toBe('ghost');       // 引用未被乱改
  });
});
