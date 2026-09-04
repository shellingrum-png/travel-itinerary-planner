# 数据库设计

> 本地 IndexedDB(Dexie.js);如需跨设备同步再引入 Supabase。所有表以 `trip_id` 隔离,个人版单用户可省略 user_id。

## ER 概览

```
trips 1──n itinerary_days 1──n itinerary_items n──1 pois
  │ 1──n transports                 (item 可为 buffer/hotel,此时 poi_id 空)
  │ 1──n hotels
  │ 1──n expenses
  │ 1──n poi_ai_cards ──1 pois
trip_templates 为独立冷启动模板表(不关联具体 trip)
route_cache、settings 为全局缓存表,独立于旅程
```

## 建表 SQL(SQLite → 映射到 Dexie 表定义)

> 以下 SQL 描述表结构与字段含义,实际 Web 端使用 Dexie(IndexedDB),表结构一一对应。
> 外键与级联删除由业务层保证(DAL 提供 `deleteTrip` 时 `transaction` 依次删子表),不依赖数据库 FK。

-- 4.1 旅程
CREATE TABLE trips (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  destination   TEXT,               -- 目的地,如"青甘大环线"
  start_date    TEXT NOT NULL,      -- ISO yyyy-mm-dd
  end_date      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'planning', -- planning|ongoing|finished
  total_budget  REAL,
  companion_count INTEGER DEFAULT 1,
  currency      TEXT DEFAULT 'CNY',
  city_nodes    TEXT,               -- V6.0:JSON 数组 [{"city":"西宁","nights":2},{"city":"敦煌","nights":3}]
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

-- 4.1b 行程模板(冷启动, V6.0 新增)
CREATE TABLE trip_templates (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,       -- 如"青甘大环线经典7日游"
  cities       TEXT NOT NULL,       -- "西宁,张掖,敦煌" 用于匹配
  days_count   INTEGER NOT NULL,
  content_json TEXT NOT NULL,       -- 完整预排: days/items/pois/hotels 数据,一键套用
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_templates_cities ON trip_templates(cities);

-- 4.2 单日
CREATE TABLE itinerary_days (
  id         TEXT PRIMARY KEY,
  trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  day_seq    INTEGER NOT NULL,      -- 1 起
  date       TEXT NOT NULL,         -- yyyy-mm-dd
  start_time TEXT,                  -- 自动推导,可覆盖
  end_time   TEXT,
  UNIQUE(trip_id, day_seq)
);

-- 4.3 POI(景点/餐厅/酒店点)
CREATE TABLE pois (
  id          TEXT PRIMARY KEY,
  map_poi_id  TEXT,                 -- 地图服务商 POI id
  name        TEXT NOT NULL,
  lng         REAL NOT NULL,
  lat         REAL NOT NULL,
  category    TEXT DEFAULT 'poi',   -- poi|restaurant|hotel|shopping
  rating      REAL,                 -- 0-5
  address     TEXT,
  closed_days TEXT,                 -- JSON 数组:["周一","周二"]
  ext_json    TEXT                  -- 服务商原始数据兜底
);
CREATE INDEX idx_pois_name ON pois(name);
CREATE INDEX idx_pois_map ON pois(map_poi_id);

-- 4.4 AI 卡片缓存
CREATE TABLE poi_ai_cards (
  poi_id       TEXT PRIMARY KEY REFERENCES pois(id) ON DELETE CASCADE,
  content_json TEXT NOT NULL,       -- {recommend_reason,pitfall_guide,suggest_duration,tips,rating}
  llm_model    TEXT,
  cache_key    TEXT NOT NULL UNIQUE,-- md5(poi_name+city) 幂等
  created_at   TEXT DEFAULT (datetime('now'))
);

-- 4.5 单日排点(时间轴节点)
-- 孤儿节点规则(PRD §4 数据模型表 itinerary_items 行):item_type='poi' 且 poi_id 为空 → 自动删除该节点并弹一次提示
CREATE TABLE itinerary_items (
  id             TEXT PRIMARY KEY,
  day_id         TEXT NOT NULL REFERENCES itinerary_days(id) ON DELETE CASCADE,
  poi_id         TEXT REFERENCES pois(id) ON DELETE SET NULL,
  item_type      TEXT NOT NULL DEFAULT 'poi',  -- poi|transport|hotel|buffer
  order_seq      INTEGER NOT NULL,
  visit_minutes  INTEGER,           -- 游览耗时:poi 默认取 AI 卡片
  transport_mode TEXT DEFAULT 'walk',          -- walk|drive|transit(从前一段节点到本节点)
  arrive_time    TEXT,              -- HH:MM(含 24h+ 跨日标记 xx)
  leave_time     TEXT,
  note           TEXT,
  UNIQUE(day_id, order_seq)
);
CREATE INDEX idx_items_day ON itinerary_items(day_id);

-- 4.6 大交通
CREATE TABLE transports (
  id          TEXT PRIMARY KEY,
  trip_id     TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  seg_type    TEXT NOT NULL,        -- round_trip|inter_city
  mode        TEXT NOT NULL,        -- flight|train|drive|ferry
  from_place  TEXT,
  to_place    TEXT,
  depart_at   TEXT,                 -- ISO datetime
  arrive_at   TEXT,
  flight_no   TEXT,
  train_no    TEXT
);

-- 4.7 酒店
CREATE TABLE hotels (
  id         TEXT PRIMARY KEY,
  trip_id    TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  address    TEXT,
  lng        REAL,
  lat        REAL,
  check_in   TEXT,
  check_out  TEXT,
  check_in_time  TEXT,  -- PRD §2.2 同日酒店迁移:默认 14:00,可选
  check_out_time TEXT,  -- PRD §2.2 同日酒店迁移:默认 12:00,可选
  poi_id     TEXT REFERENCES pois(id) ON DELETE SET NULL
);

-- 4.8 消费
CREATE TABLE expenses (
  id       TEXT PRIMARY KEY,
  trip_id  TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  category TEXT NOT NULL,           -- transport|hotel|food|ticket|local_traffic|other
  amount   REAL NOT NULL,           -- PRD §5.1:0 < amount ≤ 999999,两位小数,负数禁用
  currency TEXT DEFAULT 'CNY',      -- PRD §5.1:V1 恒等于旅程币种,不做汇率(字段为多币种预留)
  paid_by  TEXT,                    -- 代付人
  date     TEXT,                    -- 消费日 yyyy-mm-dd
  note     TEXT,
  dirty    INTEGER DEFAULT 0,       -- 离线待同步标记
  ref_type TEXT,                    -- V6.2:关联对象类型 poi|hotel|transport|itinerary_item
  ref_id   TEXT,                    -- V6.2:关联对象 id(如 poi_id / hotel_id / transport_id)
  day_id   TEXT,                    -- V6.2:关联的日程天 id
  updated_at TEXT DEFAULT (datetime('now'))
);
-- V6.2 索引:按关联对象快速聚合查询
CREATE INDEX idx_expenses_ref ON expenses(ref_type, ref_id);

-- 4.9 路径规划缓存(省 API 配额)
CREATE TABLE route_cache (
  id          TEXT PRIMARY KEY,     -- md5(originLng+originLat+destLng+destLat+mode)
  origin_lng  REAL, origin_lat REAL,
  dest_lng    REAL,  dest_lat REAL,
  mode        TEXT,
  distance_m  INTEGER,
  duration_min INTEGER,
  fetched_at  TEXT DEFAULT (datetime('now')),
  ttl_days    INTEGER DEFAULT 30
);
CREATE INDEX idx_route_key ON route_cache(id, mode);

-- 4.10 设置
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- POI 检索缓存(§6.2)
CREATE TABLE poi_search_cache (
  key  TEXT PRIMARY KEY,            -- md5(city+keyword)
  poi_ids TEXT,                     -- JSON 数组
  fetched_at TEXT DEFAULT (datetime('now'))
);
```

## 同步策略(启用云端时)

- 每行带 `updated_at`,同步按表拉取增量;
- 冲突合并规则:mtime 后写优先,保留 `updated_at` 大的版本;
- `expenses.dirty=1` 表示离线新增/修改,联网后先上行,再拉增量。