// 冲突预警引擎(§5.3 规则表落地)
import type { Conflict, ItineraryItem, Poi, PoiAiCard } from '../types';
import { toMinutes } from './time';

export interface ConflictInput {
  /** 时间轴已排好的节点(按 orderSeq 升序) */
  items: Array<ItineraryItem & { poi?: Poi; card?: PoiAiCard }>;
  /** 已花费总金额 */
  spent: number;
  /** 总预算(未设置为不预警) */
  budget?: number;
  /** 当前日期 yyyy-mm-dd,用于闭馆判断 */
  dayDate?: string;
}

const BUFFER_MIN = 15; // 通勤过紧容忍缓冲

function getDayOfWeek(dateStr: string): string {
  const d = new Date(dateStr);
  const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return days[d.getDay()];
}

export function detectConflicts(input: ConflictInput): Conflict[] {
  const { items, spent, budget, dayDate } = input;
  const conflicts: Conflict[] = [];

  // 1) 时间重叠:前节点 leave > 后节点 arrive
  for (let i = 0; i < items.length - 1; i++) {
    const a = items[i];
    const b = items[i + 1];
    if (a.leaveTime && b.arriveTime && toMinutes(b.arriveTime) < toMinutes(a.leaveTime)) {
      conflicts.push({
        type: 'overlap',
        level: 'yellow',
        message: `时间重叠:${a.poi?.name ?? '节点'}离开(${a.leaveTime})晚于${b.poi?.name ?? '节点'}到达(${b.arriveTime})`,
        itemIds: [a.id, b.id],
      });
    }
  }

  // 2) 闭馆冲突:当日是 POI 闭馆日
  if (dayDate) {
    const todayName = getDayOfWeek(dayDate);
    for (const it of items) {
      if (it.poi?.closedDays?.length && it.poi.closedDays.includes(todayName)) {
        conflicts.push({
          type: 'closed',
          level: 'yellow',
          message: `${it.poi.name} 今日闭馆(${it.poi.closedDays.join('、')}),建议调整或更换`,
          itemIds: [it.id],
        });
      }
    }
  }

  // 3) 通勤过紧:通勤时间超出相邻留白+缓冲
  //    留白 = prev.leave 到 next.arrive 的空档(若 next.arrive 由通勤推导,则天然等于通勤时长,此时不触发)
  //    仅当用户手动覆盖过时间导致空档不足时预警,此处保守检查:
  for (let i = 0; i < items.length - 1; i++) {
    const a = items[i];
    const b = items[i + 1];
    if (a.leaveTime && b.arriveTime) {
      const gap = toMinutes(b.arriveTime) - toMinutes(a.leaveTime);
      if (gap >= 0 && gap < BUFFER_MIN) {
        conflicts.push({
          type: 'tight_transit',
          level: 'yellow',
          message: `从「${a.poi?.name ?? '节点'}」到「${b.poi?.name ?? '节点'}」仅余 ${gap} 分钟,建议预留更多通勤`,
          itemIds: [a.id, b.id],
        });
      }
    }
  }

  // 4) 预算超额
  if (budget && spent > budget) {
    conflicts.push({
      type: 'over_budget',
      level: 'red',
      message: `已超预算 ¥${(spent - budget).toFixed(2)}`,
    });
  }

  // 5) 游览超建议:手动耗时 > suggest_duration × 1.5(无 AI 卡片时不判定)
  for (const it of items) {
    if (it.card && it.visitMinutes != null && it.visitMinutes > it.card.suggestDuration * 1.5) {
      conflicts.push({
        type: 'over_suggest',
        level: 'grey',
        message: `${it.poi?.name ?? '节点'}游览时长 ${it.visitMinutes} 分钟,超过建议时长(${it.card.suggestDuration} 分钟)的 1.5 倍`,
        itemIds: [it.id],
      });
    }
  }

  return conflicts;
}
