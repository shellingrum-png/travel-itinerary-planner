import { input, C } from './ui';
import { ticketAmount } from '../utils/ticket';
import type { Expense } from '../types';

export interface TicketFieldsValue {
  count: string;       // 购票人数(张数)
  unitPrice: string;   // 成人/普通票单价
  seniorCount: string; // 老人票张数
  seniorPrice: string; // 老人票单价(0=免费)
}

export const emptyTicketFields = (): TicketFieldsValue => ({ count: '', unitPrice: '', seniorCount: '', seniorPrice: '' });

/** 从已有门票记账回填;旧数据(无 ticketCount)→ 视为 1 张成人票(amount=单价) */
export function ticketFieldsFromExpense(e?: Pick<Expense, 'amount' | 'ticketCount' | 'unitPrice' | 'seniorCount' | 'seniorPrice'> | null): TicketFieldsValue {
  if (!e) return emptyTicketFields();
  if (e.ticketCount == null) {
    return e.amount != null && e.amount > 0
      ? { count: '1', unitPrice: String(e.amount), seniorCount: '', seniorPrice: '' }
      : emptyTicketFields();
  }
  return {
    count: e.ticketCount > 0 ? String(e.ticketCount) : '',
    unitPrice: e.unitPrice != null ? String(e.unitPrice) : '',
    seniorCount: e.seniorCount != null && e.seniorCount > 0 ? String(e.seniorCount) : '',
    seniorPrice: e.seniorPrice != null ? String(e.seniorPrice) : '',
  };
}

export default function TicketFields({ value, onChange }: { value: TicketFieldsValue; onChange: (v: TicketFieldsValue) => void }) {
  const num = (s: string) => (s === '' ? undefined : parseFloat(s));
  const count = num(value.count);
  const unit = num(value.unitPrice);
  const senior = num(value.seniorCount);
  const seniorPrice = num(value.seniorPrice);
  const total = ticketAmount({ count, unitPrice: unit, seniorCount: senior, seniorPrice });
  const hasInput = value.count !== '' || value.unitPrice !== '' || value.seniorCount !== '' || value.seniorPrice !== '';
  const set = (k: keyof TicketFieldsValue) => (v: string) => onChange({ ...value, [k]: v });

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="number" min="0" placeholder="人数" value={value.count} onChange={(e) => set('count')(e.target.value)} style={{ ...input, width: 64 }} title="购票人数(张数)" />
        <span style={{ fontSize: 12, color: '#9a9ab0' }}>人 ×</span>
        <input type="number" min="0" step="0.01" placeholder="单价" value={value.unitPrice} onChange={(e) => set('unitPrice')(e.target.value)} style={{ ...input, width: 70 }} title="成人/普通票单价" />
        <span style={{ fontSize: 12, color: '#9a9ab0' }}>元</span>
        <span style={{ fontSize: 12, color: '#6a6a80' }}>老人</span>
        <input type="number" min="0" placeholder="0" value={value.seniorCount} onChange={(e) => set('seniorCount')(e.target.value)} style={{ ...input, width: 48 }} title="老人票张数(0=无)" />
        <span style={{ fontSize: 12, color: '#9a9ab0' }}>张 ×</span>
        <input type="number" min="0" step="0.01" placeholder="0" value={value.seniorPrice} onChange={(e) => set('seniorPrice')(e.target.value)} style={{ ...input, width: 56 }} title="老人票单价(0=免费)" />
        <span style={{ fontSize: 12, color: '#9a9ab0' }}>元</span>
      </div>
      {hasInput && total > 0 && (
        <div style={{ fontSize: 12, color: C.info, marginTop: 5 }}>
          合计 <strong>¥{total.toFixed(2)}</strong>
          {senior != null && senior > 0 ? <span style={{ color: '#9a9ab0' }}> · 含老人 {senior}×{seniorPrice ?? 0}</span> : null}
        </div>
      )}
      <div style={{ fontSize: 11, color: '#6a6a80', marginTop: 4 }}>留空表示不记门票;老人票单价填 0 表示免费。</div>
    </div>
  );
}
