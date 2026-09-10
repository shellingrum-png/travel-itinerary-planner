// 行程卡片「修改」弹窗的核心纯逻辑:构建设项补丁 + 门票记账动作(可单测)
import type { ItineraryItem, Expense, Trip, Poi, TransportMode } from '../types';
import type { PoiSearchResult } from '../services/amap';

/**
 * 构建设项更新补丁。
 * - 更换景点(replacePoi) → itemPatch = { poiId, note: 新名 }(note 覆盖手输,保证显示名=新景点),并返回需 upsert 的 poi 供坐标加载
 * - 无更换 → 只含传入的 note/visitMinutes,过滤 undefined
 * - transportMode(到达本站的交通方式)两分支都保留
 */
export function buildItemPatch(
  item: ItineraryItem,
  args: { note?: string; visitMinutes?: number; replacePoi?: PoiSearchResult; transportMode?: TransportMode },
): { itemPatch: Partial<ItineraryItem>; upsertPoi?: Poi } {
  // 用户在此弹窗里选定交通方式 → 打上标记,之后计算时完全尊重、不做距离改判
  const modePatch = args.transportMode !== undefined
    ? { transportMode: args.transportMode, transportModeSet: true }
    : {};

  if (args.replacePoi) {
    return {
      itemPatch: {
        poiId: args.replacePoi.id,
        note: args.replacePoi.name,
        ...modePatch,
      },
      upsertPoi: {
        id: args.replacePoi.id,
        name: args.replacePoi.name,
        lng: args.replacePoi.lng,
        lat: args.replacePoi.lat,
        category: 'poi',
        address: args.replacePoi.address,
        mapPoiId: args.replacePoi.id,
      },
    };
  }
  const itemPatch: Partial<ItineraryItem> = {};
  if (args.note !== undefined) itemPatch.note = args.note;
  if (args.visitMinutes !== undefined) itemPatch.visitMinutes = args.visitMinutes;
  Object.assign(itemPatch, modePatch);
  return { itemPatch };
}

/**
 * 门票记账动作:找 item 关联的 ticket 记账,命中→改价,未命中→新增。
 * amount 非法(<=0)→ 返回 none(调用方不处理)。
 */
export function ticketAction(
  expenses: Expense[],
  item: ItineraryItem,
  amount: number,
  trip: Trip,
  date?: string,
): { kind: 'update'; id: string; amount: number } | { kind: 'add'; exp: Omit<Expense, 'id' | 'dirty'> } | { kind: 'none' } {
  if (isNaN(amount) || amount <= 0) return { kind: 'none' };
  const linked = expenses.find((e) => e.refType === 'itinerary_item' && e.refId === item.id && e.category === 'ticket');
  if (linked) return { kind: 'update', id: linked.id, amount };
  return {
    kind: 'add',
    exp: {
      tripId: trip.id,
      category: 'ticket',
      amount,
      currency: trip.currency ?? 'CNY',
      date,
      note: `门票 · ${item.note || ''}`,
      refType: 'itinerary_item',
      refId: item.id,
      dayId: item.dayId,
    },
  };
}
