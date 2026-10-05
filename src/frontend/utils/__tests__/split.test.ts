import { describe, it, expect } from 'vitest';
import {
  effectiveMembers, effectiveCount, isAnonMember, partSubtotal, partsTotal,
  expenseShares, participatesIn, computeMemberSpend, computeSettlement, splitSummary, payersOf, payerLabel,
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

describe('computeSettlement — 结算(应分摊 vs 已垫付)', () => {
  const TRIP = { members: MEMBERS, companionCount: 4 };

  it('净垫付 = 已垫付 − 应分摊', () => {
    // 400 均摊给 4 人 → 每人 100;我垫了 400
    const { balances } = computeSettlement(TRIP, [exp({ id: 'e1', amount: 400, paidBy: '我' })]);
    const mine = balances.find((b) => b.member.id === 'a')!;
    expect(mine.share).toBe(100);
    expect(mine.paid).toBe(400);
    expect(mine.net).toBe(300); // 该收 300
  });

  it('每人垫付刚好等于自己份额 → 已平账,无转账', () => {
    const { balances, transfers } = computeSettlement(TRIP, [
      exp({ id: 'e1', amount: 100, paidBy: '我' }), exp({ id: 'e2', amount: 100, paidBy: '老张' }),
      exp({ id: 'e3', amount: 100, paidBy: '妈妈' }), exp({ id: 'e4', amount: 100, paidBy: '小舅' }),
    ]);
    expect(balances.every((b) => b.net === 0)).toBe(true);
    expect(transfers).toHaveLength(0);
  });

  it('一人垫付、三人未垫 → 三人各付自己的份额给垫付人', () => {
    // 总额 400 均摊 → 每人 100;我垫 400 → 我该收 300,其余三人各出 100
    const { transfers } = computeSettlement(TRIP, [exp({ amount: 400, paidBy: '我' })]);
    expect(transfers).toHaveLength(3);
    expect(transfers.every((t) => t.to.name === '我')).toBe(true);
    expect(transfers.map((t) => t.amount).sort()).toEqual([100, 100, 100]);
  });

  it('多人多笔 + parts 明细 → 绑定人的份额抬高,差额按实结清', () => {
    const { balances, transfers } = computeSettlement(TRIP, [
      exp({ id: 'e1', amount: 400, paidBy: '我' }),   // 均摊:每人 100
      exp({ id: 'e2', amount: 150, splitMode: 'parts', parts: [{ label: '票', units: 1, unitPrice: 150, memberId: 'b' }] }), // 老张自用的票,无人垫付
    ]);
    // 我 +300(垫 400 摊 100) / 老张 −250(没垫但摊了 100+150) / 妈妈 −100 / 小舅 −100
    expect(balances.map((b) => b.net).sort((x, y) => x - y)).toEqual([-250, -100, -100, 300]);
    // 老张全额补 250 给我(他的份额全靠自己摊),妈妈/小舅各补 50(他们的 −100 中,50 有对应债权人,其余无)
    expect(transfers).toEqual([
      { from: MEMBERS[1], to: MEMBERS[0], amount: 250 },
      { from: MEMBERS[2], to: MEMBERS[0], amount: 50 },
    ]);
    expect(transfers.every((t) => t.amount > 0)).toBe(true);
  });

  it('剩余差额找不到对应债权人 → 停手,不产生负数/假转账', () => {
    // 我垫 400、妈妈垫 200;另有 100 谁也没垫(没记出账人)。各家份额 175。
    const { balances, transfers } = computeSettlement(TRIP, [
      exp({ id: 'e1', amount: 400, paidBy: '我' }),
      exp({ id: 'e2', amount: 200, paidBy: '妈妈' }),
      exp({ id: 'e3', amount: 100 }), // 谁也没掏这 100
    ]);
    expect(balances.map((b) => b.net).sort((x, y) => x - y)).toEqual([-175, -175, 25, 225]);
    expect(transfers.every((t) => t.amount > 0)).toBe(true);
    // 我净垫 225、妈妈净垫 25,其余两人各欠 175:先把我垫最多的补平,再轮到妈妈
    expect(transfers.filter((t) => t.to.name === '我')).toEqual([
      { from: MEMBERS[1], to: MEMBERS[0], amount: 175 },
      { from: MEMBERS[3], to: MEMBERS[0], amount: 50 },
    ]);
    expect(transfers).toHaveLength(3); // 最后一笔:小舅补 25 给妈妈
    expect(transfers[2]).toEqual({ from: MEMBERS[3], to: MEMBERS[2], amount: 25 });
  });

  it('出账人姓名不在名单里 → 忽略,不污染结算', () => {
    const { balances, transfers } = computeSettlement(TRIP, [exp({ amount: 400, paidBy: '路人甲' })]);
    expect(balances.find((b) => b.member.id === 'a')!.paid).toBe(0);
    expect(transfers).toHaveLength(0); // 无人垫付 → 无债权人,不凑假转账
  });

  it('未填出账人 → 只算应分摊,差额为负(没垫过钱)', () => {
    const { balances } = computeSettlement(TRIP, [exp({ amount: 400 })]);
    expect(balances.find((b) => b.member.id === 'a')!.paid).toBe(0);
    expect(balances.find((b) => b.member.id === 'a')!.net).toBe(-100);
  });

  it('出账人多选:两人一起垫付 → 各记一半,净额按半额轧差', () => {
    // 400 均摊 4 人 → 每人 100;我和老张一起垫了 400 → 各垫 200
    const { balances, transfers } = computeSettlement(TRIP, [
      exp({ id: 'e1', amount: 400, paidByIds: ['a', 'b'] }),
    ]);
    const mine = balances.find((b) => b.member.id === 'a')!;
    const zhang = balances.find((b) => b.member.id === 'b')!;
    expect(mine.paid).toBe(200);
    expect(zhang.paid).toBe(200);
    expect(mine.net).toBe(100); // 该收 100
    expect(zhang.net).toBe(100);
    // 妈妈、小舅各欠 100,都转给「垫付人里我俩中垫得最多的那个」
    expect(transfers.every((t) => t.amount === 100)).toBe(true);
    expect(transfers).toHaveLength(2);
  });

  it('出账人多选 + 三人垫付 → 垫付额按人数三等分', () => {
    const { balances } = computeSettlement(TRIP, [exp({ amount: 600, paidByIds: ['a', 'c', 'd'] })]);
    expect(balances.find((b) => b.member.id === 'a')!.paid).toBe(200); // 600 / 3
    expect(balances.find((b) => b.member.id === 'b')!.paid).toBe(0);
  });

  it('paidByIds 里含已删除成员 → 忽略该 id,其余按均摊', () => {
    const { balances } = computeSettlement(TRIP, [exp({ amount: 400, paidByIds: ['a', 'deleted'] })]);
    expect(balances.find((b) => b.member.id === 'a')!.paid).toBe(400); // 只剩一个有效垫付人 → 全额
  });

  it('paidByIds 为空数组 → 回落 paidBy 姓名文本(旧数据兼容)', () => {
    const { balances } = computeSettlement(TRIP, [exp({ amount: 400, paidByIds: [], paidBy: '妈妈' })]);
    expect(balances.find((b) => b.member.id === 'c')!.paid).toBe(400);
    expect(balances.find((b) => b.member.id === 'a')!.paid).toBe(0);
  });
});

describe('payersOf / payerLabel — 垫付人解析', () => {
  it('优先用 paidByIds,并按名单顺序返回', () => {
    // 选的顺序是 老张/我,返回顺序仍按名单排 → 我/老张
    expect(payersOf({ paidByIds: ['b', 'a'] }, MEMBERS).map((m) => m.name)).toEqual(['我', '老张']);
  });
  it('paidByIds 缺失/为空 → 回落 paidBy 姓名', () => {
    expect(payersOf({ paidBy: '妈妈' }, MEMBERS).map((m) => m.name)).toEqual(['妈妈']);
  });
  it('paidBy 里手写多个名字(空格/顿号分隔)→ 都能解析', () => {
    expect(payersOf({ paidBy: '我 老张' }, MEMBERS).map((m) => m.name)).toEqual(['我', '老张']);
    expect(payersOf({ paidBy: '我、小舅' }, MEMBERS).map((m) => m.name)).toEqual(['我', '小舅']);
  });
  it('姓名不在名单 / 未填 → 解析不到人', () => {
    expect(payersOf({ paidBy: '路人甲' }, MEMBERS)).toHaveLength(0);
    expect(payersOf({}, MEMBERS)).toHaveLength(0);
  });
  it('payerLabel:多人拼成「我/老张」,解析不到时原样回文本', () => {
    expect(payerLabel({ paidByIds: ['a', 'b'] }, MEMBERS)).toBe('我/老张');
    expect(payerLabel({ paidBy: '路人甲' }, MEMBERS)).toBe('路人甲');
    expect(payerLabel({}, MEMBERS)).toBe('');
  });
});
