/**
 * 数据同步/备份层(V6.2)
 * 核心:把整个旅程的数据序列化成 JSON 快照,存到后端(将来可换 Supabase)。
 * 设计:存储后端可插拔 —— 现在用自建后端(JSON文件),后续换 Supabase 只改 STORAGE 实现,业务逻辑不变。
 */
import { db } from './db';
import { getLegacyTripIds } from './db';
import { getAccessToken } from './auth';
import type { Trip, ItineraryDay, ItineraryItem, Poi, PoiAiCard, Expense, Hotel, Transport } from '../types';

/** 只删本地副本,不动云端(用于清理继承来的脏数据) */
async function removeLocalTrip(tripId: string): Promise<void> {
  try { await db.deleteTrip(tripId); } catch (e) { console.warn('[sync] 清理本地脏数据失败:', tripId, e); }
}

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

/** 云端已快照的旅程条目 */
export interface CloudTripRef {
  id: string;
  updatedAt: string | null;
}

/** 快照接口(可插拔:自建后端 / Supabase / 文件) */
export interface SnapshotStorage {
  save(tripId: string, snap: TripSnapshot): Promise<void>;
  load(tripId: string): Promise<TripSnapshot | null>;
  remove(tripId: string): Promise<void>;
  list(): Promise<CloudTripRef[]>; // 已快照的旅程列表(含云端时间戳)
}

// ── 存储后端:自建 server(默认) ──
// VITE_SYNC_API 是「源站」:未配置→本地 8766;配置为空→同源(生产经 Nginx 反代 /api)
const SYNC_ORIGIN = import.meta.env.VITE_SYNC_API ?? 'http://localhost:8766';
const BACKEND_BASE = `${SYNC_ORIGIN}/api`;

// 带登录 token 的请求头(后端 /api/snapshot 需鉴权)
async function authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

class BackendSnapshotStorage implements SnapshotStorage {
  async save(tripId: string, snap: TripSnapshot): Promise<void> {
    await fetch(`${BACKEND_BASE}/snapshot/${tripId}`, {
      method: 'PUT',
      headers: await authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(snap),
    });
  }
  async load(tripId: string): Promise<TripSnapshot | null> {
    const res = await fetch(`${BACKEND_BASE}/snapshot/${tripId}`, { headers: await authHeaders() });
    if (!res.ok) return null;
    return res.json();
  }
  async remove(tripId: string): Promise<void> {
    await fetch(`${BACKEND_BASE}/snapshot/${tripId}`, { method: 'DELETE', headers: await authHeaders() });
  }
  async list(): Promise<CloudTripRef[]> {
    const res = await fetch(`${BACKEND_BASE}/snapshot`, { headers: await authHeaders() });
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
    // 重建(把原 id 作为第二参数传入,保持本地=云端 id,否则 createTrip 会生成新 uuid → 恢复成"新id空壳"且重复上传)
    await db.createTrip({
      title: snap.trip.title, destination: snap.trip.destination,
      startDate: snap.trip.startDate, endDate: snap.trip.endDate,
      companionCount: snap.trip.companionCount, currency: snap.trip.currency,
      totalBudget: snap.trip.totalBudget, cityNodes: snap.trip.cityNodes,
    }, tripId);
    // 恢复状态与更新时刻(createTrip 默认 planning)
    await db.updateTrip(tripId, { status: snap.trip.status, updatedAt: snap.trip.updatedAt });

    // 写回 days(注意 createTrip 已生成同样多的天,需按 daySeq 对齐)
    const newDays = await db.listDays(tripId);
    // 天数不一致时补齐(createTrip 可能生成的天数比快照少)
    for (const day of snap.days) {
      if (!newDays.some((d) => d.daySeq === day.daySeq)) {
        await db.addDay(tripId, newDays.length ? day.date : snap.trip.startDate);
      }
    }
    const alignedDays = await db.listDays(tripId);
    for (const day of snap.days) {
      const target = alignedDays.find((d) => d.daySeq === day.daySeq);
      if (target) await db.updateDay(target.id, { note: day.note, startTime: day.startTime, endTime: day.endTime });
    }
    // 写回 POI / items / hotels / transports / expenses
    for (const poi of snap.pois) await db.upsertPoi(poi);
    for (const item of snap.items) {
      const day = alignedDays.find((d) => d.daySeq === snap.days.find((x) => x.id === item.dayId)?.daySeq);
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
export async function listBackedUpTrips(): Promise<CloudTripRef[]> {
  try { return await STORAGE.list(); } catch { return []; }
}

/**
 * V9.0:自动双向 reconcile(打开应用时调用)。
 * 规则(last-write-wins per trip,快照级):
 *  - 云端有、本地无 → 拉取恢复(换设备场景)
 *  - 本地有、云端无 → 推送备份(首次/新旅程)
 *  - 都有 → 比 updatedAt,新的覆盖旧的
 * 返回 { pushed, pulled } 用于 UI 提示。
 */
export async function reconcile(): Promise<{ pushed: number; pulled: number; failed: number }> {
  let pushed = 0;
  let pulled = 0;
  let failed = 0;
  try {
    const local = await db.listTrips();
    const localById = new Map(local.map((t) => [t.id, t]));
    const cloud = await STORAGE.list();
    const cloudById = new Map(cloud.map((c) => [c.id, c]));

    const localIds = new Set(localById.keys());
    const cloudIds = new Set(cloudById.keys());

    // 清掉「继承自旧库但云端不属于本账号」的脏数据。
    // 起因:早期 migrateLegacyDb 迁移后没销毁旧库,导致后续每个新账号
    // 登录时都继承了同一批历史旅程;这些旅程云端属于别的账号,不属于当前用户。
    // 特征:本地有、云端无、且 id 在历史遗产清单里 → 从本账号本地库删除。
    const legacyIds = new Set(getLegacyTripIds());
    if (legacyIds.size) {
      for (const id of localIds) {
        if (legacyIds.has(id) && !cloudIds.has(id)) {
          await removeLocalTrip(id);
          localById.delete(id);
          localIds.delete(id);
        }
      }
    }

    // 推送本地有、云端没有的
    for (const id of localIds) {
      if (!cloudIds.has(id)) {
        const ok = await backupTrip(id);
        if (ok) pushed++; else failed++;
      }
    }

    // 处理云端有、本地没有 或 云端更新的
    for (const ref of cloud) {
      const localTrip = localById.get(ref.id);
      if (!localTrip) {
        const ok = await restoreTrip(ref.id);
        if (ok) pulled++; else failed++;
        continue;
      }
      const localTs = localTrip.updatedAt ? new Date(localTrip.updatedAt).getTime() : 0;
      const cloudTs = ref.updatedAt ? new Date(ref.updatedAt).getTime() : 0;
      if (cloudTs > localTs) {
        const ok = await restoreTrip(ref.id);
        if (ok) pulled++; else failed++;
      } else if (localTs > cloudTs) {
        const ok = await backupTrip(ref.id);
        if (ok) pushed++; else failed++;
      }
      // 相等或本地无 updatedAt 且云端也无 → 视为一致,跳过
    }
  } catch (e) {
    console.warn('[sync] reconcile 失败:', e);
    failed++;
  }
  return { pushed, pulled, failed };
}

/** 删除某旅程的后端快照 */
export async function removeBackup(tripId: string): Promise<void> {
  try { await STORAGE.remove(tripId); } catch { /* ignore */ }
}