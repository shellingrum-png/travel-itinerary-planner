import { describe, it, expect } from 'vitest';
import { buildItemPatch, ticketAction } from '../itemEdit';
import type { ItineraryItem, Expense, Trip } from '../../types';

const item: ItineraryItem = { id: 'it1', dayId: 'd1', itemType: 'poi', orderSeq: 0, transportMode: 'walk', note: '中山桥' };
const trip: Trip = { id: 't1', title: '青甘', destination: '青海', cityNodes: [], startDate: '2026-09-26', endDate: '2026-10-05', status: 'planning', companionCount: 2, currency: 'CNY' };
const poi = { id: 'p2', name: '塔尔寺', address: '湟中县', lng: 101.5, lat: 36.4, type: '风景名胜' };

describe('buildItemPatch', () => {
  it('更换景点 → { poiId, note: 新名 } + upsertPoi', () => {
    const r = buildItemPatch(item, { replacePoi: poi });
    expect(r.itemPatch).toEqual({ poiId: 'p2', note: '塔尔寺' });
    expect(r.upsertPoi).toMatchObject({ id: 'p2', lng: 101.5, lat: 36.4 });
  });
  it('无更换 → 只含传入字段,过滤 undefined', () => {
    const r = buildItemPatch(item, { note: '改名', visitMinutes: 120 });
    expect(r.itemPatch).toEqual({ note: '改名', visitMinutes: 120 });
    expect(r.upsertPoi).toBeUndefined();
  });
  it('undefined 字段被忽略', () => {
    const r = buildItemPatch(item, { visitMinutes: undefined });
    expect(r.itemPatch).toEqual({});
  });
  it('更换景点时 note 覆盖手输(名=新景点)', () => {
    const r = buildItemPatch(item, { note: '手输名', replacePoi: poi });
    expect(r.itemPatch.note).toBe('塔尔寺');
  });
});

describe('ticketAction', () => {
  it('存在关联 ticket 记账 → update', () => {
    const exps: Expense[] = [{ id: 'e1', tripId: 't1', category: 'ticket', amount: 60, currency: 'CNY', dirty: 0, refType: 'itinerary_item', refId: 'it1', dayId: 'd1' }] as Expense[];
    const r = ticketAction(exps, item, 80, trip);
    expect(r.kind).toBe('update');
    if (r.kind === 'update') expect(r.id).toBe('e1');
  });
  it('无关联记账 → add,refId/dayId 正确', () => {
    const r = ticketAction([], item, 80, trip, '2026-09-30');
    expect(r.kind).toBe('add');
    if (r.kind === 'add') {
      expect(r.exp).toMatchObject({ category: 'ticket', refType: 'itinerary_item', refId: 'it1', dayId: 'd1', amount: 80, date: '2026-09-30' });
    }
  });
  it('金额非法(<=0)→ none', () => {
    expect(ticketAction([], item, 0, trip).kind).toBe('none');
    expect(ticketAction([], item, -5, trip).kind).toBe('none');
  });
});
