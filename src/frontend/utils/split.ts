/**
 * V12 记账分摊计算 — 纯函数,可单测,不依赖浏览器 API
 *
 * 背景:多人出游统一记账,需要「按每个人单独查看」与「按票种分摊」。
 * 设计原则:**旧数据零破坏** —— members/participantIds/parts 全部缺失时,
 * 结果必须与改造前「总额 ÷ companionCount」完全一致。
 *
 * 术语:
 *  - 成员(member):同行人,由 trip.members 给出;旧数据无此字段 → 按 companionCount 匿名兜底
 *  - 分摊(share):某成员在这笔账上「应该承担」的金额
 *  - 支出(spend):某成员「参与的账」的总额(按人查看时展示;≠ 实际垫付,付款人不在本次改造范围)
 */
import type { Trip, TripMember, Expense, ExpensePart } from '../types';

/** 匿名成员 id 前缀(旧数据兜底时生成,不落库) */
const ANON_PREFIX = '__anon_member__';

/**
 * 生效的成员名单。
 * - trip.members 有内容 → 直接用它
 * - 否则按 companionCount 生成匿名「人1…人N」(旧数据/未设置名单时的兜底)
 * - companionCount 缺失或 <1 → 至少返回 1 人(避免除零)
 */
export function effectiveMembers(trip: Pick<Trip, 'members' | 'companionCount'> | null | undefined): TripMember[] {
  const named = trip?.members?.filter((m) => m && m.id);
  if (named && named.length > 0) return named;

  const n = Math.max(1, Math.floor(trip?.companionCount ?? 1) || 1);
  return Array.from({ length: n }, (_, i) => ({ id: `${ANON_PREFIX}${i + 1}`, name: `人${i + 1}` }));
}

/** 生效人数(各处人均统一走它,避免 members/companionCount 两套口径) */
export function effectiveCount(trip: Pick<Trip, 'members' | 'companionCount'> | null | undefined): number {
  return effectiveMembers(trip).length;
}

/** 是否为匿名兜底成员(UI 上不宜把「人3」当真实姓名展示) */
export function isAnonMember(memberId: string): boolean {
  return memberId.startsWith(ANON_PREFIX);
}

/** 明细行小计 */
export function partSubtotal(part: ExpensePart): number {
  const units = Number(part.units) || 0;
  const price = Number(part.unitPrice) || 0;
  return units * price;
}

/** parts 明细合计(用于录入时提示「明细合计 ≠ 金额」) */
export function partsTotal(parts: ExpensePart[] | undefined): number {
  return (parts ?? []).reduce((s, p) => s + partSubtotal(p), 0);
}

/**
 * 单笔账的分摊:memberId → 应承担金额。
 *
 * even 模式:amount 平摊给参与者(participantIds 缺省 = 全体成员)。
 * parts 模式:
 *  - 每一行按 units×unitPrice 计额;行绑了 memberId → 全额记到该成员
 *  - 未绑定的行 → 由「全体成员」均摊(绑定的成员不重复参与该行分摊)
 *  - 明细合计与 amount 不一致时,按比例缩放,保证分摊之和 = amount(总额口径不变)
 *  - **行绑定到不存在的成员**(成员被删)时,该行退回全员均摊,不崩
 *
 * 返回的 Map 只包含有金额的成员;总和恒等于 amount(四舍五入误差在最后一档吸收)。
 */
export function expenseShares(
  expense: Pick<Expense, 'amount' | 'splitMode' | 'parts' | 'participantIds'>,
  members: TripMember[],
): Map<string, number> {
  const out = new Map<string, number>();
  const amount = Number(expense.amount) || 0;
  if (amount <= 0 || members.length === 0) return out;

  const memberIds = new Set(members.map((m) => m.id));
  const add = (id: string, v: number) => out.set(id, (out.get(id) ?? 0) + v);

  // ── parts:按明细行分配 ──
  if (expense.splitMode === 'parts' && expense.parts?.length) {
    const rawTotal = partsTotal(expense.parts);
    // 明细合计为 0(全填了 0)→ 无法按行分配,退回全员均摊
    if (rawTotal > 0) {
      const scale = amount / rawTotal; // 明细合计 ≠ 金额时等比缩放
      for (const part of expense.parts) {
        const val = partSubtotal(part) * scale;
        if (val === 0) continue;
        // 行绑定的成员必须存在,否则视为未绑定
        const bound = part.memberId && memberIds.has(part.memberId) ? part.memberId : undefined;
        if (bound) {
          add(bound, val);
        } else {
          // 未绑定 → 全体均摊该行
          for (const m of members) add(m.id, val / members.length);
        }
      }
      return roundShares(out, amount);
    }
  }

  // ── even:按参与者均摊 ──
  const requested = expense.participantIds?.filter((id) => memberIds.has(id)) ?? [];
  // 参与者为空(未指定,或指定的成员都已被删)→ 全体成员
  const participants = requested.length > 0 ? requested : members.map((m) => m.id);
  const per = amount / participants.length;
  for (const id of participants) add(id, per);
  return roundShares(out, amount);
}

/**
 * 四舍五入到分,并把误差吸收到金额最大的一档,保证总和精确等于 amount。
 * (避免「人均显示加起来和总额差 1 分」这类对不上账的观感问题)
 */
function roundShares(shares: Map<string, number>, amount: number): Map<string, number> {
  const rounded = new Map<string, number>();
  let sum = 0;
  let maxId: string | null = null;
  let maxVal = -Infinity;
  for (const [id, v] of shares) {
    const r = Math.round(v * 100) / 100;
    rounded.set(id, r);
    sum += r;
    if (r > maxVal) { maxVal = r; maxId = id; }
  }
  const diff = Math.round((amount - sum) * 100) / 100;
  if (diff !== 0 && maxId) rounded.set(maxId, Math.round((rounded.get(maxId)! + diff) * 100) / 100);
  return rounded;
}

export interface MemberSpend {
  member: TripMember;
  /** 应分摊金额(该成员在所有账目上的承担之和) */
  share: number;
  /** 参与的账目总额(按人查看时展示;口径 = 该成员参与的账的 amount 之和) */
  spend: number;
  /** 该成员参与的账目数量 */
  count: number;
}

/** 某成员是否参与这笔账(用于按人过滤列表;未指定参与人的账视为全员参与) */
export function participatesIn(expense: Pick<Expense, 'splitMode' | 'parts' | 'participantIds'>, memberId: string, members: TripMember[]): boolean {
  const memberIds = new Set(members.map((m) => m.id));
  if (!memberIds.has(memberId)) return false;

  if (expense.splitMode === 'parts' && expense.parts?.length) {
    // 绑了成员的行 → 该成员参与;任何未绑定的行 → 全员参与
    const hasUnbound = expense.parts.some((p) => !(p.memberId && memberIds.has(p.memberId)));
    if (hasUnbound) return true;
    return expense.parts.some((p) => p.memberId === memberId);
  }

  const requested = expense.participantIds?.filter((id) => memberIds.has(id)) ?? [];
  return requested.length === 0 || requested.includes(memberId);
}

/** 汇总每个成员的分摊与参与支出(顺序同 members) */
export function computeMemberSpend(
  trip: Pick<Trip, 'members' | 'companionCount'> | null | undefined,
  expenses: Expense[],
): MemberSpend[] {
  const members = effectiveMembers(trip);
  const acc = new Map<string, MemberSpend>(
    members.map((m) => [m.id, { member: m, share: 0, spend: 0, count: 0 }]),
  );

  for (const e of expenses) {
    const shares = expenseShares(e, members);
    for (const [id, v] of shares) {
      const entry = acc.get(id);
      if (entry) entry.share += v;
    }
    const amount = Number(e.amount) || 0;
    for (const m of members) {
      if (participatesIn(e, m.id, members)) {
        const entry = acc.get(m.id)!;
        entry.spend += amount;
        entry.count += 1;
      }
    }
  }

  return members.map((m) => {
    const e = acc.get(m.id)!;
    return { ...e, share: Math.round(e.share * 100) / 100, spend: Math.round(e.spend * 100) / 100 };
  });
}

/** 单笔账的分摊摘要文案(列表里展示),UI 与测试共用 */
export function splitSummary(
  expense: Pick<Expense, 'amount' | 'splitMode' | 'parts' | 'participantIds'>,
  members: TripMember[],
): string {
  const amount = Number(expense.amount) || 0;
  if (amount <= 0 || members.length === 0) return '';

  if (expense.splitMode === 'parts' && expense.parts?.length) {
    return expense.parts
      .filter((p) => partSubtotal(p) > 0)
      .map((p) => {
        const owner = p.memberId ? members.find((m) => m.id === p.memberId)?.name : undefined;
        return owner ? `${p.label}×${p.units}(${owner})` : `${p.label}×${p.units}`;
      })
      .join(' + ');
  }

  const shares = expenseShares(expense, members);
  const sharers = members.filter((m) => (shares.get(m.id) ?? 0) > 0);
  if (sharers.length === 0) return '';
  if (sharers.length === members.length) {
    return `人均 ¥${(amount / members.length).toFixed(0)}`;
  }
  return `${sharers.map((m) => m.name).join('/')} 分摊 ¥${(amount / sharers.length).toFixed(0)}`;
}
