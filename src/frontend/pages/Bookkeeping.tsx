import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { db } from '../services/db';
import type { Expense, ExpenseCategory, ExpensePart, SplitMode, Trip, TripMember } from '../types';
import { C, btn, btnGhost, btnSmall, input, PageHeader, EmptyState, card } from '../components/ui';
import MemberModal from '../components/MemberModal';
import TicketFields, { emptyTicketFields, ticketFieldsFromExpense, type TicketFieldsValue } from '../components/TicketFields';
import { ticketAmount, ticketSummary } from '../utils/ticket';
import {
  effectiveMembers, expenseShares, computeMemberSpend, partsTotal, splitSummary, participatesIn,
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
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [paidBy, setPaidBy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [perCapitaMode, setPerCapitaMode] = useState<'perSpent' | 'perRemain'>('perSpent');
  // V12 分摊
  const [splitUi, setSplitUi] = useState<SplitUi>('all');
  const [participants, setParticipants] = useState<string[]>([]);
  const [draftParts, setDraftParts] = useState<DraftPart[]>([emptyPart()]);
  /** 编辑模式:null = 新增 */
  const [editId, setEditId] = useState<string | null>(null);
  const [ticketFields, setTicketFields] = useState<TicketFieldsValue>(emptyTicketFields);
  /** 按人查看:null = 全部 */
  const [focusMemberId, setFocusMemberId] = useState<string | null>(null);

  const load = async () => {
    if (!tripId) return;
    const t = await db.getTrip(tripId);
    setTrip(t);
    if (t) {
      setExpenses(await db.listExpenses(tripId));
    }
  };

  useEffect(() => {
    load();
  }, [tripId]);

  const members: TripMember[] = useMemo(() => effectiveMembers(trip), [trip]);
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const memberSpend = useMemo(() => computeMemberSpend(trip, expenses), [trip, expenses]);
  const focus = focusMemberId ? memberSpend.find((m) => m.member.id === focusMemberId) : null;

  // 成员变化后,清理已失效的选中态
  useEffect(() => {
    const ids = new Set(members.map((m) => m.id));
    setParticipants((p) => p.filter((id) => ids.has(id)));
    if (focusMemberId && !ids.has(focusMemberId)) setFocusMemberId(null);
  }, [members, focusMemberId]);

  const totalBudget = trip?.totalBudget ?? 0;
  const count = members.length;
  const spent = expenses.reduce((s, e) => s + e.amount, 0);
  const remain = Math.max(0, totalBudget - spent);
  // 人均:全部视图 = 总额/人数;按人视图 = 该成员应分摊
  const perCapita = focus
    ? focus.share
    : (perCapitaMode === 'perSpent' ? spent : remain) / Math.max(1, count);
  const overBudget = totalBudget > 0 && spent > totalBudget;

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
    setAmount(''); setNote(''); setPaidBy(''); setError(null);
    setSplitUi('all'); setParticipants([]); setDraftParts([emptyPart()]);
    setEditId(null); setTicketFields(emptyTicketFields());
  };

  /** 打开编辑:预填所有表单字段(含分摊/门票) */
  const openEdit = (e: Expense) => {
    setEditId(e.id);
    setAmount(String(e.amount));
    setCategory(e.category);
    setNote(e.note ?? '');
    setDate(e.date ?? new Date().toISOString().slice(0, 10));
    setPaidBy(e.paidBy ?? '');
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
      paidBy: paidBy || undefined,
    };

    // 门票分类:填了人数/老人 → 联动总额并写入字段
    if (category === 'ticket') {
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

  // 明细行(草稿)合计
  const draftTotal = partsTotal(
    draftParts.map((p) => ({ label: p.label, units: Number(p.units), unitPrice: Number(p.unitPrice) })),
  );

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

      {/* 预算条 */}
      {(totalBudget > 0 || focus) && (
        <div style={{
          marginBottom: 20,
          padding: 16,
          borderRadius: 12,
          background: overBudget ? 'rgba(255,107,107,0.08)' : 'rgba(6,214,160,0.06)',
          border: overBudget ? '1px solid rgba(255,107,107,0.4)' : '1px solid rgba(255,255,255,0.1)',
        }}>
          {focus ? (
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold', fontSize: 15 }}>
              <span>{focus.member.name} 应分摊</span>
              <span style={{ color: C.warning }}>¥{focus.share.toFixed(0)}</span>
              <span style={{ color: '#9a9ab0', fontWeight: 400, fontSize: 13 }}>参与 {focus.count} 笔 · 涉额 ¥{focus.spend.toFixed(0)}</span>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold', fontSize: 15 }}>
                <span>已花 <span style={{ color: C.warning }}>¥{spent.toFixed(0)}</span></span>
                <span>预算 ¥{totalBudget.toFixed(0)}</span>
                <span style={{ color: overBudget ? C.danger : C.success }}>
                  剩余 ¥{remain.toFixed(0)}
                </span>
              </div>
              {totalBudget > 0 && (
                <div style={{ marginTop: 10, height: 8, background: 'rgba(255,255,255,0.1)', borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    width: `${Math.min(100, (spent / totalBudget) * 100)}%`,
                    background: overBudget ? C.danger : C.success,
                    borderRadius: 4,
                    transition: 'width 0.3s',
                  }} />
                </div>
              )}
              {overBudget && <div style={{ color: C.danger, marginTop: 6, fontWeight: 'bold', fontSize: 13 }}>预算已超额!</div>}
              <div style={{ marginTop: 10, fontSize: 13, color: '#9a9ab0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>
                  {perCapitaMode === 'perSpent' ? '人均已花' : '人均剩余'} <strong style={{ color: '#e8e8f0' }}>¥{perCapita.toFixed(0)}</strong>
                  {' '}({count}人)
                </span>
                <button onClick={() => setPerCapitaMode(perCapitaMode === 'perSpent' ? 'perRemain' : 'perSpent')} style={{ fontSize: 12, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.08)', cursor: 'pointer', color: C.info, borderRadius: 6, padding: '4px 10px' }}>
                  切换
                </button>
              </div>
            </>
          )}
        </div>
      )}

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
                    {e.date}{e.note ? ` · ${e.note}` : ''}{e.paidBy ? ` · ${e.paidBy}付` : ''}
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
            <select value={paidBy} onChange={(e) => setPaidBy(e.target.value)} style={{ ...input, width: 'auto' }} title="出账人(选填)">
              <option value="">出账人(选填)</option>
              {members.map((m) => (<option key={m.id} value={m.name}>{m.name}</option>))}
            </select>
          </div>

          {/* 门票分类:人数/老人优惠录入,合计自动回填金额 */}
          {category === 'ticket' && (
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
                未绑定成员的明细行由全员均摊;绑定的记到该成员名下。金额与明细合计不一致时按比例摊。
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
            {memberSpend.map((ms, i) => (
              <div
                key={ms.member.id}
                onClick={() => setFocusMemberId(ms.member.id === focusMemberId ? null : ms.member.id)}
                style={{
                  display: 'flex', justifyContent: 'space-between', padding: '9px 8px', cursor: 'pointer',
                  borderBottom: i < memberSpend.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                  fontSize: 14, borderRadius: 6,
                  background: focusMemberId === ms.member.id ? 'rgba(22,119,255,0.12)' : 'transparent',
                }}
              >
                <span>{ms.member.name}</span>
                <span style={{ color: '#9a9ab0', fontSize: 12 }}>参与 {ms.count} 笔</span>
                <span>应分摊 <strong style={{ color: C.warning }}>¥{ms.share.toFixed(0)}</strong></span>
              </div>
            ))}
            <div style={{ fontSize: 11, color: '#6a6a80', marginTop: 8, lineHeight: 1.5 }}>
              注:仅统计应分摊金额(按分摊方式计算),不含「谁付了钱、谁该转账」的结算。
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
