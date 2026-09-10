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
    return newDay;
  }

  /** V5.0:删除某天及所有 items,后续 daySeq 前移 */
  async removeDay(dayId: string): Promise<void> {
    const day = await this.itineraryDays.get(dayId);
    if (!day) return;
    await this.transaction('rw', this.itineraryItems, this.itineraryDays, async () => {
      await this.itineraryItems.where({ dayId }).delete();
      await this.itineraryDays.delete(dayId);

      // 重排剩余 days 的 daySeq
      const remaining = await this.itineraryDays.where({ tripId: day.tripId }).sortBy('daySeq');
      for (let i = 0; i < remaining.length; i++) {
        if (remaining[i].daySeq !== i + 1) {
          await this.itineraryDays.update(remaining[i].id, { daySeq: i + 1 });
        }
      }
    });
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
    return created;
  }

  async updateItem(id: string, patch: Partial<ItineraryItem>): Promise<void> {
    await this.itineraryItems.update(id, patch);
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
  }

  /** V6.2 拖拽:跨天移动(更新 item 的 dayId,再重排两边 orderSeq) */
  async moveItemAcrossDays(itemId: string, targetDayId: string, targetOrder: number): Promise<void> {
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
  }

  async removeItem(id: string): Promise<void> {
    await this.itineraryItems.delete(id);
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
    return created;
  }

  async updateExpense(id: string, patch: Partial<Expense>): Promise<void> {
    await this.expenses.update(id, patch);
  }

  async removeExpense(id: string): Promise<void> {
    await this.expenses.delete(id);
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
    return created;
  }

  async updateHotel(id: string, patch: Partial<Hotel>): Promise<void> {
    await this.hotels.update(id, patch);
  }

  async removeHotel(id: string): Promise<void> {
    await this.hotels.delete(id);
  }

  // ── transports ──

  async listTransports(tripId: string): Promise<Transport[]> {
    return this.transports.where({ tripId }).toArray();
  }

  async addTransport(transport: Omit<Transport, 'id'>): Promise<Transport> {
    const id = uuid();
    const created: Transport = { ...transport, id };
    await this.transports.add(created);
    return created;
  }

  async updateTransport(id: string, patch: Partial<Transport>): Promise<void> {
    await this.transports.update(id, patch);
  }

  async removeTransport(id: string): Promise<void> {
    await this.transports.delete(id);
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

/** 把旧的单库数据(若存在)整个迁移到目标账号库,确保老用户数据不丢 */
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
  } catch (e) {
    console.warn('[db] 读取旧库失败', e);
    try { legacy.close(); } catch { /* ignore */ }
    return false;
  } finally {
    try { legacy.close(); } catch { /* ignore */ }
  }

  if (!dump.trips?.length) return false;

  // 2. 写入账号库(目标库已有数据则不动,避免覆盖新数据)
  const target = new TravelDb(dbNameForUser(targetUserId));
  try {
    await target.open();
    if ((await target.listTrips()).length > 0) { target.close(); return false; }

    await target.transaction('rw', TABLES.map((t) => (target as any)[t]), async () => {
      for (const t of TABLES) {
        if (dump[t]?.length) await (target as any)[t].bulkAdd(dump[t]);
      }
    });
    console.log(`[db] 已把历史数据(${dump.trips.length} 个旅程)迁移到账号库`);
    return true;
  } catch (e) {
    console.warn('[db] 历史数据迁移失败', e);
    return false;
  } finally {
    try { target.close(); } catch { /* ignore */ }
  }
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

