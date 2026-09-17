import { describe, it, expect } from 'vitest';
import { buildDayPoints, AIRPORT_ARR_ID, AIRPORT_DEP_ID, type AirportPair } from '../shareSegments';
import type { TripSnapshot } from '../../services/sync';
import type { ItineraryDay, ItineraryItem, Poi } from '../../types';

const day = (daySeq: number, id: string, date: string): ItineraryDay => ({ id, tripId: 't1', daySeq, date });
const poi = (id: string, name: string, lng: number, lat: number): Poi => ({ id, name, lng, lat, category: 'poi' });
const item = (id: string, dayId: string, orderSeq: number, poiId: string, opts: Partial<ItineraryItem> = {}): ItineraryItem => ({
  id, dayId, orderSeq, poiId, itemType: 'poi', transportMode: 'walk', ...opts,
});

const baseSnap = (days: ItineraryDay[], items: ItineraryItem[], pois: Poi[]): TripSnapshot => ({
  trip: { id: 't1', title: 'T', destination: 'D', startDate: '2026-09-28', endDate: '2026-09-29', status: 'planning', companionCount: 2, currency: 'CNY' } as any,
  days, items, pois, hotels: [], transports: [], expenses: [], aiCards: [], savedAt: '2026-09-17T00:00:00.000Z',
});

const noAp: AirportPair = {};

describe('buildDayPoints — 路段点集口径', () => {
  const days = [day(1, 'd1', '2026-09-28'), day(2, 'd2', '2026-09-29')];

  it('把酒店纳入路段(与详情页一致):景点 + 酒店都参与', () => {
    const pois = [
      poi('p1', '嘉峪关', 98.22, 39.80),
      poi('p2', '锁阳城遗址', 96.19, 40.25),
      poi('ph', '敦煌酒店', 94.57, 40.10),
    ];
    const items = [
      item('i1', 'd1', 0, 'p1'),
      item('i2', 'd1', 1, 'p2'),
      item('ih', 'd1', 2, 'ph', { itemType: 'hotel', note: '敦煌酒店' }),
    ];
    const pts = buildDayPoints(baseSnap(days, items, pois), noAp);
    expect(pts[0].points.map((p) => p.name)).toEqual(['嘉峪关', '锁阳城遗址', '敦煌酒店']);
  });

  it('沿用酒店的到达方式(酒店 transportMode=walk 时保留,由距离阈值修正)', () => {
    const pois = [poi('p1', 'A', 98.22, 39.80), poi('ph', '酒店', 94.57, 40.10)];
    const items = [
      item('i1', 'd1', 0, 'p1', { transportMode: 'drive' }),
      item('ih', 'd1', 1, 'ph', { itemType: 'hotel', transportMode: 'walk' }),
    ];
    const pts = buildDayPoints(baseSnap(days, items, pois), noAp);
    expect(pts[0].points[1].transportMode).toBe('walk');
  });

  it('跳过无坐标的酒店,不影响其余点序', () => {
    const pois = [poi('p1', 'A', 98.22, 39.80), poi('ph', '无坐标酒店', 0, 0)];
    const items = [
      item('i1', 'd1', 0, 'p1'),
      item('ih', 'd1', 1, 'ph', { itemType: 'hotel' }),
    ];
    const pts = buildDayPoints(baseSnap(days, items, pois), noAp);
    expect(pts[0].points.map((p) => p.name)).toEqual(['A']);
  });

  it('缓冲/其他类型节点不参与路段(只取 poi 与 hotel)', () => {
    const pois = [poi('p1', 'A', 98.22, 39.80), poi('pb', '缓冲', 98.0, 39.7)];
    const items = [
      item('i1', 'd1', 0, 'p1'),
      item('ib', 'd1', 1, 'pb', { itemType: 'buffer' }),
    ];
    const pts = buildDayPoints(baseSnap(days, items, pois), noAp);
    expect(pts[0].points.map((p) => p.name)).toEqual(['A']);
  });

  it('首日机场作起点、末日机场作终点(仅机场有坐标时)', () => {
    const pois = [poi('p1', 'A', 98.22, 39.80), poi('p2', 'B', 96.19, 40.25)];
    const items = [item('i1', 'd1', 0, 'p1'), item('i2', 'd2', 0, 'p2')];
    const ap: AirportPair = {
      arr: { lng: 103.6, lat: 36.48, name: '兰州中川机场' },
      dep: { lng: 102.0, lat: 36.5, name: '西宁曹家堡机场' },
    };
    const pts = buildDayPoints(baseSnap(days, items, pois), ap);
    expect(pts[0].points[0].id).toBe(AIRPORT_ARR_ID);
    expect(pts[1].points[pts[1].points.length - 1].id).toBe(AIRPORT_DEP_ID);
  });
});
