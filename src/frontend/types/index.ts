// 领域类型定义,与 docs/DB_SCHEMA.md 对应
// 迁移提示:新建表/字段时保持此处与 DB_SCHEMA 同步,Web 端使用 Dexie(IndexedDB)

export type TripStatus = 'planning' | 'ongoing' | 'finished';

export interface Trip {
  id: string;
  title: string;
  destination: string;
  startDate: string; // yyyy-mm-dd
  endDate: string;
  status: TripStatus;
  totalBudget?: number;
  companionCount: number;
  currency: string;
  cityNodes?: CityNode[]; // V6.0: 多城市节点分配
  updatedAt?: string;     // V9.0: 最近修改时间,用于云同步冲突合并(last-write-wins)
}

export interface CityNode {
  city: string;   // 城市名
  nights: number; // 该城市住宿晚数
}

/** V6.0 行程模板(冷启动) */
export interface TripTemplate {
  id: string;
  title: string;       // 如"青甘大环线经典7日游"
  cities: string;      // "西宁,张掖,敦煌" 用于匹配
  daysCount: number;
  contentJson: string; // 完整预排: days/items/pois/hotels 数据
}

export interface ItineraryDay {
  id: string;
  tripId: string;
  daySeq: number;
  date: string;
  startTime?: string; // HH:MM
  endTime?: string;
  note?: string; // 当日主题/备注
}

export type PoiCategory = 'poi' | 'restaurant' | 'hotel' | 'shopping';

export interface Poi {
  id: string;
  mapPoiId?: string;
  name: string;
  lng: number;
  lat: number;
  category: PoiCategory;
  rating?: number;
  address?: string;
  closedDays?: string[];
  city?: string;   // V6.3 逆地理绑定:所属城市
  fixed?: boolean; // V6.3 已逆地理纠错标记
}

export interface PoiAiCard {
  poiId: string;
  recommendReason: string;
  pitfallGuide: string;
  suggestDuration: number; // 分钟
  tips: string[];
  rating: number;
  cacheKey: string;
  llmModel?: string;
}

export type ItemType = 'poi' | 'transport' | 'hotel' | 'buffer';
// V6.2 交通方式扩展:walk/drive/transit(城内) + train/flight(城际)
export type TransportMode = 'walk' | 'drive' | 'transit' | 'train' | 'flight';

// 单日时间轴节点
export interface ItineraryItem {
  id: string;
  dayId: string;
  poiId?: string;
  itemType: ItemType;
  orderSeq: number;
  visitMinutes?: number;
  transportMode: TransportMode; // 从上一节点到本节点的交通方式
  /**
   * 该交通方式是否为用户明确设置。
   * false/缺省 = 历史/导入数据的默认值(等于"未指定"),按距离做合理性修正;
   * true = 用户在「修改」弹窗里选定,完全尊重,不做任何改判。
   */
  transportModeSet?: boolean;
  arriveTime?: string;
  leaveTime?: string;
  note?: string;
}

export type TransportModeType = 'flight' | 'train' | 'drive' | 'ferry';
export type TransportSegmentType = 'round_trip' | 'inter_city';

export interface Transport {
  id: string;
  tripId: string;
  segType: TransportSegmentType;
  mode: TransportModeType;
  fromPlace?: string;
  toPlace?: string;
  departAt: string; // ISO datetime
  arriveAt: string;
  flightNo?: string;
  trainNo?: string;
}

export interface Hotel {
  id: string;
  tripId: string;
  name: string;
  address?: string;
  lng?: number;
  lat?: number;
  checkIn?: string;
  checkOut?: string;
  checkInTime?: string;  // PRD §2.2 同日酒店迁移:默认 14:00
  checkOutTime?: string; // PRD §2.2 同日酒店迁移:默认 12:00
  poiId?: string;
}

export type ExpenseCategory =
  | 'transport'
  | 'hotel'
  | 'food'
  | 'ticket'
  | 'local_traffic'
  | 'other';

export interface Expense {
  id: string;
  tripId: string;
  category: ExpenseCategory;
  amount: number;
  currency: string;
  paidBy?: string;
  date?: string;
  note?: string;
  dirty: 0 | 1; // 离线待同步
  refType?: string; // V6.2 关联对象类型: poi | hotel | transport | itinerary_item
  refId?: string;   // V6.2 关联对象 id
  dayId?: string;   // V6.2 关联日程天 id
}

// 路径规划缓存
export interface RouteCache {
  id: string; // md5(origin+dest+mode)
  originLng: number;
  originLat: number;
  destLng: number;
  destLat: number;
  mode: TransportMode;
  distanceM: number;
  durationMin: number;
  ttlDays: number;
  fetchedAt: string;
}

// 冲突预警
export interface Conflict {
  type: 'overlap' | 'closed' | 'tight_transit' | 'over_budget' | 'over_suggest';
  level: 'yellow' | 'red' | 'grey';
  message: string;
  itemIds?: string[];
}