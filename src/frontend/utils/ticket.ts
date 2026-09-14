// 门票录入/展示纯逻辑(可单测)。
// amount 恒为总额,人数/单价只是录入与展示辅助字段(统计口径不变)。
import type { Expense } from '../types';

export interface TicketInput {
  count?: number;       // 购票总张数(人数)
  unitPrice?: number;   // 成人/普通票单价
  seniorCount?: number; // 老人票张数
  seniorPrice?: number; // 老人票单价(0=免费)
}

/** 自动合计 =(总张数-老人张数)×成人单价 + 老人张数×老人单价;非法输入回退 0 */
export function ticketAmount(t: TicketInput): number {
  const count = t.count != null && t.count > 0 ? t.count : 0;
  const unit = t.unitPrice != null && t.unitPrice > 0 ? t.unitPrice : 0;
  const senior = t.seniorCount != null && t.seniorCount > 0 ? Math.min(t.seniorCount, count) : 0;
  const seniorPrice = t.seniorPrice != null && t.seniorPrice >= 0 ? t.seniorPrice : 0;
  return Math.max(0, count - senior) * unit + senior * seniorPrice;
}

/** 列表摘要,如 "4 人 · 成人3×120 · 老人1×60";旧数据(无 ticketCount)返回 null */
export function ticketSummary(e: Expense): string | null {
  if (e.ticketCount == null || e.ticketCount <= 0) return null;
  const senior = e.seniorCount != null && e.seniorCount > 0 ? e.seniorCount : 0;
  const adult = Math.max(0, e.ticketCount - senior);
  const parts = [`${e.ticketCount} 人`];
  if (e.unitPrice != null && e.unitPrice > 0) parts.push(`成人${adult}×${fmt(e.unitPrice)}`);
  if (senior > 0) parts.push(`老人${senior}${e.seniorPrice != null && e.seniorPrice > 0 ? `×${fmt(e.seniorPrice)}` : ''}`);
  return parts.join(' · ');
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
}
