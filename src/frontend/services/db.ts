/**
 * 本地数据库服务(抽象层)
 * 说明:Web 端使用 Dexie(IndexedDB),DAL 接口与平台无关。
 * 迁移提示:后续 RN 端替换实现的 SQLite 实现,接口不变。
 * 已预留与 docs/DB_SCHEMA.md 一致的接口,迁移实现不影响业务层。
 */
import type { Trip, ItineraryDay, ItineraryItem, Poi, Expense, RouteCache, PoiAiCard, Hotel, Transport, TripTemplate } from '../types';

export interface Db {
  // trips
  listTrips(): Promise<Trip[]>;
  getTrip(id: string): Promise<Trip | null>;
  createTrip(input: Omit<Trip, 'id' | 'status'>, id?: string): Promise<Trip>;
  /** 触碰旅程 updatedAt(所有内容变更必须调用,否则云端会覆盖本地) */
  touchTrip(tripId: string | undefined | null): Promise<void>;
  // 自动生成 itinerary_days(day_seq=1..N);id 缺省随机,恢复时可传原 id
  updateTrip(id: string, patch: Partial<Trip>): Promise<void>;
  deleteTrip(id: string): Promise<void>;

  // days
  listDays(tripId: string): Promise<ItineraryDay[]>;
  getDay(dayId: string): Promise<ItineraryDay | null>;
  /** V6.0:更新单日信息(如主题 note) */
  updateDay(dayId: string, patch: Partial<ItineraryDay>): Promise<void>;

  // items(时间轴节点)
  listItems(dayId: string): Promise<ItineraryItem[]>;
  addItem(item: Omit<ItineraryItem, 'id' | 'orderSeq'>): Promise<ItineraryItem>;
  updateItem(id: string, patch: Partial<ItineraryItem>): Promise<void>;
  moveItem(dayId: string, itemId: string, newOrder: number): Promise<void>;
  /** V6.2 拖拽:跨天移动(item 从原天删,插入目标天指定位置) */
  moveItemAcrossDays(itemId: string, targetDayId: string, targetOrder: number): Promise<void>;
  removeItem(id: string): Promise<void>;

  // pois
  upsertPoi(poi: Poi): Promise<Poi>;
  getPoi(poiId: string): Promise<Poi | null>;
  searchPois(keyword: string): Promise<Poi[]>; // 读 poi_search_cache

  // expenses
  listExpenses(tripId: string): Promise<Expense[]>;
  addExpense(exp: Omit<Expense, 'id' | 'dirty'>): Promise<Expense>;
  updateExpense(id: string, patch: Partial<Expense>): Promise<void>;
  removeExpense(id: string): Promise<void>;
  /** 已花合计(按币种汇总,V1 单币种) */
  sumExpenses(tripId: string): Promise<number>;

  // route cache
  getRouteCache(key: string): Promise<RouteCache | null>;
  /** V9.0:读取全部路径缓存(数据概览按 key 聚合开车公里) */
  listRouteCache(): Promise<RouteCache[]>;
  upsertRouteCache(entry: {
    key: string;
    origin: [number, number];
    dest: [number, number];
    mode: string;
    durationMin: number;
    distanceM: number;
    ttlDays: number;
  }): Promise<void>;

  // AI cards
  getPoiCard(poiId: string): Promise<PoiAiCard | null>;
  getPoiCardByKey(cacheKey: string): Promise<PoiAiCard | null>;
  upsertPoiCard(card: PoiAiCard): Promise<void>;

  // hotels
  listHotels(tripId: string): Promise<Hotel[]>;
  addHotel(hotel: Omit<Hotel, 'id'>): Promise<Hotel>;
  updateHotel(id: string, patch: Partial<Hotel>): Promise<void>;
  removeHotel(id: string): Promise<void>;

  // transports
  listTransports(tripId: string): Promise<Transport[]>;
  addTransport(transport: Omit<Transport, 'id'>): Promise<Transport>;
  updateTransport(id: string, patch: Partial<Transport>): Promise<void>;
  removeTransport(id: string): Promise<void>;

  // settings
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;

  // days (new for V5.0)
  addDay(tripId: string, date: string): Promise<ItineraryDay>;
  removeDay(dayId: string): Promise<void>;

  // V6.0 templates
  listTemplates(): Promise<TripTemplate[]>;
  getTemplate(id: string): Promise<TripTemplate | null>;
  upsertTemplate(tpl: TripTemplate): Promise<void>;

  /** V10 多用户:清空本地用户数据(登录/登出时) */
  clearAll(): Promise<void>;
}

// 占位导出,后续替换为 Dexie 实现
export const ROUTE_CACHE_TTL_DAYS = 30;

export { travelDb as db, setActiveDb, migrateLegacyDb, getActiveDb, getLegacyTripIds, LEGACY_DB_NAME } from './dexie';