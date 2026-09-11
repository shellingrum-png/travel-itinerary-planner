/**
 * 「复制到新的行程」的纯逻辑
 *
 * 背景:该功能只复制了景点/酒店,漏了记账与大交通,
 * 导致用户复制出的新行程没有花费数据。这里负责把记账按引用关系
 * 重定向到新旅程的实体上(新 dayId / 新 itemId / 新 hotelId / 新 transportId)。
 */
import type { Expense, Transport } from '../types';

/** 原实体 id → 新实体 id 的映射集合 */
export interface CopyIdMaps {
  /** 原 dayId → 新 dayId(按 daySeq 对应;仅包含保留下来的天) */
  dayIdMap: Map<string, string>;
  /** 日期(yyyy-mm-dd) → 新 dayId(用于没有 dayId 的纯日期记账) */
  dayIdByDate: Map<string, string>;
  /** 原 itemId → 新 itemId */
  itemIdMap: Map<string, string>;
  /** 原 hotelId → 新 hotelId */
  hotelIdMap: Map<string, string>;
  /** 原 transportId → 新 transportId */
  transportIdMap: Map<string, string>;
}

/**
 * 把源旅程的记账转换为可写入新旅程的数据。
 *
 * - dayId:优先按原 dayId 映射;原天已不存在时退回按 date 匹配;都没有则留空
 * - refId:按 refType 选择对应映射表;目标实体未复制时【清空引用】而不是留悬空 id
 *   (历史上悬空引用导致"孤儿记账")
 * - id/dirty 由调用方(db 层)生成
 */
export function remapExpenses(
  expenses: Expense[],
  newTripId: string,
  maps: CopyIdMaps,
): Array<Omit<Expense, 'id' | 'dirty'>> {
  return expenses.map((e) => {
    // 归属天
    let dayId: string | undefined;
    if (e.dayId && maps.dayIdMap.has(e.dayId)) dayId = maps.dayIdMap.get(e.dayId);
    else if (e.date && maps.dayIdByDate.has(e.date)) dayId = maps.dayIdByDate.get(e.date);

    // 关联实体
    let refType = e.refType;
    let refId = e.refId;
    if (refId) {
      const table = refType === 'hotel' ? maps.hotelIdMap
        : refType === 'transport' ? maps.transportIdMap
          : maps.itemIdMap;
      const mapped = table.get(refId);
      if (mapped) {
        refId = mapped;
      } else {
        // 目标实体没有被复制 → 去掉引用,避免悬空
        refType = undefined;
        refId = undefined;
      }
    }

    const out: Omit<Expense, 'id' | 'dirty'> = {
      tripId: newTripId,
      category: e.category,
      amount: e.amount,
      currency: e.currency,
      date: e.date,
      note: e.note,
    };
    if (e.paidBy !== undefined) out.paidBy = e.paidBy;
    if (dayId !== undefined) out.dayId = dayId;
    if (refType !== undefined) out.refType = refType;
    if (refId !== undefined) out.refId = refId;
    return out;
  });
}

/** 复制大交通到新旅程(去掉 id,换 tripId) */
export function remapTransports(
  transports: Transport[],
  newTripId: string,
): Array<Omit<Transport, 'id'>> {
  return transports.map((t) => ({
    tripId: newTripId,
    segType: t.segType,
    mode: t.mode,
    fromPlace: t.fromPlace,
    toPlace: t.toPlace,
    departAt: t.departAt,
    arriveAt: t.arriveAt,
    flightNo: t.flightNo,
    trainNo: t.trainNo,
  }));
}
