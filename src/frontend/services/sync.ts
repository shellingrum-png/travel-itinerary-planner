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

/** 单个旅程同步失败的原因(用于界面提示,避免只报"某个旅程失败"却不说是哪个) */
export interface ReconcileFailure {
  tripId: string;
  action: 'push' | 'pull';
  message: string;
}
export interface ReconcileResult {
  pushed: number;
  pulled: number;
  failed: number;
  failures: ReconcileFailure[];
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
    const res = await fetch(`${BACKEND_BASE}/snapshot/${tripId}`, { method: 'DELETE', headers: await authHeaders() });
    // 必须检查状态码:否则 500/401 会被当成"删除成功",
    // 导致本地删了、云端还在 → 下次同步复活
    if (!res.ok && res.status !== 404) {
      throw new Error(`云端删除失败 HTTP ${res.status}`);
    }
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

/** 备份某旅程到后端。失败时返回 Error(便于上层显示具体原因),成功返回 null */
export async function backupTrip(tripId: string): Promise<Error | null> {
  try {
    const snap = await collectTripData(tripId);
    if (!snap) return new Error('本地读不到旅程数据');
    await STORAGE.save(tripId, snap);
    // 备份成功后对齐本地时间戳（见 adoptSyncedAt 注释）：
    // 否则云端时间必然更"新"，下次 reconcile 会用云端覆盖刚改的内容。
    await db.adoptSyncedAt(tripId, snap.savedAt);
    return null;
  } catch (e: any) {
    console.warn('[sync] 备份失败:', tripId, e);
    return e instanceof Error ? e : new Error(String(e));
  }
}

/** 从后端恢复某旅程到本地 IndexedDB。失败返回 Error,成功返回 null */
export async function restoreTrip(tripId: string): Promise<Error | null> {
  try {
    const snap = await STORAGE.load(tripId);
    if (!snap) return new Error('云端无此旅程快照');
    // 清掉本地该旅程旧数据,再写回
    const exist = await db.getTrip(tripId);
    if (exist) await db.deleteTrip(tripId);
    // 重建:所有实体都【沿用快照里的原始 id】。
    // ⚠️ 曾用 addItem/addHotel/... 让它们各自生成新 uuid → 账单的 refId/dayId 全部悬空
    //   (删景点时按 refId 联动删账单会失效 → "行程删了、账单还在";概览当日花费也失准)。
    //   故这里一律传原 id:day/item/hotel/transport/expense 及账单单据本身。
    await db.createTrip({
      title: snap.trip.title, destination: snap.trip.destination,
      startDate: snap.trip.startDate, endDate: snap.trip.endDate,
      companionCount: snap.trip.companionCount, currency: snap.trip.currency,
      totalBudget: snap.trip.totalBudget, cityNodes: snap.trip.cityNodes,
      members: snap.trip.members,
    }, tripId, snap.days);
    // 只恢复状态(updatedAt 不在这里写 —— 恢复流程里的写操作会 touchTrip 顶成 now(),
    // 故统一在收尾用 setSyncedAt 对齐,见函数末尾)
    await db.updateTrip(tripId, { status: snap.trip.status });

    // 天数已由 createTrip 按原 id 写入;补上 note/时间等字段
    const alignedDays = await db.listDays(tripId);
    for (const day of snap.days) {
      const target = alignedDays.find((d) => d.id === day.id);
      if (target) await db.updateDay(target.id, { note: day.note, startTime: day.startTime, endTime: day.endTime });
    }
    // 写回 POI / items / hotels / transports / expenses(均保留原 id,保住账单引用)
    for (const poi of snap.pois) await db.upsertPoi(poi);
    for (const item of snap.items) {
      await db.addItem({
        dayId: item.dayId, poiId: item.poiId, itemType: item.itemType,
        transportMode: item.transportMode, note: item.note, visitMinutes: item.visitMinutes,
        orderSeq: item.orderSeq,
      }, item.id);
    }
    for (const h of snap.hotels) await db.addHotel({
      tripId, name: h.name, address: h.address, lng: h.lng, lat: h.lat,
      checkIn: h.checkIn, checkOut: h.checkOut, checkInTime: h.checkInTime, checkOutTime: h.checkOutTime, poiId: h.poiId,
    }, h.id);
    for (const t of snap.transports) await db.addTransport({
      tripId, segType: t.segType, mode: t.mode, fromPlace: t.fromPlace, toPlace: t.toPlace,
      departAt: t.departAt, arriveAt: t.arriveAt, flightNo: t.flightNo, trainNo: t.trainNo,
    }, t.id);
    for (const e of snap.expenses) await db.addExpense({
      tripId, category: e.category, amount: e.amount, currency: e.currency, paidBy: e.paidBy,
      date: e.date, note: e.note, refType: e.refType, refId: e.refId, dayId: e.dayId,
      splitMode: e.splitMode, parts: e.parts, participantIds: e.participantIds,
      ticketCount: e.ticketCount, unitPrice: e.unitPrice, seniorCount: e.seniorCount, seniorPrice: e.seniorPrice,
    }, e.id);
    // 写回 AI 卡片
    for (const c of snap.aiCards) await db.upsertPoiCard(c);
    // ⚠️ 收尾对齐:上面的每一次写入都会 touchTrip() 把 updatedAt 顶成 now(),
    // 若不抹平,localTs 恒大于云端 updated_at(= savedAt)→ 下次 reconcile 判定
    // 「本地更新」→ 把刚恢复的内容又推回云端,列表「更新于」被刷成打开页面的时刻。
    // 对齐到 savedAt 后两边相等,reconcile 判定一致即跳过,不再空转上传。
    await db.setSyncedAt(tripId, snap.savedAt);
    return null;
  } catch (e: any) {
    console.warn('[sync] 恢复失败:', tripId, e);
    return e instanceof Error ? e : new Error(String(e));
  }
}

/**
 * 应用启动时对本地所有旅程做一次账单引用自愈,并把修复结果推回云端。
 *
 * 为什么要单独跑、不放进 restoreTrip:restoreTrip 收尾会用 setSyncedAt 把
 * updatedAt 收敛回快照值(防同步回环),在那期间做的修复不会被视为"本地更新"、
 * 也就不会回传云端。故在 reconcile 之后单独执行:修复 → backupTrip 推回。
 * 幂等:引用已正常的旅程直接跳过,不产生多余上传。
 * @returns 修复并已回传的旅程数
 */
export async function healAllLocalTrips(): Promise<number> {
  let pushed = 0;
  try {
    const trips = await db.listTrips();
    for (const t of trips) {
      const fixed = await healExpenseRefs(t.id);
      if (fixed > 0) {
        const err = await backupTrip(t.id);
        if (!err) pushed++;
      }
    }
  } catch (e) {
    console.warn('[sync] 全量自愈失败:', e);
  }
  return pushed;
}

/** 列出所有已备份的旅程 */
export async function listBackedUpTrips(): Promise<CloudTripRef[]> {
  try { return await STORAGE.list(); } catch { return []; }
}

/**
 * 自愈:修复账单的悬空引用(历史 bug 导致——每次 restoreTrip 都重建实体 id,
 * 而账单里的 refId/dayId 仍指向旧 id)。
 *
 * **只重连能唯一确定的**,歧义/孤儿一律不碰:
 *  - 按账单 note 里的实体名(如「住宿 · 格林电竞酒店(…)」)在当前实体里找,
 *    同名命中恰好 1 个才重连;多个同名用日期(dayId 对应日期 == 账单 date)进一步定唯一。
 *  - 同名 0 个(行程已删)→ 判定为孤儿,**保持不动**(是否清理由用户决定)。
 * 不新增/删除任何账单,不改金额,只更新 refId/dayId —— 幂等,可反复调用。
 * @returns 修复条数
 */
export async function healExpenseRefs(tripId: string): Promise<number> {
  try {
    const [expenses, days, hotels, transports] = await Promise.all([
      db.listExpenses(tripId), db.listDays(tripId), db.listHotels(tripId), db.listTransports(tripId),
    ]);
    // 收集所有带坐标的 point item(景点 + 作为 item 的酒店)及其 poi 名
    const items: ItineraryItem[] = [];
    for (const d of days) items.push(...(await db.listItems(d.id)));
    const itemName = new Map<string, string>();
    for (const it of items) {
      const poi = it.poiId ? await db.getPoi(it.poiId) : null;
      const nm = poi?.name || it.note || '';
      if (nm) itemName.set(it.id, nm);
    }
    const dayDate = new Map(days.map((d) => [d.id, d.date]));
    const validItem = new Set(items.map((i) => i.id));
    const validHotel = new Set(hotels.map((h) => h.id));
    const validTran = new Set(transports.map((t) => t.id));

    const baseName = (note?: string) => String(note || '').replace(/^[^·]*·\s*/, '').trim();
    let fixed = 0;
    for (const e of expenses) {
      const refOk = e.refType === 'transport'
        ? (e.refId ? validTran.has(e.refId) : true)
        : (e.refId ? validItem.has(e.refId) : true);
      const dayOk = !e.dayId || dayDate.has(e.dayId);
      if (refOk && dayOk) continue; // 引用完好,跳过

      const base = baseName(e.note);
      if (!base) continue;
      // 候选实体:景点/酒店 item 按名匹配;大交通按 起→止 匹配
      let cands: Array<{ id: string; dayId?: string }> = [];
      if (e.category === 'transport' || e.refType === 'transport') {
        cands = transports
          .filter((t) => `${t.fromPlace}→${t.toPlace}` === base || `${t.fromPlace}-${t.toPlace}` === base)
          .map((t) => ({ id: t.id }));
      } else {
        cands = items.filter((it) => itemName.get(it.id) === base).map((it) => ({ id: it.id, dayId: it.dayId }));
      }
      if (cands.length !== 1) {
        // 多个同名 → 用日期定唯一
        const sameDate = cands.filter((c) => c.dayId && dayDate.get(c.dayId) === e.date);
        if (sameDate.length === 1) cands = sameDate;
        else continue; // 歧义(0 或 >1)一律不动
      }
      const patch: Partial<Expense> = {};
      if (e.category === 'transport' || e.refType === 'transport') {
        if (e.refType !== 'transport') patch.refType = 'transport';
        if (!validTran.has(e.refId ?? '')) patch.refId = cands[0].id;
      } else {
        if (e.refType !== 'itinerary_item') patch.refType = 'itinerary_item';
        if (!validItem.has(e.refId ?? '')) patch.refId = cands[0].id;
      }
      if ((!e.dayId || !dayDate.has(e.dayId)) && cands[0].dayId) patch.dayId = cands[0].dayId;
      if (Object.keys(patch).length) {
        await db.updateExpense(e.id, patch);
        fixed++;
      }
    }
    if (fixed) console.log(`[sync] 自愈账单引用: ${tripId.slice(0, 8)} 修复 ${fixed} 条`);
    return fixed;
  } catch (e) {
    console.warn('[sync] 自愈账单引用失败:', e);
    return 0;
  }
}

/**
 * V9.0:自动双向 reconcile(打开应用时调用)。
 * 规则(last-write-wins per trip,快照级):
 *  - 云端有、本地无 → 拉取恢复(换设备场景)
 *  - 本地有、云端无 → 推送备份(首次/新旅程)
 *  - 都有 → 比 updatedAt,新的覆盖旧的
 * 返回 { pushed, pulled } 用于 UI 提示。
 *
 * ⚠️ 并发保护:App 启动与 TripList 挂载都会调 reconcile,若无保护会并发跑两次。
 * 二者交错时,一次 restoreTrip 会写入"当前时间"的 updatedAt,另一次会判定
 * "本地比云端新"而把「尚未恢复完的空壳」备份回云端 → 覆盖真实数据(2026-09-11 事故)。
 * 这里用 in-flight Promise 去重:同一时刻只允许一次 reconcile,后来者复用同一结果。
 */
let reconcileInFlight: Promise<ReconcileResult> | null = null;

export function reconcile(): Promise<ReconcileResult> {
  if (reconcileInFlight) return reconcileInFlight;
  reconcileInFlight = runReconcileWithRetry().finally(() => { reconcileInFlight = null; });
  return reconcileInFlight;
}

/**
 * 包一层重试:库若被并发切换流程关掉(DatabaseClosedError),
 * 重开一次再跑,避免整批同步失败(见 dexie.ts setActiveDb 竞态注释)。
 */
async function runReconcileWithRetry(): Promise<ReconcileResult> {
  try {
    return await runReconcile();
  } catch (e: any) {
    if (e?.name === 'DatabaseClosedError' || /has been closed/i.test(e?.message || '')) {
      try {
        const { getActiveDb } = await import('./db');
        const d: any = getActiveDb();
        if (d && !d.isOpen()) await d.open();
        console.warn('[sync] 数据库被关闭,已重开并重试一次');
      } catch { /* 重开失败则走兜底结果 */ }
      try { return await runReconcile(); } catch { /* fall through */ }
    }
    throw e;
  }
}

async function runReconcile(): Promise<ReconcileResult> {
  let pushed = 0;
  let pulled = 0;
  const failures: ReconcileFailure[] = [];
  const fail = (tripId: string, action: 'push' | 'pull', err: Error) => {
    failures.push({ tripId, action, message: err.message || String(err) });
  };
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
        const err = await backupTrip(id);
        if (!err) pushed++; else fail(id, 'push', err);
      }
    }

    // 处理云端有、本地没有 或 云端更新的
    for (const ref of cloud) {
      const localTrip = localById.get(ref.id);
      if (!localTrip) {
        const err = await restoreTrip(ref.id);
        if (!err) pulled++; else fail(ref.id, 'pull', err);
        continue;
      }
      const localTs = localTrip.updatedAt ? new Date(localTrip.updatedAt).getTime() : 0;
      const cloudTs = ref.updatedAt ? new Date(ref.updatedAt).getTime() : 0;
      if (cloudTs > localTs) {
        const err = await restoreTrip(ref.id);
        if (!err) pulled++; else fail(ref.id, 'pull', err);
      } else if (localTs > cloudTs) {
        const err = await backupTrip(ref.id);
        if (!err) pushed++; else fail(ref.id, 'push', err);
      }
      // 相等或本地无 updatedAt 且云端也无 → 视为一致,跳过
    }
  } catch (e: any) {
    // 库被并发切换流程关掉 → 向上抛,交给 runReconcileWithRetry 重开重试
    if (isDbClosedError(e)) throw e;
    console.warn('[sync] reconcile 失败:', e);
    failures.push({ tripId: '', action: 'push', message: e?.message || String(e) });
  }
  return { pushed, pulled, failed: failures.length, failures };
}

/** 判断是否为「数据库已关闭」错误(Dexie DatabaseClosedError / IndexedDB InvalidStateError) */
function isDbClosedError(e: any): boolean {
  return e?.name === 'DatabaseClosedError' || /has been closed|InvalidStateError/i.test(e?.message || '');
}

/** 删除某旅程的后端快照 */
export async function removeBackup(tripId: string): Promise<void> {
  try { await STORAGE.remove(tripId); } catch { /* ignore */ }
}

/**
 * 删除旅程:先删云端备份,成功后再删本地。
 *
 * 顺序很重要 —— 只删本地的话,下次 reconcile 会发现「云端有、本地无」
 * 而把它重新拉回来(用户表现为"删了又出现")。
 * 云端删除失败时【不删本地】,以免制造这种状态。
 *
 * @returns 云端是否删除成功
 */
export async function removeTripEverywhere(tripId: string): Promise<boolean> {  let cloudOk = true;
  try {
    await STORAGE.remove(tripId);
  } catch (e) {
    console.warn('[sync] 云端删除失败:', e);
    cloudOk = false;
  }
  if (!cloudOk) return false;
  try {
    await db.deleteTrip(tripId);
  } catch (e) {
    console.warn('[sync] 本地删除失败:', e);
    return false;
  }
  return true;
}