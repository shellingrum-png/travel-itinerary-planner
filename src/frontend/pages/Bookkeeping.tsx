import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { db } from '../services/db';
import type { Expense, ExpenseCategory, ExpensePart, SplitMode, Trip, TripMember } from '../types';
import { C, btn, btnGhost, btnSmall, input, PageHeader, EmptyState, card } from '../components/ui';
import MemberModal from '../components/MemberModal';
import TicketFields, { emptyTicketFields, ticketFieldsFromExpense, type TicketFieldsValue } from '../components/TicketFields';
import { ticketAmount, ticketSummary } from '../utils/ticket';
import {
  effectiveMembers, expenseShares, computeMemberSpend, computeSettlement, expenseLinesFor, partsTotal, splitSummary,
  participatesIn, payersOf, payerLabel,
} from '../utils/split';

const CATEGORIES: { value: ExpenseCategory; label: string }[] = [
  { value: 'transport', label: '大交通' },
  { value: 'hotel', label: '住宿' },
  { value: 'food', label: '餐饮' },
  { value: 'ticket', label: '门票' },
  { value: 'local_traffic', label: '本地交通' },
  { value: 'other', label: '其他' },
];

/** 分摊方式(「仅部分人」在数据上与 even 相同,只是默认不勾选参与人) */
type SplitUi = 'all' | 'parts' | 'some';

/** 今天的 yyyy-mm-dd */
const todayISO = () => new Date().toISOString().slice(0, 10);

interface DraftPart { label: string; units: string; unitPrice: string; memberId: string }

const emptyPart = (): DraftPart => ({ label: '', units: '1', unitPrice: '', memberId: '' });

export default function Bookkeeping() {
  const { id: tripId } = useParams<{ id: string }>();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState<ExpenseCategory>('food');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(todayISO());
  /** 垫付人(出账人,支持多人:几个人一起扫码付) */
  const [paidByIds, setPaidByIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // V12 分摊
  const [splitUi, setSplitUi] = useState<SplitUi>('all');
  const [participants, setParticipants] = useState<string[]>([]);
  const [draftParts, setDraftParts] = useState<DraftPart[]>([emptyPart()]);
  /** 编辑模式:null = 新增 */
  const [editId, setEditId] = useState<string | null>(null);
  const [ticketFields, setTicketFields] = useState<TicketFieldsValue>(emptyTicketFields);
  /** 按人查看:null = 全部 */
  const [focusMemberId, setFocusMemberId] = useState<string | null>(null);
  /** 分摊汇总里展开某人 → 看他这个数是哪几行明细堆出来的 */
  const [openLedgerId, setOpenLedgerId] = useState<string | null>(null);

  const load = async () => {
    if (!tripId) return;
    const t = await db.getTrip(tripId);
    setTrip(t);
    if (t) {
      setExpenses(await db.listExpenses(tripId));
      // 新增记账的日期默认取行程首日,而不是「今天」
      // (今天往往早于/晚于行程,记一笔默认落到区间外的日期不直观)
      setDate((cur) => (cur === todayISO() ? t.startDate || cur : cur));
    }
  };

  useEffect(() => {
    load();
  }, [tripId]);

  const members: TripMember[] = useMemo(() => effectiveMembers(trip), [trip]);
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const memberSpend = useMemo(() => computeMemberSpend(trip, expenses), [trip, expenses]);
  const focus = focusMemberId ? memberSpend.find((m) => m.member.id === focusMemberId) : null;
  /** 结算账本 + 最简转账清单 */
  const settlement = useMemo(() => computeSettlement(trip, expenses), [trip, expenses]);
  /** 每个成员的逐行分摊来源(展开「成员分摊汇总」时用) */
  const ledgerByMember = useMemo(
    () => new Map(
      memberSpend.map((ms) => [ms.member.id, expenses.flatMap((e) => expenseLinesFor(e, ms.member, members))]),
    ),
    [memberSpend, expenses, members],
  );

  // 成员变化后,清理已失效的选中态
  useEffect(() => {
    const ids = new Set(members.map((m) => m.id));
    setParticipants((p) => p.filter((id) => ids.has(id)));
    if (focusMemberId && !ids.has(focusMemberId)) setFocusMemberId(null);
  }, [members, focusMemberId]);

  const count = members.length;
  // 明细行(草稿)合计
  const draftTotal = partsTotal(
    draftParts.map((p) => ({ label: p.label, units: Number(p.units), unitPrice: Number(p.unitPrice) })),
  );

  // parts 模式:金额恒等于明细合计,明细变化时自动回填。
  // (修复:门票快捷区联动曾把金额覆盖成 ticketAmount,导致「点按明细合计填入后一保存又被改回去」)
  useEffect(() => {
    if (splitUi === 'parts' && draftTotal > 0) setAmount(draftTotal.toFixed(2));
  }, [splitUi, draftTotal]);
  const spent = expenses.reduce((s, e) => s + e.amount, 0);
  // 人均:全部视图 = 总额/人数;按人视图 = 该成员应分摊
  const perCapita = focus ? focus.share : spent / Math.max(1, count);

  // 按人过滤:选中成员时只显示 TA 参与的账
  const visibleExpenses = focusMemberId
    ? expenses.filter((e) => participatesIn(e, focusMemberId, members))
    : expenses;

  const validate = (): string | null => {
    if (splitUi === 'parts') {
      const rows = draftParts.filter((p) => p.label.trim() || p.unitPrice);
      const t = partsTotal(
        rows.map((p) => ({ label: p.label, units: Number(p.units), unitPrice: Number(p.unitPrice) })),
      );
      if (t <= 0) return '请填写票种明细(名称 + 张数 + 单价)';
      if (!amount.trim()) return '请填写金额(可点「按明细合计」自动填入)';
    }
    const val = parseFloat(amount);
    if (isNaN(val) || val <= 0) return '金额必须大于 0';
    if (val > 999999) return '金额不能超过 999,999';
    const decimals = amount.includes('.') ? amount.split('.')[1].length : 0;
    if (decimals > 2) return '最多两位小数';
    if (splitUi === 'some' && participants.length === 0) return '请至少选择一位分摊人';
    return null;
  };

  const resetForm = () => {
    setAmount(''); setNote(''); setPaidByIds([]); setError(null);
    setSplitUi('all'); setParticipants([]); setDraftParts([emptyPart()]);
    setEditId(null); setTicketFields(emptyTicketFields());
    setDate(trip?.startDate || todayISO()); // 回到行程首日(而非今天)
  };

  /** 打开编辑:预填所有表单字段(含分摊/门票) */
  const openEdit = (e: Expense) => {
    setEditId(e.id);
    setAmount(String(e.amount));
    setCategory(e.category);
    setNote(e.note ?? '');
    setDate(e.date ?? todayISO());
    // 垫付人:新数据走 paidByIds;旧数据只有 paidBy(姓名文本)→ 反查成 id
    setPaidByIds(e.paidByIds ?? (e.paidBy ? payersOf(e, members).map((m) => m.id) : []));
    setSplitUi(e.splitMode === 'parts' ? 'parts' : e.participantIds && e.participantIds.length ? 'some' : 'all');
    setParticipants(e.participantIds ?? []);
    setDraftParts(e.parts?.map((p) => ({ label: p.label, units: String(p.units), unitPrice: String(p.unitPrice), memberId: p.memberId ?? '' })) ?? [emptyPart()]);
    setTicketFields(ticketFieldsFromExpense(e));
    setError(null);
    setShowForm(true);
  };

  const handleSubmit = async () => {
    const err = validate();
    if (err) { setError(err); return; }
    if (!tripId) return;

    const patch: Omit<Expense, 'id' | 'dirty'> = {
      tripId,
      category,
      amount: parseFloat(amount),
      currency: trip?.currency ?? 'CNY',
      date,
      note: note || undefined,
      // 垫付人(可多选):paidByIds 存 id,paidBy 存姓名文本,两者始终一致(便于旧字段读取)
      paidByIds: paidByIds.length > 0 ? paidByIds : undefined,
      paidBy: paidByIds.length > 0
        ? paidByIds.map((id) => memberById.get(id)?.name).filter(Boolean).join('/') || undefined
        : undefined,
    };

    // 门票分类快捷录入:填了人数/老人 → 联动总额并写入字段。
    // parts 模式除外:明细行已承载票种/张数/单价,以明细合计为准(见下方 parts 分支)。
    if (category === 'ticket' && splitUi !== 'parts') {
      const hasTicket = ticketFields.count !== '' || ticketFields.unitPrice !== '' || ticketFields.seniorCount !== '' || ticketFields.seniorPrice !== '';
      if (hasTicket) {
        const tk = ticketAmount({
          count: parseFloat(ticketFields.count),
          unitPrice: parseFloat(ticketFields.unitPrice),
          seniorCount: parseFloat(ticketFields.seniorCount),
          seniorPrice: parseFloat(ticketFields.seniorPrice),
        });
        if (tk > 0) {
          patch.amount = tk;
          if (ticketFields.count !== '') patch.ticketCount = parseFloat(ticketFields.count);
          if (ticketFields.unitPrice !== '') patch.unitPrice = parseFloat(ticketFields.unitPrice);
          if (ticketFields.seniorCount !== '') patch.seniorCount = parseFloat(ticketFields.seniorCount);
          if (ticketFields.seniorPrice !== '') patch.seniorPrice = parseFloat(ticketFields.seniorPrice);
        }
      }
    }

    if (splitUi === 'parts') {
      const parts: ExpensePart[] = draftParts
        .map((p): ExpensePart => ({
          label: p.label.trim() || '明细',
          units: Number(p.units) || 0,
          unitPrice: Number(p.unitPrice) || 0,
          memberId: p.memberId || undefined,
        }))
        .filter((p) => p.units > 0 && p.unitPrice > 0);
      patch.splitMode = 'parts';
      patch.parts = parts;
      // 明细合计即总额:按绑定成员精确分摊,不再依赖手填金额
      patch.amount = Math.round(partsTotal(parts) * 100) / 100;
      // 清掉旧门票快捷字段,避免列表摘要(如「4人·成人3×120」)与明细相互矛盾
      patch.ticketCount = undefined;
      patch.unitPrice = undefined;
      patch.seniorCount = undefined;
      patch.seniorPrice = undefined;
    } else if (splitUi === 'some') {
      patch.splitMode = 'even';
      patch.participantIds = participants;
    }
    // splitUi === 'all' → 不写分摊字段,等价于「全员均摊」(旧数据同款,最省存储)

    if (editId) {
      await db.updateExpense(editId, patch);
    } else {
      await db.addExpense(patch);
    }
    resetForm();
    setShowForm(false);
    await load();
  };

  const handleDelete = async (id: string) => {
    await db.removeExpense(id);
    await load();
  };

  const chip = (active: boolean) => ({
    fontSize: 12, padding: '4px 12px', borderRadius: 999, cursor: 'pointer', whiteSpace: 'nowrap' as const,
    border: active ? `1px solid ${C.primary}` : '1px solid rgba(255,255,255,0.14)',
    background: active ? 'rgba(22,119,255,0.2)' : 'rgba(255,255,255,0.05)',
    color: active ? '#7db4ff' : '#9a9ab2',
  });

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', padding: 24, minHeight: '100vh' }}>
      <Link to={`/trip/${tripId}`} style={{ color: '#06d6a0', fontSize: 13, textDecoration: 'none' }}>&larr; 返回旅程</Link>
      <PageHeader
        title="记账"
        subtitle={trip ? `${trip.title} · ${members.map((m) => m.name).join(' / ')}` : undefined}
        right={
          <button onClick={() => setShowMembers(true)} style={{ ...btnGhost, ...btnSmall }}>👥 成员</button>
        }
      />

      {/* 成员选择条:全部 / 按人查看 */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        <button onClick={() => setFocusMemberId(null)} style={chip(focusMemberId === null)}>全部</button>
        {memberSpend.map((ms) => (
          <button
            key={ms.member.id}
            onClick={() => setFocusMemberId(ms.member.id === focusMemberId ? null : ms.member.id)}
            style={chip(focusMemberId === ms.member.id)}
            title={`应分摊 ¥${ms.share.toFixed(0)}`}
          >
            {ms.member.name} ¥{ms.share.toFixed(0)}
          </button>
        ))}
      </div>

      {/* 总花费 + 按人查看时的成员汇总 */}
      <div style={{
        marginBottom: 20,
        padding: '12px 16px',
        borderRadius: 12,
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.1)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <div>
          <div style={{ fontSize: 12, color: '#9a9ab0' }}>总花费</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.warning }}>¥{spent.toFixed(0)}</div>
        </div>
        {focus && (
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 12, color: '#9a9ab0' }}>{focus.member.name} 应分摊</div>
            <div style={{ fontSize: 18, fontWeight: 600, color: C.warning }}>¥{focus.share.toFixed(0)}</div>
            <div style={{ fontSize: 11, color: '#9a9ab0' }}>参与 {focus.count} 笔 · 涉额 ¥{focus.spend.toFixed(0)}</div>
          </div>
        )}
        {!focus && count > 1 && (
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 12, color: '#9a9ab0' }}>人均</div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>¥{perCapita.toFixed(0)}</div>
          </div>
        )}
      </div>

      {/* 消费列表 */}
      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>
        消费记录
        {focus && <span style={{ fontSize: 13, color: '#9a9ab0', fontWeight: 400 }}> · {focus.member.name} 参与的 {visibleExpenses.length} 笔</span>}
      </h2>
      {visibleExpenses.length === 0 ? (
        <EmptyState>{focus ? `${focus.member.name} 暂无相关消费记录` : '暂无消费记录'}</EmptyState>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {visibleExpenses.map((e) => {
            const summary = splitSummary(e, members);
            const tsum = ticketSummary(e);
            return (
              <div key={e.id} style={{ padding: '12px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderRadius: 10, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div>
                    <strong style={{ fontSize: 15 }}>¥{e.amount.toFixed(2)}</strong>
                    {' '}<span style={{ fontSize: 13, color: '#9a9ab2' }}>{CATEGORIES.find((c) => c.value === e.category)?.label ?? e.category}</span>
                  </div>
                  <div style={{ color: '#6a6a80', fontSize: 12, marginTop: 2 }}>
                    {e.date}{e.note ? ` · ${e.note}` : ''}{(() => { const pl = payerLabel(e, members); return pl ? ` · ${pl}付` : ''; })()}
                  </div>
                  {tsum && (
                    <div style={{ color: '#8f9ab8', fontSize: 11, marginTop: 3 }}>{tsum}</div>
                  )}
                  {summary && (
                    <div style={{ color: C.info, fontSize: 11, marginTop: 3 }}>{summary}</div>
                  )}
                  {/* 按人查看时,显示该成员在这笔账里的份额 */}
                  {focus && (
                    <div style={{ color: C.warning, fontSize: 11, marginTop: 2 }}>
                      {focus.member.name} 承担 ¥{(expenseShares(e, members).get(focus.member.id) ?? 0).toFixed(2)}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <button onClick={() => openEdit(e)} style={{ ...btnGhost, ...btnSmall }}>编辑</button>
                  <button onClick={() => handleDelete(e.id)} style={{ ...btnGhost, ...btnSmall, color: C.danger }}>删除</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 添加消费 */}
      {!showForm ? (
        <button onClick={() => { setShowForm(true); if (members.length) setParticipants([]); }} style={{ ...btn(), marginTop: 12 }}>+ 记一笔</button>
      ) : (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
          onClick={() => { setShowForm(false); resetForm(); }}
        >
          <div
            style={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 14, padding: 20, width: '100%', maxWidth: 440, maxHeight: '85vh', overflow: 'auto', color: '#eee' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <strong style={{ fontSize: 16, color: '#ffd166' }}>{editId ? '✏️ 编辑消费' : '+ 记一笔'}</strong>
              <button onClick={() => { setShowForm(false); resetForm(); }} style={{ background: 'none', border: 'none', color: '#888', fontSize: 20, cursor: 'pointer' }}>×</button>
            </div>
            {error && <p style={{ color: C.danger, fontSize: 13, marginTop: 0 }}>{error}</p>}
          <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <input type="number" placeholder="金额" value={amount} onChange={(e) => { setAmount(e.target.value); setError(null); }} style={{ ...input, width: 100 }} step="0.01" min="0" />
            <select value={category} onChange={(e) => setCategory(e.target.value as ExpenseCategory)} style={{ ...input, width: 'auto' }}>
              {CATEGORIES.map((c) => (<option key={c.value} value={c.value}>{c.label}</option>))}
            </select>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ ...input, width: 'auto' }} />
            <input placeholder="备注" value={note} onChange={(e) => setNote(e.target.value)} style={{ ...input, flex: 1, minWidth: 100 }} />
          </div>

          {/* 垫付人(出账人):可多选,几个人一起付就全选,结算时按人数均摊 */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 12, color: '#6a6a80', marginBottom: 6 }}>
              垫付人(出账人,可多选):
              {paidByIds.length > 0 && (
                <span style={{ color: '#9a9ab0', marginLeft: 4 }}>
                  {paidByIds.length > 1
                    ? ` ${paidByIds.length} 人各垫 ¥${((parseFloat(amount) || 0) / paidByIds.length).toFixed(2)}`
                    : ` ${memberById.get(paidByIds[0])?.name ?? ''} 垫 ¥${(parseFloat(amount) || 0).toFixed(2)}`}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {members.map((m) => {
                const on = paidByIds.includes(m.id);
                return (
                  <button
                    key={m.id}
                    onClick={() => setPaidByIds((p) => (on ? p.filter((x) => x !== m.id) : [...p, m.id]))}
                    style={chip(on)}
                  >{on ? '✓ ' : ''}{m.name}</button>
                );
              })}
            </div>
          </div>

          {/* 门票分类快捷录入:人数/老人优惠,合计自动回填金额(parts 明细模式下隐藏,以明细行为准) */}
          {category === 'ticket' && splitUi !== 'parts' && (
            <div style={{ marginBottom: 8 }}>
              <TicketFields
                value={ticketFields}
                onChange={(v) => {
                  setTicketFields(v);
                  const tk = ticketAmount({
                    count: parseFloat(v.count),
                    unitPrice: parseFloat(v.unitPrice),
                    seniorCount: parseFloat(v.seniorCount),
                    seniorPrice: parseFloat(v.seniorPrice),
                  });
                  if (tk > 0) setAmount(String(tk));
                }}
              />
            </div>
          )}

          {/* 分摊方式 */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            {([['all', `全员均摊(${count}人)`], ['parts', '按票种明细'], ['some', '仅部分人']] as [SplitUi, string][]).map(([v, label]) => (
              <button
                key={v}
                onClick={() => {
                  setSplitUi(v); setError(null);
                  if (v === 'some' && participants.length === 0) setParticipants([]);
                }}
                style={{
                  flex: 1, padding: '7px 0', fontSize: 12, border: 'none', borderRadius: 8, cursor: 'pointer',
                  background: splitUi === v ? C.primary : 'rgba(255,255,255,0.07)',
                  color: splitUi === v ? '#fff' : '#9a9ab2',
                  fontWeight: splitUi === v ? 600 : 400,
                }}
              >{label}</button>
            ))}
          </div>

          {/* 全员均摊:展示每人份额 */}
          {splitUi === 'all' && (
            <div style={{ fontSize: 12, color: '#9a9ab0', marginBottom: 8, padding: '8px 10px', borderRadius: 8, background: 'rgba(255,255,255,0.04)' }}>
              {amount && parseFloat(amount) > 0
                ? <>每人承担 <strong style={{ color: C.warning }}>¥{(parseFloat(amount) / Math.max(1, count)).toFixed(2)}</strong>（{members.map((m) => m.name).join(' / ')}）</>
                : <>填入金额后自动按 {count} 人均摊</>}
            </div>
          )}

          {/* 仅部分人:勾选参与分摊的人 */}
          {splitUi === 'some' && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, color: '#6a6a80', marginBottom: 6 }}>选择参与分摊的人:</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {members.map((m) => {
                  const on = participants.includes(m.id);
                  return (
                    <button
                      key={m.id}
                      onClick={() => setParticipants((p) => on ? p.filter((x) => x !== m.id) : [...p, m.id])}
                      style={chip(on)}
                    >{on ? '✓ ' : ''}{m.name}</button>
                  );
                })}
              </div>
              {amount && parseFloat(amount) > 0 && participants.length > 0 && (
                <div style={{ fontSize: 12, color: '#9a9ab0', marginTop: 8 }}>
                  每人承担 <strong style={{ color: C.warning }}>¥{(parseFloat(amount) / participants.length).toFixed(2)}</strong>
                </div>
              )}
            </div>
          )}

          {/* 按票种明细 */}
          {splitUi === 'parts' && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12, color: '#6a6a80', marginBottom: 6 }}>票种 / 明细(可绑定到具体成员):</div>
              {draftParts.map((p, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                  <input placeholder="如 普通票" value={p.label} onChange={(e) => setDraftParts((ps) => ps.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} style={{ ...input, flex: 2, minWidth: 70 }} />
                  <input type="number" placeholder="张数" value={p.units} onChange={(e) => setDraftParts((ps) => ps.map((x, j) => j === i ? { ...x, units: e.target.value } : x))} style={{ ...input, width: 58 }} min="0" />
                  <input type="number" placeholder="单价" value={p.unitPrice} onChange={(e) => setDraftParts((ps) => ps.map((x, j) => j === i ? { ...x, unitPrice: e.target.value } : x))} style={{ ...input, width: 68 }} min="0" step="0.01" />
                  <select value={p.memberId} onChange={(e) => setDraftParts((ps) => ps.map((x, j) => j === i ? { ...x, memberId: e.target.value } : x))} style={{ ...input, width: 'auto' }} title="绑定到成员(选填)">
                    <option value="">不限</option>
                    {members.map((m) => (<option key={m.id} value={m.id}>{m.name}</option>))}
                  </select>
                  <button
                    onClick={() => setDraftParts((ps) => ps.length <= 1 ? [emptyPart()] : ps.filter((_, j) => j !== i))}
                    style={{ ...btnGhost, ...btnSmall, background: 'rgba(255,107,107,0.14)', color: C.danger, border: '1px solid rgba(255,107,107,0.25)', flexShrink: 0 }}
                  >×</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button onClick={() => setDraftParts((ps) => [...ps, emptyPart()])} style={{ ...btnGhost, ...btnSmall, fontSize: 12 }}>+ 加一行</button>
                {draftTotal > 0 && (
                  <span style={{ fontSize: 12, color: '#9a9ab0' }}>
                    明细合计 <strong style={{ color: C.warning }}>¥{draftTotal.toFixed(2)}</strong>
                    <button
                      onClick={() => setAmount(String(draftTotal))}
                      style={{ marginLeft: 8, fontSize: 12, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.08)', cursor: 'pointer', color: C.info, borderRadius: 6, padding: '3px 10px' }}
                    >按明细合计填入</button>
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: '#6a6a80', marginTop: 6, lineHeight: 1.5 }}>
                总金额自动 = 明细合计(¥{draftTotal.toFixed(2)}),按行绑定的人头精确分摊;未绑定成员的行由全员均摊。
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button onClick={handleSubmit} style={btn()}>{editId ? '保存修改' : '确认'}</button>
            <button onClick={() => { setShowForm(false); resetForm(); }} style={btnGhost}>取消</button>
          </div>
          </div>
        </div>
      )}

      {/* 按人汇总 */}
      {members.length > 1 && (
        <div style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>成员分摊汇总</h2>
          <div style={{ ...card, padding: 12 }}>
            {memberSpend.map((ms, i) => {
              const open = openLedgerId === ms.member.id;
              const ledger = ledgerByMember.get(ms.member.id) ?? [];
              return (
                <div key={ms.member.id}>
                  <div
                    onClick={() => setOpenLedgerId(open ? null : ms.member.id)}
                    style={{
                      display: 'flex', justifyContent: 'space-between', padding: '9px 8px', cursor: 'pointer',
                      borderBottom: '1px solid rgba(255,255,255,0.05)', fontSize: 14, borderRadius: 6,
                      background: focusMemberId === ms.member.id ? 'rgba(22,119,255,0.12)' : 'transparent',
                    }}
                  >
                    <span>
                      {ms.member.name} <span style={{ color: '#6a6a80', fontSize: 11 }}>{open ? '▾' : '▸'}</span>
                    </span>
                    <span style={{ color: '#9a9ab0', fontSize: 12 }}>参与 {ms.count} 笔</span>
                    <span>应分摊 <strong style={{ color: C.warning }}>¥{ms.share.toFixed(0)}</strong></span>
                  </div>
                  {open && (
                    <div style={{ padding: '4px 10px 10px' }}>
                      {ledger.length === 0 ? (
                        <div style={{ fontSize: 12, color: '#6a6a80' }}>暂无分摊明细</div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {ledger.map((l, k) => (
                            <div key={k} style={{ display: 'flex', fontSize: 12, color: '#b9b9cc' }}>
                              <span style={{ flex: 1, color: l.source === 'bound' ? C.warning : '#8f9ab8' }}>{l.label}</span>
                              <span style={{ color: '#9a9ab0' }}>
                                {l.source === 'bound' ? '本人' : l.source === 'even' ? '均摊' : `${count}人均摊`}
                              </span>
                              <span style={{ width: 62, textAlign: 'right' }}>¥{l.amount.toFixed(2)}</span>
                            </div>
                          ))}
                          <div style={{ fontSize: 11, color: '#6a6a80', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 5 }}>
                            逐行合计 ¥{ledger.reduce((s, l) => s + l.amount, 0).toFixed(2)} · 绑定本人的行全额记他;其余行由 {count} 人均摊
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            <div style={{ fontSize: 11, color: '#6a6a80', marginTop: 8, lineHeight: 1.5 }}>
              点姓名可展开,看这个数是哪几行明细堆的。注:仅统计应分摊金额(按分摊方式计算),不含「谁付了钱、谁该转账」的结算。
            </div>
          </div>
        </div>
      )}

      {/* 结算:应分摊 vs 已垫付 → 谁该收/谁该付 + 最简转账清单 */}
      {members.length > 1 && (
        <div style={{ marginTop: 20 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>结算 · 谁转谁</h2>
          <div style={{ ...card, padding: 12 }}>
            {/* 表头 */}
            <div style={{ display: 'flex', fontSize: 11, color: '#6a6a80', padding: '4px 8px' }}>
              <span style={{ flex: 1 }}>成员</span>
              <span style={{ width: 66, textAlign: 'right' }}>已垫付</span>
              <span style={{ width: 66, textAlign: 'right' }}>应分摊</span>
              <span style={{ width: 78, textAlign: 'right' }}>差额</span>
            </div>
            {settlement.balances.map((b, i) => {
              const receivable = b.net > 0;   // 净垫付 → 该收
              const payable = b.net < 0;      // 净欠账 → 该出
              return (
                <div
                  key={b.member.id}
                  style={{
                    display: 'flex', alignItems: 'center', padding: '8px', fontSize: 14,
                    borderBottom: i < settlement.balances.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                  }}
                >
                  <span style={{ flex: 1 }}>{b.member.name}</span>
                  <span style={{ width: 66, textAlign: 'right', color: '#9a9ab0', fontSize: 12 }}>{b.paid.toFixed(2)}</span>
                  <span style={{ width: 66, textAlign: 'right', color: '#9a9ab0', fontSize: 12 }}>{b.share.toFixed(2)}</span>
                  <span style={{ width: 78, textAlign: 'right', fontSize: 13 }}>
                    <strong style={{ color: receivable ? C.warning : payable ? C.info : '#6a6a80' }}>
                      {receivable ? `+${b.net.toFixed(2)}` : payable ? b.net.toFixed(2) : '0'}
                    </strong>
                    {receivable && <span style={{ color: C.warning, fontSize: 11 }}> 该收</span>}
                    {payable && <span style={{ color: C.info, fontSize: 11 }}> 要出</span>}
                  </span>
                </div>
              );
            })}

            {/* 转账清单 */}
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: '#9a9ab0', marginBottom: 6 }}>
                {settlement.transfers.length > 0
                  ? `转账清单(共 ${settlement.transfers.length} 笔):`
                  : settlement.balances.every((b) => b.net === 0)
                    ? '当前已平账,无需转账'
                    : '暂无可结转账(可能还无人垫付,或有账没记出账人)'}
              </div>
              {settlement.transfers.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {settlement.transfers.map((t, i) => (
                    <div
                      key={`${t.from.id}-${t.to.id}-${i}`}
                      style={{ fontSize: 13, padding: '7px 10px', borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
                    >
                      <span style={{ color: C.danger }}>{t.from.name}</span>
                      <span style={{ color: '#6a6a80', margin: '0 6px' }}>→</span>
                      <span style={{ color: C.warning }}>{t.to.name}</span>
                      <strong style={{ float: 'right', color: C.warning }}>¥{t.amount.toFixed(2)}</strong>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ fontSize: 11, color: '#6a6a80', marginTop: 10, lineHeight: 1.6 }}>
              差额 = 已垫付 − 应分摊。正数 = 你帮他垫了钱、该收;负数 = 你还没摊够、要出。
              转账清单按「最该付的付给最该收的」逐笔轧差,笔数最少,照着转即可结清。
              已在「记一笔 → 垫付人」里勾选上出账人才会计入垫付;多人一起垫付时,按人数均摊各自垫付额。
            </div>
          </div>
        </div>
      )}

      {showMembers && trip && (
        <MemberModal
          trip={trip}
          onClose={() => setShowMembers(false)}
          onSaved={async () => { await load(); }}
        />
      )}
    </div>
  );
}
