import { describe, it, expect } from 'vitest';
import { remapExpenses, remapTransports, type CopyIdMaps } from '../tripCopy';
import type { Expense, Transport } from '../../types';

const emptyMaps = (): CopyIdMaps => ({
  dayIdMap: new Map(), dayIdByDate: new Map(),
  itemIdMap: new Map(), hotelIdMap: new Map(), transportIdMap: new Map(),
});

const exp = (over: Partial<Expense>): Expense => ({
  id: 'e1', tripId: 'old-trip', category: 'ticket', amount: 30,
  currency: 'CNY', dirty: 0, ...over,
});

describe('remapExpenses — 复制记账到新行程', () => {
  it('基本字段保留,tripId 换成新旅程', () => {
    const [out] = remapExpenses([exp({ note: '门票 · 武威文庙' })], 'new-trip', emptyMaps());
    expect(out.tripId).toBe('new-trip');
    expect(out.amount).toBe(30);
    expect(out.note).toBe('门票 · 武威文庙');
    expect(out.category).toBe('ticket');
  });

  it('dayId 按映射重定向', () => {
    const maps = emptyMaps();
    maps.dayIdMap.set('old-day', 'new-day');
    const [out] = remapExpenses([exp({ dayId: 'old-day' })], 'new-trip', maps);
    expect(out.dayId).toBe('new-day');
  });

  it('原天不存在时,按日期回落到新天', () => {
    const maps = emptyMaps();
    maps.dayIdByDate.set('2026-09-26', 'new-day-2');
    const [out] = remapExpenses([exp({ dayId: '已删除的天', date: '2026-09-26' })], 'new-trip', maps);
    expect(out.dayId).toBe('new-day-2');
  });

  it('景点引用(refType=itinerary_item)重定向到新 item id', () => {
    const maps = emptyMaps();
    maps.itemIdMap.set('old-item', 'new-item');
    const [out] = remapExpenses(
      [exp({ refType: 'itinerary_item', refId: 'old-item' })], 'new-trip', maps);
    expect(out.refType).toBe('itinerary_item');
    expect(out.refId).toBe('new-item');
  });

  it('酒店引用重定向到新 hotel id', () => {
    const maps = emptyMaps();
    maps.hotelIdMap.set('old-hotel', 'new-hotel');
    const [out] = remapExpenses([exp({ refType: 'hotel', refId: 'old-hotel' })], 'new-trip', maps);
    expect(out.refType).toBe('hotel');
    expect(out.refId).toBe('new-hotel');
  });

  it('大交通引用重定向到新 transport id', () => {
    const maps = emptyMaps();
    maps.transportIdMap.set('old-t', 'new-t');
    const [out] = remapExpenses([exp({ refType: 'transport', refId: 'old-t' })], 'new-trip', maps);
    expect(out.refType).toBe('transport');
    expect(out.refId).toBe('new-t');
  });

  it('目标实体未复制时【清空引用】,不留悬空 id', () => {
    const [out] = remapExpenses(
      [exp({ refType: 'itinerary_item', refId: 'no-such' })], 'new-trip', emptyMaps());
    expect(out.refId).toBeUndefined();
    expect(out.refType).toBeUndefined();
    // 金额仍保留 —— 记账本身不该因引用失效而丢失
    expect(out.amount).toBe(30);
  });

  it('无引用的纯记账原样保留', () => {
    const [out] = remapExpenses([exp({ category: 'food', amount: 88 })], 'new-trip', emptyMaps());
    expect(out.category).toBe('food');
    expect(out.amount).toBe(88);
    expect(out.refId).toBeUndefined();
  });

  it('多条记账全部复制,数量不丢', () => {
    const list = [exp({ id: 'a' }), exp({ id: 'b' }), exp({ id: 'c' })];
    expect(remapExpenses(list, 'new-trip', emptyMaps()).length).toBe(3);
  });

  it('总额保持不变', () => {
    const list = [exp({ id: 'a', amount: 30 }), exp({ id: 'b', amount: 467 }), exp({ id: 'c', amount: 1170 })];
    const out = remapExpenses(list, 'new-trip', emptyMaps());
    expect(out.reduce((s, e) => s + e.amount, 0)).toBe(1667);
  });

  it('paidBy 存在时保留,缺失时不产生多余字段', () => {
    const [a] = remapExpenses([exp({ paidBy: '我' })], 'new-trip', emptyMaps());
    expect(a.paidBy).toBe('我');
    const [b] = remapExpenses([exp({})], 'new-trip', emptyMaps());
    expect('paidBy' in b).toBe(false);
  });
});

describe('remapTransports — 复制大交通', () => {
  const tr: Transport = {
    id: 't1', tripId: 'old-trip', segType: 'inter_city', mode: 'flight',
    fromPlace: '西宁曹家堡国际机场', toPlace: '北京大兴国际机场',
    departAt: '2026-10-04T13:20', arriveAt: '2026-10-04T16:00', flightNo: 'CA123',
  };

  it('换 tripId,其余字段保留,id 交给 db 层生成', () => {
    const [out] = remapTransports([tr], 'new-trip');
    expect(out.tripId).toBe('new-trip');
    expect(out.mode).toBe('flight');
    expect(out.fromPlace).toBe('西宁曹家堡国际机场');
    expect(out.flightNo).toBe('CA123');
    expect('id' in out).toBe(false);
  });

  it('多条全部复制', () => {
    expect(remapTransports([tr, { ...tr, id: 't2' }], 'new-trip').length).toBe(2);
  });
});
