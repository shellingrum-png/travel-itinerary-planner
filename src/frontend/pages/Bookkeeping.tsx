import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { db } from '../services/db';
import type { Expense, ExpenseCategory, Trip } from '../types';

const CATEGORIES: { value: ExpenseCategory; label: string }[] = [
  { value: 'transport', label: '大交通' },
  { value: 'hotel', label: '住宿' },
  { value: 'food', label: '餐饮' },
  { value: 'ticket', label: '门票' },
  { value: 'local_traffic', label: '本地交通' },
  { value: 'other', label: '其他' },
];

export default function Bookkeeping() {
  const { id: tripId } = useParams<{ id: string }>();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState<ExpenseCategory>('food');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [paidBy, setPaidBy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [perCapitaMode, setPerCapitaMode] = useState<'perSpent' | 'perRemain'>('perSpent');

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

  const totalBudget = trip?.totalBudget ?? 0;
  const companionCount = trip?.companionCount ?? 1;
  const spent = expenses.reduce((s, e) => s + e.amount, 0);
  const remain = Math.max(0, totalBudget - spent);
  const perCapita = perCapitaMode === 'perSpent'
    ? spent / Math.max(1, companionCount)
    : remain / Math.max(1, companionCount);

  const overBudget = totalBudget > 0 && spent > totalBudget;

  const validate = (): string | null => {
    const val = parseFloat(amount);
    if (isNaN(val) || val <= 0) return '金额必须大于 0';
    if (val > 999999) return '金额不能超过 999,999';
    const decimals = amount.includes('.') ? amount.split('.')[1].length : 0;
    if (decimals > 2) return '最多两位小数';
    if (!category) return '请选择分类';
    return null;
  };

  const handleAdd = async () => {
    const err = validate();
    if (err) { setError(err); return; }
    if (!tripId) return;
    await db.addExpense({
      tripId,
      category,
      amount: parseFloat(amount),
      currency: trip?.currency ?? 'CNY',
      date,
      note: note || undefined,
      paidBy: paidBy || undefined,
    });
    setAmount('');
    setNote('');
    setPaidBy('');
    setError(null);
    setShowForm(false);
    await load();
  };

  const handleDelete = async (id: string) => {
    await db.removeExpense(id);
    await load();
  };

  // 分摊计算
  const splitByPayer = () => {
    const map: Record<string, number> = {};
    for (const e of expenses) {
      const payer = e.paidBy || '未标记';
      map[payer] = (map[payer] || 0) + e.amount;
    }
    const entries = Object.entries(map);
    const total = entries.reduce((s, [, v]) => s + v, 0);
    const fair = total / Math.max(1, entries.length);
    return entries.map(([payer, paid]) => ({
      payer,
      paid,
      fair,
      diff: paid - fair,
    }));
  };

  const splits = splitByPayer();

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: 24 }}>
      <Link to={`/trip/${tripId}`}>&larr; 返回旅程</Link>
      <h1>记账</h1>

      {/* 预算条 */}
      {totalBudget > 0 && (
        <div style={{
          marginBottom: 20,
          padding: 12,
          borderRadius: 8,
          background: overBudget ? '#fff0f0' : '#f0f9f0',
          border: overBudget ? '2px solid #d32f2f' : '1px solid #e0e0e0',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold' }}>
            <span>已花 ¥{spent.toFixed(0)}</span>
            <span>预算 ¥{totalBudget.toFixed(0)}</span>
            <span style={{ color: overBudget ? '#d32f2f' : '#2e7d32' }}>
              剩余 ¥{remain.toFixed(0)}
            </span>
          </div>
          <div style={{ marginTop: 8, height: 8, background: '#e0e0e0', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              width: `${Math.min(100, (spent / totalBudget) * 100)}%`,
              background: overBudget ? '#d32f2f' : '#4caf50',
              borderRadius: 4,
              transition: 'width 0.3s',
            }} />
          </div>
          {overBudget && <div style={{ color: '#d32f2f', marginTop: 4, fontWeight: 'bold' }}>预算已超额!</div>}
          <div style={{ marginTop: 8, fontSize: 13, color: '#666', display: 'flex', justifyContent: 'space-between' }}>
            <span>
              {perCapitaMode === 'perSpent' ? '人均已花' : '人均剩余'} ¥{perCapita.toFixed(0)}
              {' '}({companionCount}人)
            </span>
            <button
              onClick={() => setPerCapitaMode(perCapitaMode === 'perSpent' ? 'perRemain' : 'perSpent')}
              style={{ fontSize: 12, border: 'none', background: 'none', cursor: 'pointer', color: '#1677ff' }}
            >
              切换
            </button>
          </div>
        </div>
      )}

      {/* 消费列表 */}
      <h2>消费记录</h2>
      {expenses.length === 0 ? (
        <p style={{ color: '#aaa' }}>暂无消费记录</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {expenses.map((e) => (
            <li key={e.id} style={{ padding: 8, borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div>
                  <strong>¥{e.amount.toFixed(2)}</strong>
                  {' '}{CATEGORIES.find((c) => c.value === e.category)?.label ?? e.category}
                </div>
                <div style={{ color: '#888', fontSize: 13 }}>
                  {e.date}{e.note ? ` · ${e.note}` : ''}{e.paidBy ? ` · ${e.paidBy}付` : ''}
                </div>
              </div>
              <button onClick={() => handleDelete(e.id)} style={{ color: '#c00', border: 'none', background: 'none', cursor: 'pointer' }}>
                删除
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* 添加消费 */}
      {!showForm ? (
        <button onClick={() => setShowForm(true)} style={{ marginTop: 12 }}>+ 记一笔</button>
      ) : (
        <div style={{ marginTop: 12, padding: 12, border: '1px dashed #ccc', borderRadius: 8 }}>
          {error && <p style={{ color: '#c00', fontSize: 13 }}>{error}</p>}
          <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <input
              type="number"
              placeholder="金额"
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setError(null); }}
              style={{ width: 100 }}
              step="0.01"
              min="0"
            />
            <select value={category} onChange={(e) => setCategory(e.target.value as ExpenseCategory)}>
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <input placeholder="备注" value={note} onChange={(e) => setNote(e.target.value)} />
            <input placeholder="付款人" value={paidBy} onChange={(e) => setPaidBy(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleAdd}>确认</button>
            <button onClick={() => { setShowForm(false); setError(null); }}>取消</button>
          </div>
        </div>
      )}

      {/* 分摊账单 */}
      {splits.length > 1 && (
        <div style={{ marginTop: 24 }}>
          <h2>分摊账单</h2>
          <div style={{ border: '1px solid #e0e0e0', borderRadius: 8, padding: 12 }}>
            {splits.map((s, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: i < splits.length - 1 ? '1px solid #f0f0f0' : 'none' }}>
                <span>{s.payer}</span>
                <span>已付 ¥{s.paid.toFixed(0)}</span>
                <span style={{ color: s.diff > 0 ? '#2e7d32' : s.diff < 0 ? '#c00' : '#888' }}>
                  {s.diff > 0 ? `应收 ¥${s.diff.toFixed(0)}` : s.diff < 0 ? `应付 ¥${Math.abs(s.diff).toFixed(0)}` : '已平'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}