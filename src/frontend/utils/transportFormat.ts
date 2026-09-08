// 大交通展示工具:模式图标 / 时间格式化 / 按天归组(纯函数,可单测)
import type { Transport, TransportMode } from '../types';

/** 该模式是否是需要录入起抵时间的大交通(火车/飞机) */
export function isBigTransportMode(mode: TransportMode): boolean {
  return mode === 'train' || mode === 'flight';
}

/** 大交通模式 → 图标 */
export function modeIcon(mode: Transport['mode']): string {
  return ({ flight: '✈️', train: '🚄', drive: '🚗', ferry: '⛴' } as const)[mode] ?? '🚗';
}

/** ISO datetime → MM-DD HH:mm;非法输入原样返回 */
export function fmtDT(iso: string): string {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return iso || '';
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 该天的大交通记录(按 departAt 日期归天,夜间跨天归出发日) */
export function dayTransports(transports: Transport[], date: string): Transport[] {
  return transports.filter((t) => t.departAt?.slice(0, 10) === date);
}
