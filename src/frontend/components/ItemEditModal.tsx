import { useState } from 'react';
import { input, btn, btnGhost, btnDanger, C } from './ui';
import { searchPoiByJS, type PoiSearchResult } from '../services/amap';
import { ticketAmount } from '../utils/ticket';
import type { TicketMeta } from '../utils/itemEdit';
import TicketFields, { ticketFieldsFromExpense, type TicketFieldsValue } from './TicketFields';
import type { ItineraryItem, Poi, TransportMode, Expense } from '../types';

export interface EditPatch {
  visitMinutes?: number;
  note?: string;
  ticket?: number;
  /** 门票人数/老人优惠字段(amount 恒为总额) */
  ticketMeta?: TicketMeta;
  /** 非景点 item(如酒店)的费用;null = 删除已有费用 */
  expense?: { amount: number; date?: string; note?: string } | null;
  replacePoi?: PoiSearchResult;
  /** 从上一站到本站的交通方式 */
  transportMode?: TransportMode;
}

/** 可选的到达方式(顺序即展示顺序) */
const MODE_OPTIONS: Array<{ value: TransportMode; icon: string; label: string }> = [
  { value: 'walk', icon: '🚶', label: '步行' },
  { value: 'drive', icon: '🚗', label: '驾车' },
  { value: 'transit', icon: '🚌', label: '公交' },
  { value: 'train', icon: '🚄', label: '火车' },
  { value: 'flight', icon: '✈️', label: '飞机' },
];

interface Props {
  item: (ItineraryItem & { poi?: Poi }) | null;
  defaultCity: string;
  currency: string;
  /** 关联的门票记账(有则编辑/回填,无则新建) */
  linkedTicketExpense?: Expense | null;
  /** 关联的费用记账(非景点 item,如酒店;有则编辑/回填) */
  linkedExpense?: Expense | null;
  /** 是否为当天首个有坐标的节点(此时该段是跨天衔接) */
  isFirstStop?: boolean;
  onCancel: () => void;
  onSave: (patch: EditPatch) => Promise<void>;
}

export default function ItemEditModal({ item, defaultCity, currency, linkedTicketExpense, linkedExpense, isFirstStop, onCancel, onSave }: Props) {
  const [visitMin, setVisitMin] = useState(item ? String(item.visitMinutes ?? 90) : '');
  const [note, setNote] = useState(item?.note ?? '');
  const [ticketFields, setTicketFields] = useState<TicketFieldsValue>(() => ticketFieldsFromExpense(linkedTicketExpense));
  const [expenseAmount, setExpenseAmount] = useState(linkedExpense ? String(linkedExpense.amount) : '');
  const [expenseDate, setExpenseDate] = useState(linkedExpense?.date ?? '');
  const [expenseNote, setExpenseNote] = useState(linkedExpense?.note ?? '');
  const [clearExpense, setClearExpense] = useState(false);
  const [kw, setKw] = useState('');
  const [city, setCity] = useState(defaultCity);
  const [results, setResults] = useState<PoiSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<PoiSearchResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<TransportMode>(item?.transportMode ?? 'drive');

  if (!item) return null;
  const isPoi = item.itemType === 'poi';

  const num = (s: string) => (s === '' ? undefined : parseFloat(s));

  const doSearch = async () => {
    if (!kw.trim()) return;
    setSearching(true); setResults([]);
    try { setResults(await searchPoiByJS(kw.trim(), city || undefined)); }
    catch { setResults([]); }
    finally { setSearching(false); }
  };

  const confirm = async () => {
    setSaving(true);
    try {
      const vm = visitMin === '' ? undefined : parseInt(visitMin, 10);
      const hasTicket = ticketFields.count !== '' || ticketFields.unitPrice !== '' || ticketFields.seniorCount !== '' || ticketFields.seniorPrice !== '';
      const tk = hasTicket
        ? ticketAmount({
            count: num(ticketFields.count),
            unitPrice: num(ticketFields.unitPrice),
            seniorCount: num(ticketFields.seniorCount),
            seniorPrice: num(ticketFields.seniorPrice),
          })
        : undefined;
      const ticketMeta: TicketMeta | undefined = isPoi && hasTicket && tk != null ? {
        ticketCount: num(ticketFields.count),
        unitPrice: num(ticketFields.unitPrice),
        seniorCount: num(ticketFields.seniorCount),
        seniorPrice: num(ticketFields.seniorPrice),
      } : undefined;
      let expense: EditPatch['expense'];
      if (!isPoi) {
        if (clearExpense) {
          expense = null;
        } else {
          const ea = parseFloat(expenseAmount);
          if (!isNaN(ea) && ea > 0) expense = { amount: ea, date: expenseDate || undefined, note: expenseNote.trim() || undefined };
        }
      }
      await onSave({
        visitMinutes: isPoi && vm !== undefined ? (isNaN(vm) ? undefined : vm) : undefined,
        note: note.trim(),
        ticket: isPoi ? tk : undefined,
        ticketMeta: isPoi ? ticketMeta : undefined,
        expense: isPoi ? undefined : expense,
        replacePoi: isPoi && selected ? selected : undefined,
        transportMode: mode,
      });
    } finally { setSaving(false); }
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onCancel}
    >
      <div
        style={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 14, padding: 20, width: '100%', maxWidth: 440, maxHeight: '85vh', overflow: 'auto', color: '#eee' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <strong style={{ fontSize: 16, color: '#ffd166' }}>修改{item.poi?.name || item.note || '节点'}</strong>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', color: '#888', fontSize: 20, cursor: 'pointer' }}>×</button>
        </div>

        {isPoi && (
          <>
            <label style={{ fontSize: 12, color: '#999', display: 'block', marginBottom: 4 }}>游览时长(分钟)</label>
            <input type="number" value={visitMin} onChange={(e) => setVisitMin(e.target.value)} style={{ ...input, marginBottom: 10 }} placeholder="如 90" />
            <label style={{ fontSize: 12, color: '#999', display: 'block', marginBottom: 4 }}>门票(人数 / 老人优惠)</label>
            <TicketFields value={ticketFields} onChange={setTicketFields} />
            <div style={{ marginBottom: 10 }} />

            <label style={{ fontSize: 12, color: '#999', display: 'block', marginBottom: 4 }}>
              {isFirstStop ? '从上一天末站到这里的交通方式' : '到达这里的交通方式'}
            </label>
            <div style={{ display: 'flex', gap: 5, marginBottom: 6, flexWrap: 'wrap' }}>
              {MODE_OPTIONS.map((m) => (
                <button
                  key={m.value}
                  onClick={() => setMode(m.value)}
                  style={{
                    flex: '1 0 60px', padding: '6px 4px', fontSize: 12, cursor: 'pointer',
                    border: 'none', borderRadius: 6,
                    background: mode === m.value ? '#1677ff' : 'rgba(255,255,255,0.08)',
                    color: mode === m.value ? '#fff' : '#aaa',
                  }}
                >
                  {m.icon} {m.label}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 11, color: '#6b7a8f', marginBottom: 10, lineHeight: 1.5 }}>
              卡片上显示的距离/时长按此方式计算。3 公里内默认按步行展示(同城短途开车不合理)。
            </div>
          </>
        )}

        {!isPoi && (
          <>
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
          </>
        )}

        <label style={{ fontSize: 12, color: '#999', display: 'block', marginBottom: 4 }}>名称/备注</label>
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} style={{ ...input, marginBottom: 10 }} />

        {isPoi && (
          <>
            <label style={{ fontSize: 12, color: '#999', display: 'block', marginBottom: 4 }}>更换景点</label>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <input type="text" placeholder="搜索景点名" value={kw} onChange={(e) => setKw(e.target.value)} style={{ ...input, flex: 1 }} />
              <input type="text" placeholder="城市(选填)" value={city} onChange={(e) => setCity(e.target.value)} style={{ ...input, width: 110 }} />
              <button onClick={doSearch} disabled={searching} style={{ ...btnGhost, ...btn, padding: '8px 12px', flexShrink: 0 }}>{searching ? '…' : '搜索'}</button>
            </div>
            {selected && <div style={{ fontSize: 12, color: C.success, marginBottom: 6 }}>已选: {selected.name}</div>}
            {results.length > 0 && (
              <div style={{ maxHeight: 160, overflow: 'auto', marginBottom: 6 }}>
                {results.map((r) => (
                  <div key={r.id} onClick={() => { setSelected(r); setResults([]); }} style={{ padding: '6px 8px', borderBottom: '1px solid rgba(255,255,255,0.06)', cursor: 'pointer', fontSize: 13, color: selected?.id === r.id ? C.success : '#ddd', borderRadius: 6 }}>
                    {r.name}<span style={{ color: '#888', fontSize: 11 }}> · {r.address}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button onClick={confirm} disabled={saving} style={{ ...btn(C.primary), flex: 1 }}>{saving ? '保存中…' : '保存'}</button>
          <button onClick={onCancel} style={{ ...btnGhost, ...btn }}>取消</button>
        </div>
      </div>
    </div>
  );
}
