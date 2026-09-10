import { describe, it, expect, vi } from 'vitest';
import {
  resolveMode, computeSegment, computeAllSegments, fmtSegment, fmtDistance, fmtDuration,
  isExplicitTransportMode,
  WALK_THRESHOLD_KM, WALK_MAX_KM, DRIVE_MAX_KM, type SegPoint,
} from '../segments';

const pt = (id: string, lng: number, lat: number, mode: SegPoint['transportMode'] = 'drive', explicit = false): SegPoint =>
  ({ id, name: id, lng, lat, transportMode: mode, transportModeSet: explicit });

describe('resolveMode — 交通方式判定', () => {
  it('很近距离的 drive 降级为步行（同城短途开车不合理）', () => {
    expect(resolveMode('drive', 1.2)).toBe('walk');   // < 3km
  });
  it('超过阈值保持驾车', () => {
    expect(resolveMode('drive', 12)).toBe('drive');
  });
  it('近距离的 walk 被保留（用户选的步行）', () => {
    expect(resolveMode('walk', 2)).toBe('walk');
  });

  // ⚠️ 真实数据全是 walk（字段默认值 = 未指定），必须按距离升级，
  //    否则会出现「步行 440km · 88 小时」这种荒谬结果
  it('walk 但距离过远 → 视为未指定，升级为驾车', () => {
    expect(resolveMode('walk', 100)).toBe('drive');   // 15~300km 区间
  });
  it('walk 且极远 → 升级为火车', () => {
    expect(resolveMode('walk', 440)).toBe('train');   // 超过 300km
    expect(resolveMode('walk', 800)).toBe('train');
  });
  it('walk 恰好在步行上限内仍为步行', () => {
    expect(resolveMode('walk', WALK_MAX_KM)).toBe('walk');
    expect(resolveMode('walk', WALK_MAX_KM + 1)).toBe('drive');
  });
  it('自驾超过上限 → 火车', () => {
    expect(resolveMode('drive', DRIVE_MAX_KM + 1)).toBe('train');
  });
  it('跨城大交通(flight)一律尊重，即便距离近', () => {
    expect(resolveMode('flight', 1)).toBe('flight');
  });

  // 用户显式设置过 → 完全尊重，不做距离改判（本次线上问题的根因）
  it('用户选了 389km 的驾车 → 保持驾车，不改判为火车', () => {
    expect(resolveMode('drive', 389.9, true)).toBe('drive');
  });
  it('用户显式设置的 walk 即便很远也保持', () => {
    expect(resolveMode('walk', 100, true)).toBe('walk');
  });
  it('用户显式选的近距离开车也保持（不再降级为步行）', () => {
    expect(resolveMode('drive', 1, true)).toBe('drive');
  });
  it('未显式设置时仍走距离启发式', () => {
    expect(resolveMode('drive', 389.9, false)).toBe('train');
    expect(resolveMode('walk', 100, false)).toBe('drive');
  });
});

describe('computeSegment — 单段计算', () => {
  it('近距离不调驾车接口（省额度）', async () => {
    const drive = vi.fn();
    const seg = await computeSegment(pt('a', 100.0, 30.0), pt('b', 100.001, 30.0), drive);
    expect(seg.mode).toBe('walk');
    expect(seg.real).toBe(false);
    expect(drive).not.toHaveBeenCalled();
  });

  it('远距离走真实驾车数据', async () => {
    const drive = vi.fn(async () => ({ durationMin: 95, distanceM: 105000 }));
    // 相距约 100km
    const seg = await computeSegment(pt('a', 100.0, 30.0), pt('b', 101.0, 30.5), drive);
    expect(drive).toHaveBeenCalledOnce();
    expect(seg.mode).toBe('drive');
    expect(seg.real).toBe(true);
    expect(seg.distanceKm).toBeCloseTo(105, 1);
    expect(seg.durationMin).toBe(95);
  });

  it('驾车接口失败时回退直线估算，不抛错', async () => {
    const drive = vi.fn(async () => { throw new Error('NO_ROUTE'); });
    const seg = await computeSegment(pt('a', 100.0, 30.0), pt('b', 101.0, 30.5), drive);
    expect(seg.real).toBe(false);
    expect(seg.distanceKm).toBeGreaterThan(50);
    expect(seg.durationMin).toBeGreaterThan(0);
  });

  it('接口返回 0 距离（无路线）时也回退估算', async () => {
    const drive = vi.fn(async () => ({ durationMin: 0, distanceM: 0 }));
    const seg = await computeSegment(pt('a', 100.0, 30.0), pt('b', 101.0, 30.5), drive);
    expect(seg.real).toBe(false);
    expect(seg.durationMin).toBeGreaterThan(0);
  });
});

describe('computeAllSegments — 天内 + 跨天', () => {
  it('天内相邻段数 = 点数-1，且正确生成跨天衔接', async () => {
    const drive = vi.fn(async () => ({ durationMin: 60, distanceM: 80000 }));
    const days = [
      { dayId: 'd1', points: [pt('a1', 100.0, 30.0), pt('a2', 101.0, 30.5)] },
      { dayId: 'd2', points: [pt('b1', 102.0, 31.0), pt('b2', 102.01, 31.0)] },  // b1→b2 很近
    ];
    const { intraDay, crossDay } = await computeAllSegments(days, drive);

    expect(intraDay.get('d1')!.length).toBe(1);
    expect(intraDay.get('d2')!.length).toBe(1);
    expect(intraDay.get('d1')![0].mode).toBe('drive');

    // 跨天:d2 首点 ← d1 末点
    const cross = crossDay.get('d2')!;
    expect(cross).not.toBeNull();
    expect(cross.fromId).toBe('a2');
    expect(cross.toId).toBe('b1');
    expect(crossDay.get('d1')).toBeNull();   // 首天无跨天段
  });

  it('跨天取「上一天最后一个有坐标的点」', async () => {
    const drive = vi.fn(async () => ({ durationMin: 60, distanceM: 80000 }));
    const days = [
      { dayId: 'd1', points: [pt('x1', 100.0, 30.0), pt('x2', 101.0, 30.5)] },
      { dayId: 'd2', points: [pt('y1', 102.0, 31.0)] },
    ];
    const { crossDay } = await computeAllSegments(days, drive);
    expect(crossDay.get('d2')!.fromId).toBe('x2');   // 末点，而非首点
  });

  it('某天无点时不生成跨天段（避免连到不存在的位置）', async () => {
    const drive = vi.fn(async () => ({ durationMin: 60, distanceM: 80000 }));
    const days = [
      { dayId: 'd1', points: [pt('x1', 100.0, 30.0)] },
      { dayId: 'd2', points: [] },
      { dayId: 'd3', points: [pt('z1', 102.0, 31.0)] },
    ];
    const { crossDay } = await computeAllSegments(days, drive);
    expect(crossDay.get('d2')).toBeNull();
    expect(crossDay.get('d3')).toBeNull();   // 前一天(d2)无点 → 不生成
  });
});

describe('isExplicitTransportMode — 旧数据兼容', () => {
  it('有显式标记时以标记为准', () => {
    expect(isExplicitTransportMode('walk', true)).toBe(true);
    expect(isExplicitTransportMode('drive', false)).toBe(false);
  });
  it('无标记时:非 walk 视为用户设置过(旧数据里用户改过的值)', () => {
    expect(isExplicitTransportMode('drive', undefined)).toBe(true);
    expect(isExplicitTransportMode('train', undefined)).toBe(true);
    expect(isExplicitTransportMode('flight', undefined)).toBe(true);
  });
  it('无标记时:walk 视为默认值(未指定)', () => {
    expect(isExplicitTransportMode('walk', undefined)).toBe(false);
  });
});

describe('格式化', () => {
  it('距离:小于 1km 显示米', () => {
    expect(fmtDistance(0.85)).toBe('850m');
    expect(fmtDistance(12.34)).toBe('12.3km');
    expect(fmtDistance(0)).toBe('');
  });
  it('时长:超过 60 分钟显示 h+m', () => {
    expect(fmtDuration(45)).toBe('45min');
    expect(fmtDuration(95)).toBe('1h35m');
    expect(fmtDuration(120)).toBe('2h');
  });
  it('整段文案', () => {
    const real = fmtSegment({ fromId: 'a', toId: 'b', mode: 'drive', real: true, distanceKm: 12.3, durationMin: 18 });
    expect(real).toBe('驾车 12.3km · 18min');   // 真实数据不加「约」
    const est = fmtSegment({ fromId: 'a', toId: 'b', mode: 'walk', real: false, distanceKm: 0.85, durationMin: 11 });
    expect(est).toBe('步行 850m · 约 11min');    // 估算加「约」
  });
});

describe('阈值常量', () => {
  it('步行阈值为 3km', () => {
    expect(WALK_THRESHOLD_KM).toBe(3);
  });
});
