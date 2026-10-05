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

/** 某人在这笔账上,由哪几行明细凑出来的钱 */
export interface ExpenseLine {
  /** 明细行名称(票种/项目名) */
  label: string;
  /** bound=这行就是他的;pool=这行没绑人,由全员均摊后他占一份;even=整笔按人头均摊 */
  source: 'bound' | 'pool' | 'even';
  amount: number;
}

/**
 * 单笔账在某人名下的逐行来源(口径与 expenseShares 完全一致,含 amount/明细合计 的等比缩放)。
 * 用于「点开某人 → 看这 ¥X 是哪几行堆的」,方便对账时一眼核对。
 */
export function expenseLinesFor(
  expense: Pick<Expense, 'id' | 'amount' | 'splitMode' | 'parts' | 'participantIds'>,
  member: TripMember,
  members: TripMember[],
): ExpenseLine[] {
  const amount = Number(expense.amount) || 0;
  if (amount <= 0 || members.length === 0) return [];
  const memberIds = new Set(members.map((m) => m.id));
  const label = (p: { label?: string }) => p.label?.trim() || '明细';

  if (expense.splitMode === 'parts' && expense.parts?.length) {
    const raw = partsTotal(expense.parts);
    if (raw > 0) {
      const scale = amount / raw;
      const lines: ExpenseLine[] = [];
      for (const part of expense.parts) {
        const val = partSubtotal(part) * scale;
        if (val <= 0) continue;
        const boundId = part.memberId && memberIds.has(part.memberId) ? part.memberId : undefined;
        if (boundId === member.id) {
          lines.push({ label: label(part), source: 'bound', amount: val });
        } else if (!boundId) {
          // 没绑人的行:全员均摊,他只占 1/人数
          lines.push({ label: `${label(part)}(全员均摊)`, source: 'pool', amount: val / members.length });
        }
      }
      return lines;
    }
  }

  // even / 兜底:整笔这个人占了 share
  const val = expenseShares(expense, members).get(member.id) ?? 0;
  return val > 0 ? [{ label: expense.parts?.[0]?.label?.trim() || '整笔均摊', source: 'even', amount: val }] : [];
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

/**
 * 这笔账的「垫付人」(出账人),支持多人。
 *
 * 口径(新数据优先,旧数据兼容):
 *  - paidByIds(新)有值且能匹配到成员 → 以它为准(多选垫付),顺序按名单排
 *  - 回落 paidBy 姓名文本:按 空格/逗号/顿号/斜杠 切分成多个名字,逐个匹配成员
 *    (兼容旧的单选数据,以及「我 老张」这类手写多名字)
 *  - 匹配不上(自由文本、姓名不在名单里) → 返回 [],该笔不进结算
 */
export function payersOf(
  expense: Pick<Expense, 'paidByIds' | 'paidBy'>,
  members: TripMember[],
): TripMember[] {
  const ids = (expense.paidByIds ?? []).filter((id) => members.some((m) => m.id === id));
  if (ids.length > 0) return members.filter((m) => ids.includes(m.id));

  const text = (expense.paidBy ?? '').trim();
  if (!text) return [];
  const names = new Set(text.split(/[\s,，、;；/&+]+/).filter(Boolean));
  return members.filter((m) => names.has(m.name));
}

/** 垫付人展示文案(列表/结算卡片用):「我」「我/老张」;选填为空 → '' */
export function payerLabel(
  expense: Pick<Expense, 'paidByIds' | 'paidBy'>,
  members: TripMember[],
): string {
  const names = payersOf(expense, members).map((m) => m.name);
  return names.length > 0 ? names.join('/') : (expense.paidBy ?? '').trim();
}

/** 单个成员的结算账本 */
export interface MemberBalance {
  member: TripMember;
  /** 应分摊(该承担的花费) */
  share: number;
  /** 已垫付(出账人 = 该成员的所有账的 amount 之和) */
  paid: number;
  /** 差额 = 已垫付 − 应分摊。>0 该收钱(净垫付),<0 要出钱(净欠账) */
  net: number;
}

/** 一条转账指令:from 转给 to */
export interface Transfer {
  from: TripMember;
  to: TripMember;
  amount: number;
}

export interface Settlement {
  balances: MemberBalance[];
  /** 最简转账清单(笔数尽量少),按「谁付给谁」给出 */
  transfers: Transfer[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** 差额不为 0 才算未平账 */
const isOpen = (net: number) => Math.abs(net) > 0.004;

/**
 * 结算账本:应分摊 vs 已垫付 → 谁该收/谁该付,外加最简转账清单。
 *
 * 口径说明(重要):
 *  - share   : 该成员「该承担多少」(按分摊方式算,全员之和 = 总花费)
 *  - paid    : 该成员「实际垫了多少」(出账人匹配的账,按垫付人数均摊后他占的那份之和)
 *  - net     : paid − share,正数 = 别人该给他,负数 = 他该给别人
 *  - 出账人支持多选(几个人一起扫码付):几人共同垫付 → 每人记 amount / n
 *  - 匹配不上(自由文本、姓名不在名单里) → 不进结算(不影响既有统计)
 */
export function computeSettlement(
  trip: Pick<Trip, 'members' | 'companionCount'> | null | undefined,
  expenses: Expense[],
): Settlement {
  const members = effectiveMembers(trip);
  const spends = computeMemberSpend(trip, expenses);

  const paidById = new Map<string, number>(members.map((m) => [m.id, 0]));
  for (const e of expenses) {
    const payers = payersOf(e, members);
    const amount = Number(e.amount) || 0;
    if (payers.length === 0 || amount <= 0) continue; // 没垫付人 / 匹配不上 → 不进结算
    const per = amount / payers.length; // 多人垫付按人数均摊
    for (const p of payers) paidById.set(p.id, r2((paidById.get(p.id) ?? 0) + per));
  }

  const balances: MemberBalance[] = spends.map((s) => {
    const paid = r2(paidById.get(s.member.id) ?? 0);
    return { member: s.member, share: s.share, paid, net: r2(paid - s.share) };
  });

  return { balances, transfers: minCashFlow(balances) };
}

/**
 * 最简转账:每轮让「最该付的」付给「最该收的」最小金额,直到全平。
 * 结果笔数 = 未平人数 − 1(做到尽量少,方便口头对账)。
 */
function minCashFlow(balances: MemberBalance[]): Transfer[] {
  const transfers: Transfer[] = [];
  const active = balances
    .filter((b) => isOpen(b.net))
    .map((b) => ({ member: b.member, net: b.net }));

  // 必须「一边欠、一边收」才轧得下去。若剩下的人全是净垫付或全是净欠账
  // (例如有笔账压根没记录出账人,多出来的钱谁也没垫),就停下不凑假转账。
  while (active.some((a) => a.net < -0.004) && active.some((a) => a.net > 0.004)) {
    active.sort((x, y) => x.net - y.net);
    const debtor = active[0];   // 最负(该付最多)
    const creditor = active[active.length - 1]; // 最正(该收最多)
    const amount = r2(Math.min(-debtor.net, creditor.net));
    if (amount <= 0) break; // 浮点兜底,防死循环
    transfers.push({ from: debtor.member, to: creditor.member, amount });
    debtor.net = r2(debtor.net + amount);
    creditor.net = r2(creditor.net - amount);
    for (let i = active.length - 1; i >= 0; i--) {
      if (!isOpen(active[i].net)) active.splice(i, 1);
    }
  }
  return transfers;
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
