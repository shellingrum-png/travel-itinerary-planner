/**
 * Dexie(IndexedDB) 实现 Db 接口
 * 表结构对应 docs/DB_SCHEMA.md,外键级联删除由业务层保证。
 */
import Dexie, { type Table } from 'dexie';
import type {
  Trip,
  ItineraryDay,
  ItineraryItem,
  Poi,
  PoiAiCard,
  Expense,
  RouteCache,
  TransportMode,
  Hotel,
  Transport,
  TripTemplate,
} from '../types';
import type { Db } from './db';
import { uuid } from '../utils/uuid';

export class TravelDb extends Dexie implements Db {
  trips!: Table<Trip, string>;
  itineraryDays!: Table<ItineraryDay, string>;
  pois!: Table<Poi, string>;
  poiAiCards!: Table<PoiAiCard, string>;
  itineraryItems!: Table<ItineraryItem, string>;
  transports!: Table<import('../types').Transport, string>;
  hotels!: Table<import('../types').Hotel, string>;
  expenses!: Table<Expense, string>;
  routeCache!: Table<RouteCache, string>;
  poiSearchCache!: Table<{ key: string; poiIds: string; fetchedAt: string }, string>;
  settings!: Table<{ key: string; value: string }, string>;
  tripTemplates!: Table<TripTemplate, string>;

  constructor(name = 'travel_planner') {
    super(name);
    this.version(1).stores({
      trips: 'id, status',
      itineraryDays: 'id, tripId, daySeq',
      pois: 'id, name, mapPoiId',
      poiAiCards: 'poiId, cacheKey',
      itineraryItems: 'id, dayId, orderSeq',
      transports: 'id, tripId',
      hotels: 'id, tripId',
      expenses: 'id, tripId, date, dirty',
      routeCache: 'id, fetchedAt',
      poiSearchCache: 'key, fetchedAt',
      settings: 'key',
    });
    // V6.0: 新增 tripTemplates 表(自动升级)
    this.version(2).stores({
      tripTemplates: 'id, cities, daysCount',
    });
  }

  // ── trips ──

  async listTrips(): Promise<Trip[]> {
    return this.trips.orderBy('id').reverse().toArray();
  }

  async getTrip(id: string): Promise<Trip | null> {
    return (await this.trips.get(id)) ?? null;
  }

  /**
   * 触碰旅程的 updatedAt。
   *
   * ⚠️ 所有会改变旅程【内容】的操作都必须调用它（加景点/酒店/记账/改天等）。
   * 否则：reconcile 比较的是 trip.updatedAt 与云端 updated_at，
   * 而云端每次备份都会刷新该时间 → 判定"云端更新" → restoreTrip 整体覆盖本地
   * → 用户刚添加的内容被抹掉（历史上表现为"要加两次才生效"）。
   * 删除操作(deleteTrip)不需要。
   */
  async touchTrip(tripId: string | undefined | null): Promise<void> {
    if (!tripId) return;
    try { await this.trips.update(tripId, { updatedAt: new Date().toISOString() }); }
    catch { /* trip 可能已删除,忽略 */ }
  }

  /** 由 dayId 反查 tripId（item / day 相关操作触碰 updatedAt 时用） */
  private async tripIdByDay(dayId: string): Promise<string | null> {
    const day = await this.itineraryDays.get(dayId);
    return day?.tripId ?? null;
  }

  /**
   * 备份成功后，把本地 updatedAt 对齐到云端存的时间戳。
   *
   * 必要性：备份发生在修改【之后】，若云端用服务端 now() 作为 updated_at，
   * 它必然大于本地 trip.updatedAt → 下次 reconcile 判定「云端更新」→ 用云端
   * 快照覆盖本地 → 刚改的内容被回滚（历史上表现为"要加两次才生效"）。
   * 约定：服务端存快照自带的 savedAt，这里对齐到同一个值，两边即收敛为相等。
   */
  async adoptSyncedAt(tripId: string, isoTs: string): Promise<void> {
    if (!tripId || !isoTs) return;
    try {
      const cur = await this.trips.get(tripId);
      if (!cur) return;
      // 只向前对齐：若备份期间又产生了更新(本地更新),不要把它回退成旧值
      const curTs = cur.updatedAt ? new Date(cur.updatedAt).getTime() : 0;
      if (new Date(isoTs).getTime() < curTs) return;
      await this.trips.update(tripId, { updatedAt: isoTs });
    } catch { /* trip 可能已删除,忽略 */ }
  }

  /** 新增旅程;id 缺省随机生成,恢复时传原 id 保持本地=云端一致 */
  async createTrip(input: Omit<Trip, 'id' | 'status'>, id?: string): Promise<Trip> {
    const tripId = id || uuid();
    const now = new Date().toISOString();
    const trip: Trip = { ...input, id: tripId, status: 'planning', updatedAt: now };
    const days = generateDays(trip.startDate, trip.endDate);
    await this.transaction('rw', this.trips, this.itineraryDays, async () => {
      await this.trips.add(trip);
      await this.itineraryDays.bulkAdd(
        days.map((d) => ({ ...d, tripId })),
      );
    });
    return trip;
  }

  async updateTrip(id: string, patch: Partial<Trip>): Promise<void> {
    await this.trips.update(id, { ...patch, updatedAt: new Date().toISOString() });
  }

  async deleteTrip(id: string): Promise<void> {
    const tables = [this.trips, this.itineraryDays, this.itineraryItems, this.transports, this.hotels, this.expenses, this.poiAiCards] as const;
    await this.transaction('rw', tables, async () => {
        const days = await this.itineraryDays.where({ tripId: id }).toArray();
        const dayIds = days.map((d) => d.id);
        // 收集所有相关 poiId 用于清理 cards
        const items = await this.itineraryItems.where('dayId').anyOf(dayIds).toArray();
        const poiIds = items.map((it) => it.poiId).filter(Boolean) as string[];
        await this.itineraryItems.where('dayId').anyOf(dayIds).delete();
        await this.itineraryDays.where({ tripId: id }).delete();
        await this.transports.where({ tripId: id }).delete();
        await this.hotels.where({ tripId: id }).delete();
        await this.expenses.where({ tripId: id }).delete();
        // 清理该旅程相关的 poi_ai_cards(可选:也可保留全局缓存)
        if (poiIds.length > 0) {
          await this.poiAiCards.where('poiId').anyOf(poiIds).delete();
        }
        await this.trips.delete(id);
      },
    );
  }

  // ── days ──

  async listDays(tripId: string): Promise<ItineraryDay[]> {
    return this.itineraryDays.where({ tripId }).sortBy('daySeq');
  }

  async getDay(dayId: string): Promise<ItineraryDay | null> {
    return (await this.itineraryDays.get(dayId)) ?? null;
  }

  async updateDay(dayId: string, patch: Partial<ItineraryDay>): Promise<void> {
    await this.itineraryDays.update(dayId, patch);
    await this.touchTrip(await this.tripIdByDay(dayId));
  }

  /** V5.0:在指定日期前插入一天,daySeq 自动重排 */
  async addDay(tripId: string, date: string): Promise<ItineraryDay> {
    const days = await this.itineraryDays.where({ tripId }).sortBy('daySeq');
    const insertIdx = days.findIndex(d => d.date > date);
    const id = uuid();
    const newDay: ItineraryDay = {
      id, tripId, daySeq: 0, date,
    };

    if (insertIdx === -1) {
      // 追加到末尾
      newDay.daySeq = days.length + 1;
      days.push(newDay);
    } else {
      // 插入位置,所有 >= insertIdx 的 daySeq += 1
      for (let i = insertIdx; i < days.length; i++) {
        days[i].daySeq++;
        await this.itineraryDays.update(days[i].id, { daySeq: days[i].daySeq });
      }
      newDay.daySeq = insertIdx + 1;
    }

    await this.itineraryDays.add(newDay);
    await this.touchTrip(tripId);
    return newDay;
  }

  /** V5.0:删除某天及所有 items,后续 daySeq 前移 */
  async removeDay(dayId: string): Promise<void> {
    const day = await this.itineraryDays.get(dayId);
    if (!day) return;
    await this.transaction('rw', this.itineraryItems, this.itineraryDays, this.expenses, async () => {
      await this.itineraryItems.where({ dayId }).delete();
      await this.itineraryDays.delete(dayId);
      // 同时清理该天的记账,否则会留下"孤儿"记录(曾出现删除天后
      // 「门票 · XX」仍挂在账上,而对应景点已不存在)
      await this.expenses.where({ dayId }).delete();

      // 重排剩余 days 的 daySeq
      const remaining = await this.itineraryDays.where({ tripId: day.tripId }).sortBy('daySeq');
      for (let i = 0; i < remaining.length; i++) {
        if (remaining[i].daySeq !== i + 1) {
          await this.itineraryDays.update(remaining[i].id, { daySeq: i + 1 });
        }
      }
    });
    await this.touchTrip(day.tripId);
  }

  // ── items ──

  async listItems(dayId: string): Promise<ItineraryItem[]> {
    return this.itineraryItems.where({ dayId }).sortBy('orderSeq');
  }

  async addItem(item: Omit<ItineraryItem, 'id' | 'orderSeq'>): Promise<ItineraryItem> {
    const id = uuid();
    const max = await this.itineraryItems.where({ dayId: item.dayId }).count();
    const created: ItineraryItem = { ...item, id, orderSeq: max };
    await this.itineraryItems.add(created);
    await this.touchTrip(await this.tripIdByDay(item.dayId));
    return created;
  }

  async updateItem(id: string, patch: Partial<ItineraryItem>): Promise<void> {
    const before = await this.itineraryItems.get(id);
    await this.itineraryItems.update(id, patch);
    if (before) await this.touchTrip(await this.tripIdByDay(before.dayId));
  }

  async moveItem(dayId: string, itemId: string, newOrder: number): Promise<void> {
    await this.transaction('rw', this.itineraryItems, async () => {
      const items = await this.itineraryItems.where({ dayId }).sortBy('orderSeq');
      const idx = items.findIndex((it) => it.id === itemId);
      if (idx === -1) return;
      const [moved] = items.splice(idx, 1);
      items.splice(newOrder, 0, moved);
      for (let i = 0; i < items.length; i++) {
        if (items[i].orderSeq !== i) {
          await this.itineraryItems.update(items[i].id, { orderSeq: i });
        }
      }
    });
    await this.touchTrip(await this.tripIdByDay(dayId));
  }

  /** V6.2 拖拽:跨天移动(更新 item 的 dayId,再重排两边 orderSeq) */
  async moveItemAcrossDays(itemId: string, targetDayId: string, targetOrder: number): Promise<void> {
    // 先取 tripId(事务外读 itineraryDays;事务内读未声明的表会抛错)
    const preItem = await this.itineraryItems.get(itemId);
    const tripId = preItem ? await this.tripIdByDay(preItem.dayId) : null;
    await this.transaction('rw', this.itineraryItems, async () => {
      const item = await this.itineraryItems.get(itemId);
      if (!item) return;
      const srcDayId = item.dayId;

      // 1) 先把 item 的 dayId 改为目标天(这一步不能删,否则记录丢失)
      await this.itineraryItems.update(itemId, { dayId: targetDayId });

      // 2) 原天(非目标天)orderSeq 前移
      if (srcDayId !== targetDayId) {
        const srcItems = await this.itineraryItems.where({ dayId: srcDayId }).sortBy('orderSeq');
        for (let i = 0; i < srcItems.length; i++) {
          if (srcItems[i].orderSeq !== i) await this.itineraryItems.update(srcItems[i].id, { orderSeq: i });
        }
      }

      // 3) 目标天:先按当前 orderSeq 取全部,再按 targetOrder 重排
      const dstItems = await this.itineraryItems.where({ dayId: targetDayId }).sortBy('orderSeq');
      const idx = dstItems.findIndex((it) => it.id === itemId);
      if (idx !== -1) {
        const [moved] = dstItems.splice(idx, 1);
        const order = Math.max(0, Math.min(targetOrder, dstItems.length));
        dstItems.splice(order, 0, moved);
      }
      for (let i = 0; i < dstItems.length; i++) {
        if (dstItems[i].orderSeq !== i) await this.itineraryItems.update(dstItems[i].id, { orderSeq: i });
      }
    });
    await this.touchTrip(tripId);
  }

  async removeItem(id: string): Promise<void> {
    const before = await this.itineraryItems.get(id);
    await this.itineraryItems.delete(id);
    if (before) await this.touchTrip(await this.tripIdByDay(before.dayId));
  }

  // ── pois ──

  async upsertPoi(poi: Poi): Promise<Poi> {
    await this.pois.put(poi);
    return poi;
  }

  async getPoi(poiId: string): Promise<Poi | null> {
    return (await this.pois.get(poiId)) ?? null;
  }

  async searchPois(keyword: string): Promise<Poi[]> {
    return this.pois
      .filter((p) => p.name.toLowerCase().includes(keyword.toLowerCase()))
      .toArray();
  }

  // ── expenses ──

  async listExpenses(tripId: string): Promise<Expense[]> {
    return this.expenses.where({ tripId }).sortBy('date');
  }

  async addExpense(exp: Omit<Expense, 'id' | 'dirty'>): Promise<Expense> {
    const id = uuid();
    const created: Expense = { ...exp, id, dirty: 0 };
    await this.expenses.add(created);
    await this.touchTrip(exp.tripId);
    return created;
  }

  async updateExpense(id: string, patch: Partial<Expense>): Promise<void> {
    const before = await this.expenses.get(id);
    await this.expenses.update(id, patch);
    if (before) await this.touchTrip(before.tripId);
  }

  async removeExpense(id: string): Promise<void> {
    const before = await this.expenses.get(id);
    await this.expenses.delete(id);
    if (before) await this.touchTrip(before.tripId);
  }

  async sumExpenses(tripId: string): Promise<number> {
    const items = await this.expenses.where({ tripId }).toArray();
    return items.reduce((s, e) => s + e.amount, 0);
  }

  // ── route cache ──

  async getRouteCache(id: string): Promise<RouteCache | null> {
    const entry = await this.routeCache.get(id);
    if (!entry) return null;
    const age = Date.now() - new Date(entry.fetchedAt).getTime();
    const maxAge = (entry.ttlDays ?? 30) * 86400_000;
    if (age > maxAge) {
      await this.routeCache.delete(id);
      return null;
    }
    return entry;
  }

  async listRouteCache(): Promise<RouteCache[]> {
    return this.routeCache.toArray();
  }

  async upsertRouteCache(entry: {
    key: string;
    origin: [number, number];
    dest: [number, number];
    mode: string;
    durationMin: number;
    distanceM: number;
    ttlDays: number;
  }): Promise<void> {
    await this.routeCache.put({
      id: entry.key,
      originLng: entry.origin[0],
      originLat: entry.origin[1],
      destLng: entry.dest[0],
      destLat: entry.dest[1],
      mode: entry.mode as TransportMode,
      durationMin: entry.durationMin,
      distanceM: entry.distanceM,
      ttlDays: entry.ttlDays,
      fetchedAt: new Date().toISOString(),
    });
  }

  // ── AI cards ──

  async getPoiCard(poiId: string): Promise<PoiAiCard | null> {
    return (await this.poiAiCards.get(poiId)) ?? null;
  }

  async getPoiCardByKey(cacheKey: string): Promise<PoiAiCard | null> {
    return (await this.poiAiCards.where({ cacheKey }).first()) ?? null;
  }

  async upsertPoiCard(card: PoiAiCard): Promise<void> {
    await this.poiAiCards.put(card);
  }

  // ── hotels ──

  async listHotels(tripId: string): Promise<Hotel[]> {
    return this.hotels.where({ tripId }).toArray();
  }

  async addHotel(hotel: Omit<Hotel, 'id'>): Promise<Hotel> {
    const id = uuid();
    const created: Hotel = { ...hotel, id };
    await this.hotels.add(created);
    await this.touchTrip(hotel.tripId);
    return created;
  }

  async updateHotel(id: string, patch: Partial<Hotel>): Promise<void> {
    const before = await this.hotels.get(id);
    await this.hotels.update(id, patch);
    if (before) await this.touchTrip(before.tripId);
  }

  async removeHotel(id: string): Promise<void> {
    const before = await this.hotels.get(id);
    await this.hotels.delete(id);
    if (before) await this.touchTrip(before.tripId);
  }

  // ── transports ──

  async listTransports(tripId: string): Promise<Transport[]> {
    return this.transports.where({ tripId }).toArray();
  }

  async addTransport(transport: Omit<Transport, 'id'>): Promise<Transport> {
    const id = uuid();
    const created: Transport = { ...transport, id };
    await this.transports.add(created);
    await this.touchTrip(transport.tripId);
    return created;
  }

  async updateTransport(id: string, patch: Partial<Transport>): Promise<void> {
    const before = await this.transports.get(id);
    await this.transports.update(id, patch);
    if (before) await this.touchTrip(before.tripId);
  }

  async removeTransport(id: string): Promise<void> {
    const before = await this.transports.get(id);
    await this.transports.delete(id);
    if (before) await this.touchTrip(before.tripId);
  }

  // ── settings ──

  async getSetting(key: string): Promise<string | null> {
    const entry = await this.settings.get(key);
    return entry?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.settings.put({ key, value });
  }

  // ── V6.0 templates ──

  async listTemplates(): Promise<TripTemplate[]> {
    return this.tripTemplates.toArray();
  }

  async getTemplate(id: string): Promise<TripTemplate | null> {
    return (await this.tripTemplates.get(id)) ?? null;
  }

  async upsertTemplate(tpl: TripTemplate): Promise<void> {
    await this.tripTemplates.put(tpl);
  }

  /** V10 多用户:登录/登出时清空本地用户数据(settings/templates 保留),供登录后从云端重拉 */
  async clearAll(): Promise<void> {
    await this.transaction(
      'rw',
      [this.itineraryItems, this.itineraryDays, this.transports, this.hotels, this.expenses,
       this.poiAiCards, this.pois, this.routeCache, this.poiSearchCache, this.trips],
      async () => {
        await Promise.all([
          this.itineraryItems.clear(),
          this.itineraryDays.clear(),
          this.transports.clear(),
          this.hotels.clear(),
          this.expenses.clear(),
          this.poiAiCards.clear(),
          this.pois.clear(),
          this.routeCache.clear(),
          this.poiSearchCache.clear(),
          this.trips.clear(),
        ]);
      },
    );
  }
}

/** 行程天数生成:从 startDate 到 endDate,每天一 day */
function generateDays(
  start: string,
  end: string,
): Array<Omit<ItineraryDay, 'tripId'>> {
  const days: Array<Omit<ItineraryDay, 'tripId'>> = [];
  const s = new Date(start);
  const e = new Date(end);
  let seq = 0;
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    days.push({
      id: uuid(),
      daySeq: ++seq,
      date: d.toISOString().slice(0, 10),
    });
  }
  return days;
}

/**
 * 数据库名:按账号隔离,每个用户一个独立 IndexedDB 库。
 * 这样切换账号时各账号数据互不干扰 —— 不再需要"登录时清空本地库",
 * 也就彻底消除了「清空本地 → 未同步数据永久丢失」的窗口。
 *
 * 'travel_planner' 是旧版单库名,仅用于下列迁移函数识别历史数据。
 */
export const LEGACY_DB_NAME = 'travel_planner';
const DB_PREFIX = 'travel_planner';

function dbNameForUser(userId: string | null | undefined): string {
  return userId ? `${DB_PREFIX}__${userId}` : `${DB_PREFIX}__anon`;
}

let activeDb = new TravelDb(dbNameForUser(null));

/** 当前活动库(测试用) */
export function getActiveDb(): TravelDb {
  return activeDb;
}

/** 已打开过的库,切回时复用避免重复 open */
const openedDbs = new Map<string, TravelDb>();

/**
 * 切换当前活动数据库(登录/登出时调用)。
 * 打开失败时退回独立库,保证不误用其他账号的数据。
 */
export async function setActiveDb(userId: string | null | undefined): Promise<void> {
  const name = dbNameForUser(userId);
  if (activeDb.name === name) return;

  let next = openedDbs.get(name);
  try {
    if (!next) {
      next = new TravelDb(name);
      openedDbs.set(name, next);
    }
    // 复用时可能已被切换流程关闭,需重新打开
    if (!next.isOpen()) await next.open();
  } catch (e) {
    console.warn(`[db] 打开 ${name} 失败,退回独立库`, e);
    next = new TravelDb(dbNameForUser(null));
  }

  // 关掉旧库(不再需要它持有连接;数据仍在 IndexedDB 中,切回时会重新打开)
  try { activeDb.close(); } catch { /* ignore */ }

  activeDb = next;
}

/**
 * 把旧的单库数据迁到目标账号库，然后【销毁旧库】。
 *
 * 销毁是必须的：旧库对所有账号可见，若不销毁，之后每个新登录的账号
 * 都会再继承一遍这些数据（曾经导致新账号看到别人的旅程）。
 *
 * 同时把旧库的 trip id 记到 localStorage，供 reconcile 识别并清除
 * 「已被其他账号继承」的本地脏数据。
 */
export async function migrateLegacyDb(targetUserId: string): Promise<boolean> {
  if (!(await Dexie.exists(LEGACY_DB_NAME))) return false;

  const TABLES = [
    'trips', 'itineraryDays', 'pois', 'poiAiCards', 'itineraryItems',
    'transports', 'hotels', 'expenses', 'routeCache', 'poiSearchCache',
    'settings', 'tripTemplates',
  ] as const;

  // 1. 先把旧库全部读入内存 —— IndexedDB 事务不能跨数据库,
  //    必须在目标库事务【之外】完成旧库读取,否则事务会失效。
  const dump: Record<string, any[]> = {};
  const legacy = new TravelDb(LEGACY_DB_NAME);
  try {
    await legacy.open();
    for (const t of TABLES) {
      dump[t] = await (legacy as any)[t].toArray();
    }
    legacy.close();
  } catch (e) {
    console.warn('[db] 读取旧库失败', e);
    try { legacy.close(); } catch { /* ignore */ }
    return false;
  }

  // 记录旧数据的 id,供后续识别继承污染
  if (dump.trips?.length) {
    try { localStorage.setItem(LEGACY_IDS_KEY, JSON.stringify(dump.trips.map((t: any) => t.id))); } catch { /* ignore */ }
  }

  let migrated = false;
  const target = new TravelDb(dbNameForUser(targetUserId));
  try {
    await target.open();
    // 目标账号库为空才写入（已有数据说明已被认领，不覆盖）
    if ((await target.listTrips()).length === 0 && dump.trips?.length) {
      await target.transaction('rw', TABLES.map((t) => (target as any)[t]), async () => {
        for (const t of TABLES) {
          if (dump[t]?.length) await (target as any)[t].bulkAdd(dump[t]);
        }
      });
      migrated = true;
      console.log(`[db] 已把历史数据(${dump.trips.length} 个旅程)迁移到账号库`);
    }
  } catch (e) {
    console.warn('[db] 历史数据迁移失败', e);
    return false;
  } finally {
    try { target.close(); } catch { /* ignore */ }
  }

  // 2. 无论是否写入，旧库都必须销毁，否则会被下一个账号再次继承
  try { await Dexie.delete(LEGACY_DB_NAME); } catch { /* ignore */ }
  return migrated;
}

const LEGACY_IDS_KEY = 'travel_legacy_claimed_ids';

/** 旧库里的旅程 id（即「历史遗产」），用于识别本地脏数据 */
export function getLegacyTripIds(): string[] {
  try {
    const raw = localStorage.getItem(LEGACY_IDS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

/**
 * 门面:所有调用方拿到的是当前活动库的即时代理。
 * 这样切换账号后,原模块级 `import { db }` 引用依然指向新库,无需改动 13 个调用点。
 */
export const travelDb = new Proxy({} as TravelDb, {
  get(_t, prop, receiver) {
    const value = Reflect.get(activeDb as object, prop, receiver);
    return typeof value === 'function' ? value.bind(activeDb) : value;
  },
  set(_t, prop, value) {
    return Reflect.set(activeDb as object, prop, value);
  },
  has(_t, prop) { return prop in activeDb; },
});

