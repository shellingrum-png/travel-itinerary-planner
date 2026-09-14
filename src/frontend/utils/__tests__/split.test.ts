import { describe, it, expect } from 'vitest';
import {
  effectiveMembers, effectiveCount, isAnonMember, partSubtotal, partsTotal,
  expenseShares, participatesIn, computeMemberSpend, splitSummary,
} from '../split';
import type { Expense, Trip, TripMember } from '../../types';

const M = (id: string, name: string): TripMember => ({ id, name });
const MEMBERS = [M('a', '我'), M('b', '老张'), M('c', '妈妈'), M('d', '小舅')];

const exp = (over: Partial<Expense>): Expense => ({
  id: 'e1', tripId: 't1', category: 'hotel', amount: 800,
  currency: 'CNY', dirty: 0, ...over,
});

describe('effectiveMembers — 成员兜底', () => {
  it('有 members 时直接用名单', () => {
    expect(effectiveMembers({ members: MEMBERS, companionCount: 2 })).toEqual(MEMBERS);
  });

  it('无 members 时按 companionCount 生成匿名成员(旧数据兼容)', () => {
    const ms = effectiveMembers({ companionCount: 4 });
    expect(ms).toHaveLength(4);
    expect(ms.map((m) => m.name)).toEqual(['人1', '人2', '人3', '人4']);
    expect(ms.every((m) => isAnonMember(m.id))).toBe(true);
  });

  it('companionCount 缺失/非法 → 至少 1 人(避免除零)', () => {
    expect(effectiveCount({ companionCount: 0 })).toBe(1);
    expect(effectiveCount({ companionCount: -3 })).toBe(1);
    expect(effectiveCount(null)).toBe(1);
  });

  it('members 为空数组时退回 companionCount', () => {
    expect(effectiveCount({ members: [], companionCount: 3 })).toBe(3);
  });
});

describe('expenseShares — 均摊(even)', () => {
  it('旧数据(无任何分摊字段)全员均摊,与改造前口径一致', () => {
    const shares = expenseShares(exp({ amount: 800 }), MEMBERS);
    expect(shares.get('a')).toBe(200);
    expect(shares.get('b')).toBe(200);
    expect(shares.get('c')).toBe(200);
    expect(shares.get('d')).toBe(200);
  });

  it('participantIds 指定部分人 → 只在这些人之间均摊', () => {
    const shares = expenseShares(exp({ amount: 300, participantIds: ['a', 'b'] }), MEMBERS);
    expect(shares.get('a')).toBe(150);
    expect(shares.get('b')).toBe(150);
    expect(shares.has('c')).toBe(false);
    expect(shares.has('d')).toBe(false);
  });

  it('participantIds 里的成员都已被删 → 退回全员均摊(不崩)', () => {
    const shares = expenseShares(exp({ amount: 400, participantIds: ['已删除'] }), MEMBERS);
    expect(shares.size).toBe(4);
    expect(shares.get('a')).toBe(100);
  });

  it('除不尽时分摊之和仍精确等于总额(误差吸收到最大档)', () => {
    const shares = expenseShares(exp({ amount: 100 }), [M('a', 'A'), M('b', 'B'), M('c', 'C')]);
    const sum = [...shares.values()].reduce((s, v) => s + v, 0);
    expect(Math.round(sum * 100) / 100).toBe(100);
  });

  it('金额 <=0 或人数为 0 → 返回空', () => {
    expect(expenseShares(exp({ amount: 0 }), MEMBERS).size).toBe(0);
    expect(expenseShares(exp({ amount: -5 }), MEMBERS).size).toBe(0);
    expect(expenseShares(exp({ amount: 100 }), []).size).toBe(0);
  });
});

describe('expenseShares — 票种明细(parts)', () => {
  it('普通票 3×100 + 老年票 1×50 未绑定人 → 每行全员均摊', () => {
    const shares = expenseShares(exp({
      amount: 350,
      splitMode: 'parts',
      parts: [
        { label: '普通票', units: 3, unitPrice: 100 },
        { label: '老年票', units: 1, unitPrice: 50 },
      ],
    }), MEMBERS);
    // 每行各由 4 人均摊:(300+50)/4 = 87.5
    expect(shares.get('a')).toBe(87.5);
    expect(shares.get('c')).toBe(87.5);
    const sum = [...shares.values()].reduce((s, v) => s + v, 0);
    expect(Math.round(sum * 100) / 100).toBe(350);
  });

  it('老年票绑定到妈妈 → 该行全额记妈妈名下,其余行其他人均摊', () => {
    const shares = expenseShares(exp({
      amount: 350,
      splitMode: 'parts',
      parts: [
        { label: '普通票', units: 3, unitPrice: 100 },
        { label: '老年票', units: 1, unitPrice: 50, memberId: 'c' },
      ],
    }), MEMBERS);
    // 妈妈 = 老年票 50 + 普通票行均摊 300/4 = 75 → 125
    expect(shares.get('c')).toBe(125);
    // 其他人只有普通票行均摊 75
    expect(shares.get('a')).toBe(75);
    expect(shares.get('b')).toBe(75);
    expect(shares.get('d')).toBe(75);
    const sum = [...shares.values()].reduce((s, v) => s + v, 0);
    expect(Math.round(sum * 100) / 100).toBe(350);
  });

  it('全部明细都绑定到人 → 每人只承担自己的行', () => {
    const shares = expenseShares(exp({
      amount: 400,
      splitMode: 'parts',
      parts: [
        { label: '成人票', units: 2, unitPrice: 150, memberId: 'a' },
        { label: '儿童票', units: 2, unitPrice: 50, memberId: 'b' },
      ],
    }), MEMBERS);
    expect(shares.get('a')).toBe(300);
    expect(shares.get('b')).toBe(100);
    expect(shares.has('c')).toBe(false);
  });

  it('绑定到已删除成员 → 该行退回全员均摊(不崩)', () => {
    const shares = expenseShares(exp({
      amount: 100,
      splitMode: 'parts',
      parts: [{ label: '票', units: 1, unitPrice: 100, memberId: '已删除' }],
    }), MEMBERS);
    expect(shares.get('a')).toBe(25);
    expect(shares.size).toBe(4);
  });

  it('明细合计与金额不一致时按比例缩放,总和仍等于金额', () => {
    const shares = expenseShares(exp({
      amount: 200,
      splitMode: 'parts',
      parts: [
        { label: 'A', units: 1, unitPrice: 100, memberId: 'a' },
        { label: 'B', units: 1, unitPrice: 100, memberId: 'b' },
      ],
    }), MEMBERS);
    // 明细合计 200 = 金额 200,不缩放
    expect(shares.get('a')).toBe(100);

    const scaled = expenseShares(exp({
      amount: 150,
      splitMode: 'parts',
      parts: [
        { label: 'A', units: 1, unitPrice: 100, memberId: 'a' },
        { label: 'B', units: 1, unitPrice: 100, memberId: 'b' },
      ],
    }), MEMBERS);
    const sum = [...scaled.values()].reduce((s, v) => s + v, 0);
    expect(Math.round(sum * 100) / 100).toBe(150);
  });

  it('parts 但明细合计为 0 → 退回全员均摊', () => {
    const shares = expenseShares(exp({
      amount: 120,
      splitMode: 'parts',
      parts: [{ label: '免费', units: 0, unitPrice: 0 }],
    }), MEMBERS);
    expect(shares.get('a')).toBe(30);
  });
});

describe('partSubtotal / partsTotal', () => {
  it('行小计 = 数量 × 单价', () => {
    expect(partSubtotal({ label: 'x', units: 3, unitPrice: 100 })).toBe(300);
  });
  it('明细合计为各行之和;空/undefined → 0', () => {
    expect(partsTotal([{ label: 'a', units: 2, unitPrice: 50 }, { label: 'b', units: 1, unitPrice: 30 }])).toBe(130);
    expect(partsTotal(undefined)).toBe(0);
  });
});

describe('participatesIn — 按人过滤', () => {
  it('旧数据(无字段)视为全员参与', () => {
    expect(participatesIn(exp({}), 'c', MEMBERS)).toBe(true);
  });
  it('指定参与人后,未选中的人不参与', () => {
    expect(participatesIn(exp({ participantIds: ['a', 'b'] }), 'c', MEMBERS)).toBe(false);
    expect(participatesIn(exp({ participantIds: ['a', 'b'] }), 'a', MEMBERS)).toBe(true);
  });
  it('parts 全部绑定 → 只有被绑定的人参与', () => {
    const e = exp({
      splitMode: 'parts',
      parts: [{ label: '票', units: 1, unitPrice: 50, memberId: 'c' }],
    });
    expect(participatesIn(e, 'c', MEMBERS)).toBe(true);
    expect(participatesIn(e, 'a', MEMBERS)).toBe(false);
  });
  it('parts 存在未绑定行 → 全员参与', () => {
    const e = exp({
      splitMode: 'parts',
      parts: [
        { label: '票', units: 1, unitPrice: 50, memberId: 'c' },
        { label: '其它', units: 1, unitPrice: 20 },
      ],
    });
    expect(participatesIn(e, 'a', MEMBERS)).toBe(true);
  });
});

describe('computeMemberSpend — 汇总', () => {
  const trip: Pick<Trip, 'members' | 'companionCount'> = { members: MEMBERS, companionCount: 4 };

  it('汇总应分摊与参与笔数', () => {
    const expenses = [
      exp({ id: 'e1', amount: 800 }),                                  // 全员均摊 200/人
      exp({ id: 'e2', amount: 300, participantIds: ['a', 'b'] }),      // a/b 各 150
    ];
    const res = computeMemberSpend(trip, expenses);
    const a = res.find((r) => r.member.id === 'a')!;
    const c = res.find((r) => r.member.id === 'c')!;
    expect(a.share).toBe(350);
    expect(a.count).toBe(2);
    expect(c.share).toBe(200);
    expect(c.count).toBe(1);
  });

  it('无 members 的旧数据按 companionCount 兜底', () => {
    const res = computeMemberSpend({ companionCount: 2 }, [exp({ amount: 100 })]);
    expect(res).toHaveLength(2);
    expect(res.every((r) => r.share === 50)).toBe(true);
  });

  it('空账目 → 全 0', () => {
    const res = computeMemberSpend(trip, []);
    expect(res).toHaveLength(4);
    expect(res.every((r) => r.share === 0 && r.count === 0)).toBe(true);
  });
});

describe('splitSummary — 列表摘要', () => {
  it('全员均摊 → 人均文案', () => {
    expect(splitSummary(exp({ amount: 800 }), MEMBERS)).toBe('人均 ¥200');
  });
  it('部分人 → 列出分摊人', () => {
    expect(splitSummary(exp({ amount: 300, participantIds: ['a', 'b'] }), MEMBERS)).toBe('我/老张 分摊 ¥150');
  });
  it('票种明细 → 列出票种与绑定人', () => {
    const s = splitSummary(exp({
      amount: 350,
      splitMode: 'parts',
      parts: [
        { label: '普通票', units: 3, unitPrice: 100 },
        { label: '老年票', units: 1, unitPrice: 50, memberId: 'c' },
      ],
    }), MEMBERS);
    expect(s).toBe('普通票×3 + 老年票×1(妈妈)');
  });
  it('金额 0 → 空串', () => {
    expect(splitSummary(exp({ amount: 0 }), MEMBERS)).toBe('');
  });
});
