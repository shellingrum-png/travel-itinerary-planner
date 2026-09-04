/**
 * Day 边界推导(PRD §2.1 优先级表)
 * 纯函数,平台无关,可单测。
 */
import { toMinutes, addMinutes } from './time';
import type { Transport, Hotel, ItineraryDay, ItineraryItem } from '../types';

export interface BoundaryInput {
  day: ItineraryDay;
  /** 当日酒店(若有) */
  hotel?: Hotel;
  /** 前一日大交通到达(用于 start_time 优先级 3) */
  prevTransportArrive?: Transport;
  /** 当日大交通出发(用于 end_time 优先级 3) */
  todayTransportDepart?: Transport;
  /** 用户手动覆盖的 start_time(优先级 1) */
  manualStart?: string;
  /** 用户手动覆盖的 end_time(优先级 1) */
  manualEnd?: string;
}

export interface BoundaryResult {
  startTime: string;
  endTime: string;
}

const DEFAULT_START = '09:00';
const DEFAULT_END = '20:00';

/**
 * deriveDayBoundary 返回某天的 start_time 和 end_time。
 * 优先级顺序见 PRD §2.1 显式优先级表。
 */
export function deriveDayBoundary(input: BoundaryInput): BoundaryResult {
  const startTime = resolveStart(input);
  const endTime = resolveEnd(input);
  return { startTime, endTime };
}

/**
 * 修改大交通/酒店后,重算受影响 Day 的边界。
 * 若该日已排点,则以现有 items 的第一条 arrive_time 为下限,
 * 若新 start_time 晚于第一条 arrive_time → 标记冲突,不覆盖排点。
 */
export function recomputeDayBoundary(
  input: BoundaryInput,
  existingItems: ItineraryItem[],
): { boundary: BoundaryResult; conflict: boolean } {
  const proposed = deriveDayBoundary(input);
  if (existingItems.length === 0) {
    return { boundary: proposed, conflict: false };
  }

  let conflict = false;
  let startTime = proposed.startTime;
  let endTime = proposed.endTime;

  // 检查 startTime 是否晚于第一条排点的 arriveTime
  const firstArrive = existingItems[0].arriveTime;
  if (firstArrive) {
    const proposedStartMin = toMinutes(proposed.startTime);
    const firstMin = toMinutes(firstArrive);
    if (proposedStartMin > firstMin) {
      startTime = firstArrive;
      conflict = true;
    }
  }

  // 检查 endTime 是否早于最后一条排点的 leaveTime
  const lastItem = existingItems[existingItems.length - 1];
  const lastLeave = lastItem.leaveTime;
  if (lastLeave) {
    const proposedEndMin = toMinutes(proposed.endTime);
    const lastMin = toMinutes(lastLeave);
    if (proposedEndMin < lastMin) {
      endTime = lastLeave;
      conflict = true;
    }
  }

  return { boundary: { startTime, endTime }, conflict };
}

// ── private ──

function resolveStart(input: BoundaryInput): string {
  // 1) 手动覆盖
  if (input.manualStart) return input.manualStart;

  // 2) 当日酒店 check_in
  if (input.hotel?.checkIn) {
    const date = input.day.date;
    if (input.hotel.checkIn === date) {
      const t = input.hotel.checkInTime ?? '14:00';
      return t;
    }
  }

  // 3) 前一日大交通 arrive_at 的次日 09:00
  if (input.prevTransportArrive?.arriveAt) {
    return DEFAULT_START;
  }

  // 4) 默认
  return DEFAULT_START;
}

function resolveEnd(input: BoundaryInput): string {
  // 1) 手动覆盖
  if (input.manualEnd) return input.manualEnd;

  // 2) 当日酒店 check_out
  if (input.hotel?.checkOut) {
    const date = input.day.date;
    if (input.hotel.checkOut === date) {
      const t = input.hotel.checkOutTime ?? '12:00';
      return t;
    }
  }

  // 3) 当日大交通 depart_at
  if (input.todayTransportDepart?.departAt) {
    const d = new Date(input.todayTransportDepart.departAt);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  // 4) 默认
  return DEFAULT_END;
}