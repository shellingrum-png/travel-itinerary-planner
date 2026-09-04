import { describe, it, expect } from 'vitest';
import { deriveDayBoundary, recomputeDayBoundary } from '../boundary';
import type { ItineraryDay, Hotel, Transport, ItineraryItem } from '../../types';

function day(overrides: Partial<ItineraryDay> = {}): ItineraryDay {
  return {
    id: 'd1',
    tripId: 't1',
    daySeq: 2,
    date: '2026-10-02',
    ...overrides,
  };
}

function hotel(overrides: Partial<Hotel> = {}): Hotel {
  return {
    id: 'h1',
    tripId: 't1',
    name: '测试酒店',
    checkIn: '2026-10-02',
    checkOut: '2026-10-04',
    ...overrides,
  };
}

function transport(overrides: Partial<Transport> = {}): Transport {
  return {
    id: 'tr1',
    tripId: 't1',
    segType: 'inter_city',
    mode: 'flight',
    fromPlace: '长沙',
    toPlace: '西宁',
    departAt: '2026-10-02T08:00:00',
    arriveAt: '2026-10-01T23:30:00',
    ...overrides,
  };
}

function item(overrides: Partial<ItineraryItem> = {}): ItineraryItem {
  return {
    id: 'i1',
    dayId: 'd1',
    itemType: 'poi',
    orderSeq: 0,
    transportMode: 'walk',
    arriveTime: '09:00',
    leaveTime: '10:00',
    ...overrides,
  };
}

describe('deriveDayBoundary', () => {
  it('默认值: 09:00 ~ 20:00', () => {
    const r = deriveDayBoundary({ day: day() });
    expect(r.startTime).toBe('09:00');
    expect(r.endTime).toBe('20:00');
  });

  it('手动覆盖优先', () => {
    const r = deriveDayBoundary({
      day: day(),
      manualStart: '07:00',
      manualEnd: '22:00',
      hotel: hotel({ checkIn: '2026-10-02', checkInTime: '14:00' }),
    });
    expect(r.startTime).toBe('07:00');
    expect(r.endTime).toBe('22:00');
  });

  it('酒店 check_in / check_out 优先于默认', () => {
    const r = deriveDayBoundary({
      day: day(),
      hotel: hotel({ checkIn: '2026-10-02', checkInTime: '14:00', checkOut: '2026-10-02', checkOutTime: '12:00' }),
    });
    expect(r.startTime).toBe('14:00');
    expect(r.endTime).toBe('12:00');
  });

  it('酒店 check_in 不在当日 → 跳到下一优先级', () => {
    const r = deriveDayBoundary({
      day: day(),
      hotel: hotel({ checkIn: '2026-10-03', checkInTime: '14:00' }),
    });
    expect(r.startTime).toBe('09:00'); // 退回到默认
  });

  it('前一日大交通到达 → start_time 取默认 09:00', () => {
    // 优先级 3:前一日大交通 arrive_at 存在时,start_time = 09:00
    const r = deriveDayBoundary({
      day: day(),
      prevTransportArrive: transport({ arriveAt: '2026-10-01T22:00:00' }),
    });
    expect(r.startTime).toBe('09:00');
  });

  it('当日大交通出发 → end_time = depart_at 时间', () => {
    const r = deriveDayBoundary({
      day: day(),
      todayTransportDepart: transport({ departAt: '2026-10-02T16:30:00' }),
    });
    expect(r.endTime).toBe('16:30');
  });

  it('酒店 check_out 不在当日 → 跳到下一优先级', () => {
    const r = deriveDayBoundary({
      day: day(),
      hotel: hotel({ checkOut: '2026-10-05' }),
    });
    expect(r.endTime).toBe('20:00'); // 退回到默认
  });

  it('end_time: 酒店 check_out 优先于交通出发', () => {
    const r = deriveDayBoundary({
      day: day(),
      hotel: hotel({ checkOut: '2026-10-02', checkOutTime: '11:00' }),
      todayTransportDepart: transport({ departAt: '2026-10-02T16:30:00' }),
    });
    expect(r.endTime).toBe('11:00');
  });
});

describe('recomputeDayBoundary', () => {
  it('无已排点 → 直接返回新边界', () => {
    const r = recomputeDayBoundary({ day: day() }, []);
    expect(r.conflict).toBe(false);
    expect(r.boundary.startTime).toBe('09:00');
  });

  it('新边界不晚于第一条排点 → 正常应用', () => {
    const r = recomputeDayBoundary(
      { day: day(), manualStart: '07:00' },
      [item({ arriveTime: '09:00' })],
    );
    expect(r.conflict).toBe(false);
    expect(r.boundary.startTime).toBe('07:00');
  });

  it('新边界晚于第一条排点 → 不覆盖,标冲突', () => {
    const r = recomputeDayBoundary(
      { day: day(), hotel: hotel({ checkIn: '2026-10-02', checkInTime: '14:00' }) },
      [item({ arriveTime: '09:00' })],
    );
    expect(r.conflict).toBe(true);
    expect(r.boundary.startTime).toBe('09:00'); // 保留原排点
  });

  it('第一条排点无 arriveTime → 无冲突', () => {
    const r = recomputeDayBoundary(
      { day: day(), manualStart: '14:00' },
      [item({ arriveTime: undefined })],
    );
    expect(r.conflict).toBe(false);
  });
});