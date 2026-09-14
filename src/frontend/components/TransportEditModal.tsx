import { useState } from 'react';
import { input, btn, btnGhost, btnDanger, C } from './ui';
import type { Transport, Trip, Expense } from '../types';

export interface TransportEditPatch {
  departAt: string;
  arriveAt: string;
  /** 大交通费用;null = 删除已有费用 */
  expense?: { amount: number; date?: string; note?: string } | null;
}

interface Props {
  transport: Transport;
  trip: Trip;
  linkedExpense?: Expense | null;
  onCancel: () => void;
  onSave: (patch: TransportEditPatch) => Promise<void>;
}

/** 详情页大交通行的「修改」弹窗:起抵时间 + 费用 */
export default function TransportEditModal({ transport, trip, linkedExpense, onCancel, onSave }: Props) {
  const [depart, setDepart] = useState(transport.departAt.slice(0, 16));
  const [arrive, setArrive] = useState(transport.arriveAt.slice(0, 16));
  const [expenseAmount, setExpenseAmount] = useState(linkedExpense ? String(linkedExpense.amount) : '');
  const [expenseDate, setExpenseDate] = useState(linkedExpense?.date ?? '');
  const [expenseNote, setExpenseNote] = useState(linkedExpense?.note ?? '');
  const [clearExpense, setClearExpense] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const confirm = async () => {
    const re = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
    if (!re.test(depart) || !re.test(arrive)) { setError('时间格式错误，应为 yyyy-mm-ddTHH:mm'); return; }
    if (depart >= arrive) { setError('到达时间必须晚于出发时间'); return; }
    let expense: TransportEditPatch['expense'];
    if (clearExpense) {
      expense = null;
    } else {
      const ea = parseFloat(expenseAmount);
      if (!isNaN(ea) && ea > 0) expense = { amount: ea, date: expenseDate || undefined, note: expenseNote.trim() || undefined };
    }
    setSaving(true);
    try { await onSave({ departAt: depart, arriveAt: arrive, expense }); }
    finally { setSaving(false); }
  };

  const modeLabel = transport.mode === 'flight' ? '✈️ 航班' : transport.mode === 'train' ? '🚄 高铁/火车' : transport.mode === 'ferry' ? '⛴ 轮渡' : '🚗 自驾';

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onCancel}
    >
      <div
        style={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 14, padding: 20, width: '100%', maxWidth: 440, color: '#eee' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <strong style={{ fontSize: 16, color: '#ffd166' }}>{modeLabel} {transport.flightNo || transport.trainNo || ''} {transport.fromPlace ?? ''}→{transport.toPlace ?? ''}</strong>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', color: '#888', fontSize: 20, cursor: 'pointer' }}>×</button>
        </div>

        {error && <p style={{ color: C.danger, fontSize: 13, marginTop: 0 }}>{error}</p>}

        <label style={{ fontSize: 12, color: '#999', display: 'block', marginBottom: 4 }}>出发时间</label>
        <input type="datetime-local" value={depart} onChange={(e) => setDepart(e.target.value)} style={{ ...input, marginBottom: 10 }} />
        <label style={{ fontSize: 12, color: '#999', display: 'block', marginBottom: 4 }}>到达时间</label>
        <input type="datetime-local" value={arrive} onChange={(e) => setArrive(e.target.value)} style={{ ...input, marginBottom: 10 }} />

        <label style={{ fontSize: 12, color: '#999', display: 'block', marginBottom: 4 }}>费用(元,选填)</label>
        <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <input type="number" min="0" step="0.01" placeholder="金额" value={expenseAmount} onChange={(e) => { setExpenseAmount(e.target.value); setClearExpense(false); }} style={{ ...input, flex: 1 }} />
          <input type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} style={{ ...input, width: '50%' }} />
        </div>
        <input placeholder="备注(选填)" value={expenseNote} onChange={(e) => setExpenseNote(e.target.value)} style={{ ...input, marginBottom: 10 }} />
        {linkedExpense && (
          <button
            onClick={() => setClearExpense(true)}
            style={{ ...btnDanger, ...btn, padding: '6px 12px', marginBottom: 10, fontSize: 12 }}
          >删除费用</button>
        )}
        {clearExpense && (
          <div style={{ fontSize: 12, color: C.danger, marginBottom: 10 }}>保存后将删除这笔费用。</div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button onClick={confirm} disabled={saving} style={{ ...btn(C.primary), flex: 1 }}>{saving ? '保存中…' : '保存'}</button>
          <button onClick={onCancel} style={{ ...btnGhost, ...btn }}>取消</button>
        </div>
      </div>
    </div>
  );
}
