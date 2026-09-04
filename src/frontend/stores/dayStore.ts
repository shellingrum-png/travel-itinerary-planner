import { create } from 'zustand';
import { db } from '../services/db';
import type { ItineraryItem, Conflict } from '../types';
import { detectConflicts } from '../utils/conflicts';
import type { ConflictInput } from '../utils/conflicts';
import { addMinutes } from '../utils/time';

interface DayState {
  dayId: string | null;
  dayDate: string | null;
  items: ItineraryItem[];
  conflicts: Conflict[];
  isDirty: boolean;
  canUndo: boolean;
  _snapshot: ItineraryItem[] | null;

  loadDay: (dayId: string) => Promise<void>;
  addItem: (item: Omit<ItineraryItem, 'id' | 'orderSeq'>) => Promise<void>;
  updateItem: (id: string, patch: Partial<ItineraryItem>) => Promise<void>;
  removeItem: (id: string) => Promise<void>;
  reorder: (dayId: string, itemId: string, newOrder: number) => Promise<void>;
  setTransportMode: (itemId: string, mode: ItineraryItem['transportMode']) => Promise<void>;
  setVisitMinutes: (itemId: string, minutes: number) => Promise<void>;
  recalcTimeline: () => Promise<void>;

  optimize: () => string; // 返回节省提示文本
  confirmOptimize: () => Promise<void>;
  undo: () => void;
  clearDay: () => void;
}

export const useDayStore = create<DayState>((set, get) => ({
  dayId: null,
  dayDate: null,
  items: [],
  conflicts: [],
  isDirty: false,
  canUndo: false,
  _snapshot: null,

  loadDay: async (dayId) => {
    let items = await db.listItems(dayId);
    // 孤儿节点清理:poi_id 空且 type=poi → 自动删除
    const orphans = items.filter((it) => it.itemType === 'poi' && !it.poiId);
    if (orphans.length > 0) {
      for (const o of orphans) {
        await db.removeItem(o.id);
      }
      items = await db.listItems(dayId);
      // 此处可 toast 提示,简化用 console
      console.warn(`已自动清理 ${orphans.length} 个孤儿节点`);
    }
    const day = await db.getDay(dayId);
    const dayDate = day?.date ?? null;
    set({ dayId, dayDate, items, conflicts: runConflicts(items, dayDate), isDirty: false, canUndo: false, _snapshot: null });
  },

  addItem: async (item) => {
    const created = await db.addItem(item);
    const items = await db.listItems(item.dayId);
    const { dayDate } = get();
    set({ items, conflicts: runConflicts(items, dayDate), isDirty: true });
  },

  updateItem: async (id, patch) => {
    await db.updateItem(id, patch);
    const { dayId, dayDate } = get();
    if (!dayId) return;
    const items = await db.listItems(dayId);
    set({ items, conflicts: runConflicts(items, dayDate), isDirty: true });
  },

  removeItem: async (id) => {
    await db.removeItem(id);
    const { dayId, dayDate } = get();
    if (!dayId) return;
    const items = await db.listItems(dayId);
    set({ items, conflicts: runConflicts(items, dayDate), isDirty: true });
  },

  reorder: async (dayId, itemId, newOrder) => {
    await db.moveItem(dayId, itemId, newOrder);
    const items = await db.listItems(dayId);
    const { dayDate } = get();
    set({ items, conflicts: runConflicts(items, dayDate), isDirty: true });
  },

  setTransportMode: async (itemId, mode) => {
    await db.updateItem(itemId, { transportMode: mode });
    const { dayId, dayDate } = get();
    if (!dayId) return;
    const items = await db.listItems(dayId);
    set({ items, conflicts: runConflicts(items, dayDate), isDirty: true });
  },

  setVisitMinutes: async (itemId, minutes) => {
    await db.updateItem(itemId, { visitMinutes: minutes });
    const { dayId } = get();
    if (!dayId) return;
    // 修改游览时间后级联刷新后续节点
    await get().recalcTimeline();
  },

  recalcTimeline: async () => {
    const { dayId, items } = get();
    if (!dayId || items.length === 0) return;
    const sorted = [...items].sort((a, b) => a.orderSeq - b.orderSeq);

    // 从第一个节点的 arriveTime 开始级联
    let currentArrive = sorted[0].arriveTime ?? '09:00';

    for (let i = 0; i < sorted.length; i++) {
      const it = sorted[i];
      const arrive = currentArrive;
      const visit = it.visitMinutes ?? 90;
      const leave = addMinutes(arrive, visit);

      // 更新当前节点(如果发生变化)
      if (it.arriveTime !== arrive || it.leaveTime !== leave) {
        await db.updateItem(it.id, { arriveTime: arrive, leaveTime: leave });
      }

      // 计算到下一个节点的通勤时间
      const next = sorted[i + 1];
      if (!next) break;

      let commuteMin = 15; // 默认
      if (it.poiId && next.poiId) {
        const { getDuration } = await import('../services/amap');
        const fromPoi = await db.getPoi(it.poiId);
        const toPoi = await db.getPoi(next.poiId);
        if (fromPoi && toPoi && fromPoi.lng !== 0 && fromPoi.lat !== 0 && toPoi.lng !== 0 && toPoi.lat !== 0) {
          try {
            const route = await getDuration([fromPoi.lng, fromPoi.lat], [toPoi.lng, toPoi.lat], next.transportMode);
            commuteMin = route.durationMin;
          } catch {
            // 保持默认
          }
        }
      }

      currentArrive = addMinutes(leave, commuteMin);
    }

    // 重新加载 items 并刷新冲突
    const refreshed = await db.listItems(dayId);
    const { dayDate } = get();
    set({ items: refreshed, conflicts: runConflicts(refreshed, dayDate), isDirty: true });
  },

  // 单层快照:保存当前序,返回节省提示
  optimize: () => {
    const { items } = get();
    set({ _snapshot: [...items], canUndo: true });
    return '优化已就绪,确认后应用新顺序';
  },

  confirmOptimize: async () => {
    const { _snapshot } = get();
    set({ _snapshot: null, canUndo: false });
  },

  undo: () => {
    const { _snapshot, dayDate } = get();
    if (!_snapshot) return;
    set({ items: _snapshot, _snapshot: null, canUndo: false, conflicts: runConflicts(_snapshot, dayDate) });
  },

  clearDay: () => {
    set({ dayId: null, dayDate: null, items: [], conflicts: [], isDirty: false, canUndo: false, _snapshot: null });
  },
}));

function runConflicts(items: ItineraryItem[], dayDate?: string | null): Conflict[] {
  const input: ConflictInput = { items, spent: 0, dayDate: dayDate ?? undefined };
  return detectConflicts(input);
}