# 技术方案设计文档

> 依据 `docs/PRD.md` V6.3.1(五步引擎+UI美化+拖拽+坐标污染修复)输出,面向已交付实现。
> 决策前提:**平台 = Web(H5)验证优先,逻辑层平台无关**,后续可套壳 Taro(小程序)或 React Native。

---

## 1. 技术选型总览

| 层 | 选型 | 版本/说明 | 理由 |
| :--- | :--- | :--- | :--- |
| 前端框架 | React 18 + TypeScript(严格模式) | React ^18.2 | 与现有骨架一致,TS 全量类型 |
| 构建 | Vite | ^5 | 启动快,零配置 |
| 状态管理 | zustand | ^4 | 轻量,无样板 |
| 路由 | React Router | ^6 | 参数化路由 `trip/:id/day/:n` |
| 样式 | 原生 CSS + 设计 token | 无 UI 库 | 验证阶段避免组件库心智负担 |
| 本地持久化 | **Dexie(IndexedDB)** | ^4 | Web 原生异步存储 |
| 地图渲染 | **高德 JS API 2.0** | — | JS Key + 安全密钥;**暗色主题 `amap://styles/dark`** |
| 地图数据(POI/路径) | **高德 JS API PlaceSearch/Driving/Transfer** | 免 Web 服务 Key | JS API 内置搜索,避免 Key 类型不匹配问题 |
| AI 卡片 | **TokenHub deepseek-v4-flash** | `https://tokenhub.tencentmaas.com/plan/v3` | 腾讯云大模型平台,兼容 OpenAI 接口 |
| RAG 知识库 | Supabase(pgvector) | 软依赖 | 未配置/为空静默跳过 |
| 测试 | Vitest + @testing-library/react | — | 36 个单测全绿 |
| 部署 | Vercel(或 GitHub Pages) | 免费 | H5 静态托管 |
| ID 生成 | `crypto.randomUUID()` | 原生 | 无依赖 |

### 1.1 未来平台迁移线

```
Web(H5)  ──┐
           ├─▶ Taro(微信小程序):UI 层换 Taro 组件,store/services/db 接口不变
React Native ┘  持久化换 SQLite(倒装实现同一 DAL 接口)
```

全部业务逻辑位于 `src/frontend/utils/` 层,平台零耦合。

---

## 2. 总体架构

### 2.1 分层架构

```
┌────────────────────────────────────────────────────────────┐
│  UI 层  pages/ + components/ (React+Router)                │
│  旅程列表(三步创建向导) · 核心页(双模式:编辑/预览) · 时间轴 · … │
├────────────────────────────────────────────────────────────┤
│  状态层  stores/ (zustand)                                 │
│  useTripStore · useDayStore · useStagedStore · useWizardStore(创建向导) │
├────────────────────────────────────────────────────────────┤
│  领域服务层  services/ + utils/  ← 全部核心逻辑, 平台无关   │
│  time(级联) · tsp(优化) · conflicts(预警) · amap(路径/搜索) │
│  llm(5层读取) · boundary(Day推导) · templates(模板匹配)     │
├────────────────────────────────────────────────────────────┤
│  DAL 层  services/db.ts (抽象接口)                         │
│  Dexie(IndexedDB) 实现在 Web 端;SQLite 实现在移动端         │
├────────────────────────────────────────────────────────────┤
│  外部依赖  高德(JS API) · TokenHub LLM · Supabase(可选)      │
└────────────────────────────────────────────────────────────┘
```

### 2.2 关键数据流

**① 三步创建向导 → 一键套用模板**
```
Step1:城市列表+起止日期 → Step2:按城市分配晚数(总晚数=天数-1)
→ Step3:模板匹配(trip_templates.cities LIKE 用户城市)
→ 方案甲:套用 → content_json 解析 → 批量写 trips/days/items/pois/hotels
→ 方案乙:空白 → 仅建 trips + itinerary_days 骨架
```

**② 一站式地图编辑 → 添加景点**
```
点击某天 → 输入关键词 → JS API PlaceSearch → 候选列表
→ 选中候选 → 地图飞移(tempMarker) → 触发 LLM getPoiCard
→ AI 卡片展示 → 确认 → upsertPoi + addItem → load() 刷新地图覆盖物
```

**③ 记账 → 预算条**
```
提交expense(校验) → Dexie add → refreshBudget(): SUM(amount) → zustand 更新
```

**④ 优化**
```
一键优化 → 构建耗时矩阵(route_cache/API) → solveTsp → 预览节省 → 确认回写(快照)
```

**⑤ 双模式切换(Toggle)**
```
mode = 'editor' | 'viewer'
editor: 展示天卡片+编辑面板+全量地图(所有Marker+城市内部Polyline)
viewer: 隐藏CRUD → 展示左侧大纲(时间段)+宏观轨迹地图(粗线+住宿/枢纽Marker)
```

---

## 3. 目录结构(落地版 V6.0)

```
travel/
├── docs/                  # PRD / TECH_DESIGN / ROADMAP / DB_SCHEMA / API / WIREFLOW
├── scripts/               # seed.cjs(Excel→JSON 数据初始化脚本)
├── config/                # 前端常量
├── src/frontend/
│   ├── main.tsx           # 入口
│   ├── App.tsx            # 路由(10 条)
│   ├── pages/             # 10 个页面
│   │   ├── TripList.tsx     # 旅程列表 + **三步创建向导(城市/晚数/模板)** + 导入 seed
│   │   ├── TripDetail.tsx   # **V6.0 双模式核心页**:✍️编辑(天卡片+地图) / 📖预览(大纲+宏观轨迹)
│   │   ├── DayTimeline.tsx  # 单日时间轴(核心编辑页)
│   │   ├── PoiSearch.tsx    # POI 检索(备用入口)
│   │   ├── PoiDetail.tsx    # 景点详情 + AI 卡片
│   │   ├── Bookkeeping.tsx  # 记账 + 预算 + 分摊
│   │   ├── TransportPage.tsx    # 大交通管理(V4.0 补完)
│   │   ├── HotelsPage.tsx       # 酒店管理 + 地图选点(V4.0 补完)
│   │   ├── StagedPage.tsx       # 暂存箱独立页(V4.0 补完)
│   │   ├── OptimizePage.tsx     # 优化结果确认页(V4.0 补完)
│   │   └── useOptimize.ts       # 单日优化 hook
│   ├── components/
│   │   ├── MapView.tsx      # 高德地图组件(基础封装)
│   │   ├── CreateWizard.tsx # **V6.0 三步创建向导**(城市→晚数→模板匹配)
│   │   └── TripPreview.tsx  # **V6.0 预览模式**(大纲+时间段+AI避坑卡+导航直达)
│   ├── stores/              # zustand 状态
│   │   ├── tripStore.ts
│   │   ├── dayStore.ts
│   │   ├── stagedStore.ts
│   │   ├── budgetStore.ts
│   │   └── wizardStore.ts   # V6.0 创建向导状态
│   ├── services/            # 数据与服务
│   │   ├── db.ts            # DAL 接口
│   │   ├── dexie.ts         # Dexie 实现(12 张表 + trip_templates)
│   │   ├── amap.ts          # 高德路径规划 + JS API PlaceSearch(含缓存)
│   │   ├── amapLoader.ts    # 高德 JS API 2.0 加载器 + PlaceSearch 插件加载
│   │   ├── llm.ts           # AI 卡片 5 层读取链(TokenHub)
│   │   ├── templates.ts     # V6.0 模板匹配 + content_json 解析套用
│   │   └── __tests__/dexie.test.ts
│   ├── utils/               # 平台无关核心逻辑
│   │   ├── time.ts          # 时间级联
│   │   ├── tsp.ts           # TSP 优化
│   │   ├── conflicts.ts     # 冲突预警
│   │   ├── boundary.ts      # Day 边界推导
│   │   ├── useOnlineStatus.ts
│   │   └── __tests__/       # 3 个测试文件(36 个单测)
│   ├── types/               # TS 类型 + Vite env 声明
│   └── seed.json            # 青甘大环线种子数据
└── .env / .env.example
```

---

## 4. 数据层设计

### 4.1 为什么 Web 用 IndexedDB 而非 SQLite

- SQLite 在 Web 需 WASM(sql.js),整库加载内存,复杂度高
- IndexedDB(Dexie)原生异步、性能足够(个人数据 < 万条)、索引健全
- **DAL 已抽象成接口**(`services/db.ts`),未来 RN 换 SQLite 只替换 `dexie.ts` 实现

### 4.2 Dexie 表定义

```ts
const db = new Dexie('travel_planner');
db.version(1).stores({
  trips: 'id, status',                 // V6.0:city_nodes 字段(JSON 数组)
  tripTemplates: 'id, cities, daysCount',  // V6.0 新增冷启动模板表
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
```

### 4.3 DAL 接口

```
listTrips / getTrip / createTrip(自动生成 days) / updateTrip / deleteTrip(级联)
listDays / getDay
listItems / addItem / updateItem / moveItem / removeItem
upsertPoi / getPoi / searchPois
listExpenses / addExpense / removeExpense / sumExpenses
getRouteCache / upsertRouteCache
getPoiCard / upsertPoiCard
listHotels / addHotel / updateHotel / removeHotel
listTransports / addTransport / updateTransport / removeTransport
getSetting / setSetting
addDay / removeDay(V5.0)

// V6.0 模板相关
listTemplates / getTemplate(id) / upsertTemplate(tpl) / removeTemplate(id)
// 创建向导中的 createTrip 需支持 cityNodes 参数
```

---

## 5. 核心服务设计

### 5.1 time —— `utils/time.ts`
```ts
cascadeTimes(start, [{visitMinutes, nextDurationMin}]) → [{arrive, leave}]
```
- 支持 24h+ 记号(跨午夜:`25:30`)

### 5.2 tsp —— `utils/tsp.ts`
```ts
solveTsp({count, duration}) → {order, totalDuration, exact}   // 单日闭环优化
solveOpenPath({count, duration}) → {order, totalDuration}      // 全局开放路径(起点固定,不回首)
savings(currentOrder, optimalOrder, duration) → 节省分钟          // 用于"是否已最优"判断
haversineKm(lng1,lat1,lng2,lat2) → km                            // 两点直线距离(粗算通勤)
```
- `solveTsp`:单日顺路,n≤8 Held-Karp / n>8 2-opt
- `solveOpenPath`:全局优化,**从固定起点出发、走完全部点、不返回起点**（供跨天防折返),n≤9 Held-Karp / n>9 2-opt
- 全局优化用直线距离粗算(40km/h),全程不额外调高德 API

### 5.3 全局顺路优化(酒店锚点)—— `pages/TripDetail.tsx`
```ts
handleGlobalOptimize()  → 提取每天酒店锚点 + 收集景点 → 起终点(酒店)选择面板
computeOptimizePreview() → 从起点酒店→所有景点→终点酒店 求最短开放路径(solveOpenPath)
                           + 每个景点按「最近酒店距离」归属到天 → 生成移动清单(不写库)
applyGlobalOptimize()  → 按移动清单把景点移到位(酒店不动) → 各天内部再顺路优化
copyOptimizedToNewTrip() → 复制优化结果到新旅程副本(当前行程不变)
```
- **酒店是固定锚点**,`itemType==='hotel'` 的项不参与收集、不参与移动、不占中间天槽位
- 景点归属规则:遍历所有酒店,取 haversine 距离最近的那家 → 归到该酒店所在天

### 5.4 conflicts —— `utils/conflicts.ts`
```ts
detectConflicts({items, spent, budget}) → Conflict[]
```
- 留白 < 通勤 + BUFFER_MIN 才触发(15=安全/14=预警)

### 5.4 amap —— `services/amap.ts` + `services/amapLoader.ts`

**路径规划(带缓存)**:
```ts
getDuration(from, to, mode) → {durationMin, distanceM}
```
- 缓存 key: `md5(lng0+lat0+lng1+lat1+mode)`, TTL 30 天
- 错误码:`MAP_QUOTA_EXCEEDED` / `NO_ROUTE`

**POI 搜索(JS API,免 Web Key)**:
```ts
searchPoiByJS(keyword, city) → PoiSearchResult[]
```
- 调用链:loadAMap → loadPlaceSearch → new AMap.PlaceSearch({city}) → .search(keyword, callback)
- 返回 `{id, name, address, lng, lat, type}`
- **注意**:JS API PlaceSearch 是回调式,已包装为 Promise

### 5.5 llm —— `services/llm.ts`
```ts
getPoiCard(poi, city) → PoiAiCard
```
- 5 层读取链:RAG → 缓存 → LLM(TokenHub) → 类型兜底 → 用户覆盖
- TokenHub 配置:`VITE_LLM_BASE_URL=https://tokenhub.tencentmaas.com/plan/v3`
- 模型:`deepseek-v4-flash`

---

## 6. 状态管理(zustand)

| Store | State | Actions |
| :--- | :--- | :--- |
| useTripStore | activeTripId, trips, online | openTrip / closeTrip / loadTrips / setOnline |
| useDayStore | dayId, items, conflicts, canUndo, _snapshot | loadDay / addItem / updateItem / removeItem / setVisitMinutes / recalcTimeline / optimize / undo |
| useStagedStore | staged: StagedPoi[] | addToStaged / removeFromStaged / clearStaged |
| useBudgetStore | (内联在 Bookkeeping 中) | — |
| useWizardStore(V6.0) | step(1|2|3), cities[], dates, nightAllocation, matchedTemplates | setCities / setDates / setNights / matchTemplates / applyTemplate / createEmpty |

**useWizardStore 关键逻辑**:
```
Night Allocation 校验:sum(nights) === daysTotal - 1,否则阻止进入 Step3
模板匹配:输入城市列表 → tripTemplates.where(cities) 模糊匹配 → 重合度排序
方案甲:applyTemplate(tpl) → 解析 content_json → 批量写入 trips/days/items/pois/hotels
方案乙:createEmpty() → 仅 createTrip + 天骨架,不写 items
```

---

## 7. 关键实现细节

### 7.0 双模式切换(V6.0) — TripDetail 顶层

```
const [mode, setMode] = useState<'editor' | 'viewer'>('editor')

<div>
  <Toggle>
    <button className={mode==='editor'?'active':''} onClick={→editor}>✍️ 编辑规划</button>
    <button className={mode==='viewer'?'active':''} onClick={→viewer}>📖 行程预览</button>
  </Toggle>
  {mode === 'editor' ? <EditorView/> : <ViewerPreview/>}
</div>
```

- `EditorView`:即 V5.0 原「唯一核心页」布局(天卡片+编辑面板+全量地图)
- `ViewerPreview`:全新 `TripPreview.tsx` 组件,只读渲染

### 7.0a 预览模式(TripPreview.tsx) — V6.0 新增

**组件职责**:只读、极简、大字、行中导向

```
TripPreview
├─ 左侧大纲(滚动)
│   └─ 每天卡片:
│       DAY N  城市 • 主题
│       交通: 🚗 自驾 340 公里(约4.5小时)     ← transports + 距离聚合
│       景点: A ─▶ B ─▶ C                     ← 隐藏分钟,时间段概念
│       住宿: 酒店名
│   └─ 时间段映射: arriveTime → 上午(<12) / 中午(12-14) / 下午(14-18) / 晚上(≥18)
├─ 右侧地图(宏观轨迹)
│   ├─ 粗 Polyline:城市中心点连线(线宽 5+,颜色按段)
│   ├─ Marker:仅 住宿地(🏨) + 大交通枢纽(✈/🚄)
│   └─ 无城市内部细节线
└─ 景点详情卡(点击展开)
    ├─ 大字景点名 + 开放时间 + 地址
    ├─ [复制地址] [高德导航直达]按钮     ← AMap 导航: uri.amap.com/navigation
    └─ AI 避坑卡常驻: pitfallGuide 精简2条大字显示
```

**时间段映射函数**(`utils/time.ts` 新增):
```ts
function timePeriod(time: string): '上午'|'中午'|'下午'|'晚上' {
  const h = toMinutes(time) / 60;
  return h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : '晚上';
}
```

**宏观轨迹构建**:
- 按 `trip.city_nodes` 顺序取每个城市的中心坐标(高德 geocode 或模板预置)
- 相邻城市画粗线,标注 `mode + 距离 + 时长`(从 transports 或 route_cache 取)

**导航直达**:`https://uri.amap.com/navigation?to=${lng},${lat},${name}&mode=car`

### 7.1 唯一核心页(TripDetail.tsx) — V5.0 合并方案(编辑模式下)

**架构**(左右分栏 + 可展开地图):
```
左侧面板(400px)                右侧地图(flex: 1)
├─ 顶部栏                     ├─ 高德暗色地图(amap://styles/dark)
│   └─ 日期调整+展开/收起按钮   ├─ 每天 Marker 按天着色
├─ 天卡片列表                  ├─ 每天实线连接
│   ├─ 天卡片(每张)            ├─ 跨天虚线
│   │   ├─ 主体(点击查看行程)    ├─ tempMarker(搜索候选高亮)
│   │   │   ├─ Day N · 日期     └─ 自动 fitView
│   │   │   ├─ POI 序列文本
│   │   │   └─ [+添加] 按钮(展开编辑)
│   │   ├─ 行程明细(折叠区)
│   │   │   ├─ POI 列表
│   │   │   ├─ [顺路优化] 按钮(V5.0)
│   │   │   └─ [删除此天] 按钮(V5.0)
│   │   └─ 编辑面板(3 Tab)
│   │       ├─ 景点 / 酒店 / 交通
│   │       └─ 搜索 → 选中 → 地图飞移 → 确认添加
└─ [+添加一天] 按钮(V5.0)
```

**状态管理**(全部内联在组件中,无需 zustand):
- `activeDayId`:当前激活编辑的天
- `activeTab`:scenic | hotel | transport
- `detailExpanded`/`editExpanded`:分别控制行程明细和编辑面板的展开
- `selectedScenic`/`selectedHotel`:选中候选
- `fromResult`/`toResult`:交通起终点
- `routeInfo`:交通查询结果
- `tempMarkerRef`:地图临时标记(搜索结果预览)

**V5.0 新增交互**:
- 点击天卡片主体 → 只展开行程明细(只读),不展开编辑
- 点击「+添加」按钮 → 才展开编辑面板(景点/酒店/交通 Tab)
- 再次点击主体 → 折叠全部
- **单日顺路优化**:取当天 POI 坐标 → 构建耗时矩阵 → solveTsp → 回写 order_seq
- **添加1天**:调用 db.addDay(tripId, date),daySeq 自动重排
- **删除某天**:调用 db.removeDay(dayId),items 级联删除,后续 daySeq 前移
- **景点级操作(V6.1)**:移除/改时长/改名 单景点

**地图覆盖物渲染(V6.1 修复)**:
- `renderMapOverlays()`:每次 `daySummaries` 变化时调用
- **用 `daySummariesRef`(ref) 读最新数据**——避免 `map.on('complete')` 与 `setTimeout` 兜底回调捕获旧的空闭包
- **用 `AMap.Marker` + `content` DOM 标记**(彩色圆圈+Day编号),替代 SVG base64 图标(在暗色主题不可见)
- 手动计算视野边界 `map.setBounds(sw,ne)`,替代 `setFitView`
- 事件触发:`map.on('complete')` + 1s 兜底;`daySummaries` 变化时延迟一帧重绘

### 7.2 单层快照撤销(useDayStore)

```
optimize():  save = serialize(items); set _snapshot
confirm():   apply newOrder; set _snapshot=null
undo():      apply(_snapshot); set _snapshot=null
```

### 7.4 缓存命中与配额保护

| 调用 | 缓存Key | 未命中动作 |
| :--- | :--- | :--- |
| getDuration | md5(lng0+lat0+lng1+lat1+mode) | 调高德 direction → 写库 |
| searchPoiByJS | 无(PlaceSearch 自带缓存) | JS API 内部处理 |
| getPoiCard | md5(poi_name+city) | LLM 生成 → 写入 poi_ai_cards |

---

## 8. 离线与弱网策略

| 场景 | 行为 |
| :--- | :--- |
| 行程浏览 | 全量本地(IndexedDB),无感离线 |
| 地图 | 高德瓦片正常走 CDN;离线显示最后缓存 |
| 搜索 | 离线无法搜索(需要联网调 JS API) |
| 卡片/路径 | 读缓存;未命中 → 空态 + 弱网提示条 |
| 记账 | 本地先写,`dirty=1`;联网后增量上行 |

---

## 9. 安全与 Key 管理

| 项 | 处理 |
| :--- | :--- |
| 高德 JS Key | 域名白名单(仅本地 dev + 部署域) |
| LLM Key(TokenHub) | `.env` 中 `VITE_LLM_API_KEY`;浏览器可见,个人自用 |
| 上架/分享前 | 必须改后端代理,Key 移服务端 |

---

## 10. 测试策略

| 层 | 工具 | 覆盖 |
| :--- | :--- | :--- |
| 纯函数 | Vitest | `utils/time`(含 timePeriod 时间段) `utils/tsp` `utils/conflicts` `utils/boundary` |
| 服务 | Vitest | Dexie CRUD、级联删除、templates 解析套用 |
| 组件 | 手动测试 | 创建向导 3 步流、双模式切换、预览模式 |
| 当前状态 | 36 个测试全部通过 | 4 个测试文件 |

---

## 11. 里程碑技术交付对照

| 阶段 | 技术交付物 | 状态 |
| :--- | :--- | :--- |
| M0 | Vite 工程 + Dexie 表 + Router | 完成 |
| M1 | utils/time + utils/boundary + 时间轴渲染 | 完成 |
| M2 | 高德 JS 地图 + PlaceSearch + 暂存箱 | 完成 |
| M3 | amap.getDuration + route_cache | 完成 |
| M4 | utils/tsp + useDayStore 快照撤销 + conflicts | 完成 |
| M5 | llm 5 层链路 + 缓存 | 完成 |
| M6 | 记账 + 分摊 + 弱网提示 | 完成 |
| M7 | 高德暗色地图 + seed 导入 | 完成 |
| M8 | 4 占位页面补完(Transport/Hotels/Staged/Optimize) | 完成 |
| M9 | **一站式地图编辑(景点/酒店/交通直接搜索添加)** | **完成** |
| M10 | **页面合并(V5.0):TripDetail+TripMap合二为一,折叠编辑+单日优化+日期调整** | **完成** |
| M11 | **创建向导+双模式(V6.0):三步向导、编辑/预览Toggle、预览宏观轨迹+AI避坑卡** | **完成** |
| M12 | **全局顺路优化·酒店锚点(V6.1):起终点选酒店、景点按最近酒店归位、预览确认/复制、单日时长统计、地图渲染修复** | **完成** |
| M13 | **五步引擎(V6.3):城市硬约束+逆地理+平摊+顺路+单测;UI(token+公共组件);拖拽(同天/跨天)** | **完成** |
| M13.1 | **坐标污染修复(V6.3.1):移除load自动修坐标;importSeed先删同名再导入** | **完成** |

---

*本文档与 PRD V6.3.1 配套,作为开发实现基线。*