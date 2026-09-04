import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'fake-indexeddb/auto';
import { travelDb } from '../dexie';

describe('Dexie 数据层', () => {
  beforeAll(async () => {
    await travelDb.delete({ disableAutoOpen: false });
    await travelDb.open();
  });

  afterAll(async () => {
    await travelDb.delete({ disableAutoOpen: false });
  });

  it('createTrip 自动生成 itinerary_days', async () => {
    const trip = await travelDb.createTrip({
      title: '青海国庆 7 日',
      destination: '青海格尔木',
      startDate: '2026-10-01',
      endDate: '2026-10-07',
      companionCount: 2,
      currency: 'CNY',
      totalBudget: 8000,
    });

    expect(trip.id).toBeTruthy();
    expect(trip.status).toBe('planning');

    const days = await travelDb.listDays(trip.id);
    expect(days).toHaveLength(7);
    expect(days[0].daySeq).toBe(1);
    expect(days[0].date).toBe('2026-10-01');
    expect(days[6].daySeq).toBe(7);
    expect(days[6].date).toBe('2026-10-07');
  });

  it('deleteTrip 级联删除子表', async () => {
    const trip = await travelDb.createTrip({
      title: '临时',
      destination: '北京',
      startDate: '2026-09-01',
      endDate: '2026-09-03',
      companionCount: 1,
      currency: 'CNY',
    });

    const days = await travelDb.listDays(trip.id);
    const dayId = days[0].id;

    await travelDb.addItem({
      dayId,
      itemType: 'poi',
      transportMode: 'walk',
    });

    // 添加消费
    await travelDb.addExpense({
      tripId: trip.id,
      category: 'food',
      amount: 200,
      currency: 'CNY',
      date: '2026-09-01',
    });

    await travelDb.deleteTrip(trip.id);

    const remaining = await travelDb.getTrip(trip.id);
    expect(remaining).toBeNull();

    const remainingDays = await travelDb.listDays(trip.id);
    expect(remainingDays).toHaveLength(0);

    const remainingItems = await travelDb.listItems(dayId);
    expect(remainingItems).toHaveLength(0);
  });

  it('addItem 自动分配 orderSeq', async () => {
    const trip = await travelDb.createTrip({
      title: '排序测试',
      destination: '成都',
      startDate: '2026-10-01',
      endDate: '2026-10-01',
      companionCount: 1,
      currency: 'CNY',
    });
    const days = await travelDb.listDays(trip.id);
    const dayId = days[0].id;

    const a = await travelDb.addItem({ dayId, itemType: 'poi', transportMode: 'walk' });
    const b = await travelDb.addItem({ dayId, itemType: 'poi', transportMode: 'walk' });
    const c = await travelDb.addItem({ dayId, itemType: 'buffer', transportMode: 'walk' });

    expect(a.orderSeq).toBe(0);
    expect(b.orderSeq).toBe(1);
    expect(c.orderSeq).toBe(2);

    await travelDb.deleteTrip(trip.id);
  });

  it('expenses 读写与求和', async () => {
    const trip = await travelDb.createTrip({
      title: '记账测试',
      destination: '杭州',
      startDate: '2026-10-01',
      endDate: '2026-10-02',
      companionCount: 2,
      currency: 'CNY',
      totalBudget: 5000,
    });

    await travelDb.addExpense({ tripId: trip.id, category: 'food', amount: 200, currency: 'CNY', date: '2026-10-01' });
    await travelDb.addExpense({ tripId: trip.id, category: 'ticket', amount: 150, currency: 'CNY', date: '2026-10-01' });

    const sum = await travelDb.sumExpenses(trip.id);
    expect(sum).toBe(350);

    const list = await travelDb.listExpenses(trip.id);
    expect(list).toHaveLength(2);

    await travelDb.deleteTrip(trip.id);
  });
});