import { describe, it, expect } from 'vitest';
import { modeIcon, fmtDT, dayTransports, isBigTransportMode } from '../transportFormat';
import type { Transport } from '../../types';

const t = (id: string, departAt: string, arriveAt: string, mode: Transport['mode'] = 'flight'): Transport => ({
  id, tripId: 'trip', segType: 'round_trip', mode,
  fromPlace: '西宁', toPlace: '北京', departAt, arriveAt,
});

describe('isBigTransportMode', () => {
  it('火车/飞机为大交通', () => {
    expect(isBigTransportMode('train')).toBe(true);
    expect(isBigTransportMode('flight')).toBe(true);
  });
  it('步行/驾车/公交为城内通勤', () => {
    expect(isBigTransportMode('walk')).toBe(false);
    expect(isBigTransportMode('drive')).toBe(false);
    expect(isBigTransportMode('transit')).toBe(false);
  });
});

describe('modeIcon', () => {
  it('映射各模式图标', () => {
    expect(modeIcon('flight')).toBe('✈️');
    expect(modeIcon('train')).toBe('🚄');
    expect(modeIcon('drive')).toBe('🚗');
    expect(modeIcon('ferry')).toBe('⛴');
  });
  it('未知模式回退 🚗', () => {
    expect(modeIcon('walk' as any)).toBe('🚗');
  });
});

describe('fmtDT', () => {
  it('MM-DD HH:mm 格式化', () => {
    expect(fmtDT('2026-09-30T16:00')).toBe('09-30 16:00');
  });
  it('非法输入原样返回/空串', () => {
    expect(fmtDT('')).toBe('');
    expect(fmtDT('xxx')).toBe('xxx');
  });
});

describe('dayTransports', () => {
  const ts = [
    t('a', '2026-09-30T16:00', '2026-09-30T19:00'),
    t('b', '2026-09-30T23:50', '2026-10-01T03:00'), // 夜间跨天,归出发日 09-30
    t('c', '2026-10-01T09:00', '2026-10-01T12:00'),
  ];

  it('按 departAt 日期归天;夜间跨天归出发日', () => {
    expect(dayTransports(ts, '2026-09-30').map((x) => x.id)).toEqual(['a', 'b']);
  });
  it('无匹配日期返回空', () => {
    expect(dayTransports(ts, '2026-09-29')).toEqual([]);
  });
});
