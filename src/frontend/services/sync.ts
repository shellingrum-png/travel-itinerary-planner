/**
 * 数据同步/备份层(V6.2)
 * 核心:把整个旅程的数据序列化成 JSON 快照,存到后端(将来可换 Supabase)。
 * 设计:存储后端可插拔 —— 现在用自建后端(JSON文件),后续换 Supabase 只改 STORAGE 实现,业务逻辑不变。
 */
import { db } from './db';
import type { Trip, ItineraryDay, ItineraryItem, Poi, PoiAiCard, Expense, Hotel, Transport } from '../types';

/** 单个旅程的完整数据快照 */
export interface TripSnapshot {
  trip: Trip;
  days: ItineraryDay[];
  items: ItineraryItem[];
  pois: Poi[];
  aiCards: PoiAiCard[];
  hotels: Hotel[];
  transports: Transport[];
  expenses: Expense[];
  savedAt: string;
}

/** 快照接口(可插拔:自建后端 / Supabase / 文件) */
export interface SnapshotStorage {
  save(tripId: string, snap: TripSnapshot): Promise<void>;
  load(tripId: string): Promise<TripSnapshot | null>;
  remove(tripId: string): Promise<void>;
  list(): Promise<string[]>; // 已快照的 tripId 列表
}

// ── 存储后端:自建 server(默认) ──
const BACKEND_BASE = import.meta.env.VITE_SYNC_API || 'http://localhost:8766';

class BackendSnapshotStorage implements SnapshotStorage {
  async save(tripId: string, snap: TripSnapshot): Promise<void> {
    await fetch(`${BACKEND_BASE}/api/snapshot/${tripId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snap),
    });
  }
  async load(tripId: string): Promise<TripSnapshot | null> {
    const res = await fetch(`${BACKEND_BASE}/api/snapshot/${tripId}`);
    if (!res.ok) return null;
    return res.json();
  }
  async remove(tripId: string): Promise<void> {
    await fetch(`${BACKEND_BASE}/api/snapshot/${tripId}`, { method: 'DELETE' });
  }
  async list(): Promise<string[]> {
    const res = await fetch(`${BACKEND_BASE}/api/snapshot`);
    return res.json();
  }
}

const STORAGE: SnapshotStorage = new BackendSnapshotStorage();

// ── 收集某旅程全部数据 ──
async function collectTripData(tripId: string): Promise<TripSnapshot | null> {
  const trip = await db.getTrip(tripId);
  if (!trip) return null;
  const days = await db.listDays(tripId);
  const dayIds = days.map((d) => d.id);
  const items: ItineraryItem[] = [];
  const pois: Poi[] = [];
  const aiCards: PoiAiCard[] = [];
  for (const dayId of dayIds) {
    const its = await db.listItems(dayId);
    items.push(...its);
    for (const it of its) {
      if (it.poiId) {
        const poi = await db.getPoi(it.poiId);
        if (poi) {
          pois.push(poi);
          const card = await db.getPoiCard(poi.id);
          if (card) aiCards.push(card);
        }
      }
    }
  }
  const hotels = await db.listHotels(tripId);
  const transports = await db.listTransports(tripId);
  const expenses = await db.listExpenses(tripId);
  return {
    trip, days, items, pois, aiCards, hotels, transports, expenses,
    savedAt: new Date().toISOString(),
  };
}

/** 备份某旅程到后端 */
export async function backupTrip(tripId: string): Promise<boolean> {
  try {
    const snap = await collectTripData(tripId);
    if (!snap) return false;
    await STORAGE.save(tripId, snap);
    return true;
  } catch (e) {
    console.warn('[sync] 备份失败:', e);
    return false;
  }
}

/** 从后端恢复某旅程到本地 IndexedDB */
export async function restoreTrip(tripId: string): Promise<boolean> {
  try {
    const snap = await STORAGE.load(tripId);
    if (!snap) return false;
    // 清掉本地该旅程旧数据,再写回
    const exist = await db.getTrip(tripId);
    if (exist) await db.deleteTrip(tripId);
    // 重建
    await db.createTrip({
      title: snap.trip.title, destination: snap.trip.destination,
      startDate: snap.trip.startDate, endDate: snap.trip.endDate,
      companionCount: snap.trip.companionCount, currency: snap.trip.currency,
      totalBudget: snap.trip.totalBudget, cityNodes: snap.trip.cityNodes,
    });
    // 写回 days(注意 createTrip 已生成同样多的天,需按 daySeq 对齐)
    const newDays = await db.listDays(tripId);
    for (const day of snap.days) {
      const target = newDays.find((d) => d.daySeq === day.daySeq);
      if (target) await db.updateDay(target.id, { note: day.note, startTime: day.startTime, endTime: day.endTime });
    }
    // 写回 POI / items / hotels / transports / expenses
    for (const poi of snap.pois) await db.upsertPoi(poi);
    for (const item of snap.items) {
      const day = newDays.find((d) => d.daySeq === snap.days.find((x) => x.id === item.dayId)?.daySeq);
      if (day) await db.addItem({ dayId: day.id, poiId: item.poiId, itemType: item.itemType, transportMode: item.transportMode, note: item.note, visitMinutes: item.visitMinutes });
    }
    for (const h of snap.hotels) await db.addHotel({ tripId, name: h.name, address: h.address, lng: h.lng, lat: h.lat, checkIn: h.checkIn, checkOut: h.checkOut, checkInTime: h.checkInTime, checkOutTime: h.checkOutTime, poiId: h.poiId });
    for (const t of snap.transports) await db.addTransport({ tripId, segType: t.segType, mode: t.mode, fromPlace: t.fromPlace, toPlace: t.toPlace, departAt: t.departAt, arriveAt: t.arriveAt, flightNo: t.flightNo, trainNo: t.trainNo });
    for (const e of snap.expenses) await db.addExpense({ tripId, category: e.category, amount: e.amount, currency: e.currency, paidBy: e.paidBy, date: e.date, note: e.note, refType: e.refType, refId: e.refId, dayId: e.dayId });
    // 写回 AI 卡片
    for (const c of snap.aiCards) await db.upsertPoiCard(c);
    return true;
  } catch (e) {
    console.warn('[sync] 恢复失败:', e);
    return false;
  }
}

/** 列出所有已备份的旅程 */
export async function listBackedUpTrips(): Promise<string[]> {
  try { return await STORAGE.list(); } catch { return []; }
}

/** 删除某旅程的后端快照 */
export async function removeBackup(tripId: string): Promise<void> {
  try { await STORAGE.remove(tripId); } catch { /* ignore */ }
}