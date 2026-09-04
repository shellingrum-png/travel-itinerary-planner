import { describe, expect, it } from 'vitest';
import { cascadeTimes, toMinutes, toTimeStr, addMinutes } from '../time';
import { solveTsp, savings } from '../tsp';

describe('time utils', () => {
  it('toMinutes / toTimeStr 换算', () => {
    expect(toMinutes('09:30')).toBe(570);
    expect(toTimeStr(570)).toBe('09:30');
  });

  it('跨午夜 24h+ 记号', () => {
    expect(addMinutes('23:50', 20)).toBe('24:10');
    expect(toMinutes('25:30')).toBe(1530);
  });

  it('时间级联:下一景点 = 上一离开 + 通勤', () => {
    const result = cascadeTimes('09:00', [
      { visitMinutes: 30, nextDurationMin: 35 }, // 景点A 09:00-09:30 → 步行35
      { visitMinutes: 120, nextDurationMin: 15 }, // 景点B 10:05-12:05 → 打车15
      { visitMinutes: 60, nextDurationMin: 0 }, // 午餐 12:20-13:20
    ]);
    expect(result.map((r) => r.arrive)).toEqual(['09:00', '10:05', '12:20']);
    expect(result.map((r) => r.leave)).toEqual(['09:30', '12:05', '13:20']);
  });
});

describe('TSP solver', () => {
  // 链式矩阵:酒店(0)-A(1)-B(2)-C(3) 各 1 分钟串联,偏离走链(10)即差
  // 最短闭环只可能是 0→1→2→3→0 或反向,均为 13
  const dur = (d: number[][]) => (i: number, j: number) => d[i][j];
  const chain = [
    [0, 1, 10, 10],
    [1, 0, 1, 10],
    [10, 1, 0, 1],
    [10, 10, 1, 0],
  ];

  it('n=3 精确解: 环线总长 13(顺/反向均为最优)', () => {
    const res = solveTsp({ count: 4, duration: dur(chain) });
    expect(res.exact).toBe(true);
    expect(res.totalDuration).toBe(13);
    // 链式矩阵最优是 0→1→2→3→0 或反向 0→3→2→1→0;订单类型只验证覆盖与长度
    expect([...res.order].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it('savings 计算当前序 vs 最优序的差值', () => {
    // 当前序 [1,0,2] → 物理 [2,1,3]: 0→2(10)+2→1(1)+1→3(10)+3→0(10)=31;最优 13 → 省 18
    expect(savings([1, 0, 2], [0, 1, 2], dur(chain))).toBe(18);
  });

  it('n>8 退化为 2-opt,仍然可用', () => {
    // 13 点(含酒店),构造对称矩阵,验证不抛错且 order 覆盖全部景点
    const d: number[][] = [];
    for (let i = 0; i < 13; i++) {
      d[i] = [];
      for (let j = 0; j < 13; j++) d[i][j] = ((i + j) % 7) + 1;
    }
    const res = solveTsp({ count: 13, duration: dur(d) });
    expect(res.exact).toBe(false);
    expect([...res.order].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, i) => i),
    );
  });
});