# 接口设计

## 1. 外部依赖

| 依赖 | 用途 | 鉴权 | 配额提示 |
| :--- | :--- | :--- | :--- |
| 高德 JS API | 地图渲染、POI 搜索(PlaceSearch)、路径规划(Driving/Walking/Transfer) | JS Key + 安全密钥 | JS Key 有日配额 |
| LLM(TokenHub) | AI 景点卡片 | Bearer Token | 按 token 计费,必须幂等缓存 |
| (可选)Supabase | 云同步 | anon/public key | 免费层够用 |

> ⚠️ **Key 管理**:V1 前端直连,Key 存前端 `.env` 并 gitignore;上架前必须改后端代理。

---

## 2. 高德接口

### 2.1 POI 搜索(JS API — 免 Web 服务 Key)

**方式**:通过高德 JS API 内置 `AMap.PlaceSearch` 插件
```js
AMap.plugin('AMap.PlaceSearch', () => {
  const ps = new AMap.PlaceSearch({ city: '西宁', pageSize: 20 });
  ps.search('塔尔寺', (status, result) => {
    // status === 'complete' 时 result.poiList.pois 为结果数组
  });
});
```

**返回字段**:
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| id | string | POI ID |
| name | string | 名称 |
| address | string | 地址 |
| location | LngLat | 经纬度对象(.lng / .lat) 或字符串 "lng,lat" |
| type | string | POI 类型分类 |

**为何不用 Web 服务**:用户的 Key 为 JS API 类型,Web 服务调用返回 `USERKEY_PLAT_NOMATCH`(10009)。JS API PlaceSearch 无需额外申请 Web 服务 Key。

### 2.2 路径规划(JS API)

**驾车**:
```js
const driving = new AMap.Driving();
driving.search([fromLng, fromLat], [toLng, toLat], (status, result) => {
  // result.routes[0].time(秒) / result.routes[0].distance(米)
});
```

**步行**: `AMap.Walking`
**公交**: `AMap.Transfer`

### 2.3 路径规划(JS API 插件 — 有缓存层)

`services/amap.ts` 的 `getDuration()` 使用高德 **JS API 内置插件**驱动(免 Web 服务 Key),优先命中 `route_cache`:
```
loadRoutePlanner(mode) → AMap.Driving / AMap.Walking / AMap.Transfer
planner.search(from, to, callback) → {time(秒), distance(米)}
```
- 驾车:`AMap.Driving`;步行:`AMap.Walking`;公交:`AMap.Transfer`
- 返回 `first.time / 60` → 换算 `route_cache.duration_min`
- 查询失败返回保守默认值(步行45/驾车30/公交60分钟),不阻塞操作
- 全程不走 Web 服务 API,不受 Key 类型限制(`USERKEY_PLAT_NOMATCH` 已消除)

---

## 3. 缓存键约定

| 缓存表 | key 算法 | TTL |
| :--- | :--- | :--- |
| `route_cache` | `md5(lng0+lat0+lng1+lat1+mode)` | 30 天 |
| `poi_ai_cards` | `md5(poi_name + city)` | 永久 |

---

## 4. LLM 生成景点卡片

### 4.1 配置

```env
VITE_LLM_BASE_URL=https://tokenhub.tencentmaas.com/plan/v3
VITE_LLM_API_KEY=sk-tp-xxx
VITE_LLM_MODEL=deepseek-v4-flash
```

### 4.2 Prompt 模板

```
你是旅行规划助手。为景点生成结构化卡片,只输出 JSON,不要多余文字:
{
  "recommend_reason": "推荐原因 2-3 句",
  "pitfall_guide": "避坑指南 2-3 条",
  "suggest_duration": 120,
  "tips": ["...","..."],
  "rating": 4.5
}
景点:{name},城市:{city}
信息求稳不求新,不确定的写"建议到店确认"。
时长需考虑景点类型与淡旺季,输出整数分钟。
```

### 4.3 5 层读取链

```ts
async function getPoiCard(poi, city):
  // 第 1 层:RAG 攻略库(静默跳过)
  if (rag.enabled()) { ... }

  // 第 2 层:AI 卡片缓存
  const key = md5(poi.name + city);
  const cached = await db.getPoiCardByKey(key);
  if (cached) return cached;

  // 第 3 层:LLM 生成
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, temperature: 0.3,
      messages: [{ role: 'user', content: buildPrompt(poi.name, city) }],
      response_format: { type: 'json_object' },
    }),
  });
  const content = JSON.parse(data.choices[0].message.content);

  // 写入缓存
  await db.upsertPoiCard({ poiId: poi.id, cacheKey: key, ...content });
  return card;
```

---

## 5. 内部模块接口

| 方法 | 说明 |
| :--- | :--- |
| `tripsAPI.list()` | 旅程列表 |
| `tripsAPI.create({title, dates, budget})` | 新建旅程并自动生成 `itinerary_days` |
| `daysAPI.getItems(dayId)` | 拉某日全部 nodes |
| `itemsAPI.move(dayId, itemId, newOrder)` | 拖拽排序 |
| `itemsAPI.setTransport(dayId, itemId, mode)` | 改出行方式 → 触发路径计算 |
| `routeAPI.duration(a, b, mode)` | 有缓存读缓存,无则调高德 |
| `optimizeAPI.reorder(dayId)` | 一键 TSP 重排 |
| `expensesAPI.sum(tripId)` | 已花合计 → 预算条 |

### 5b. 后端服务接口(`server/index.js`,端口 8766,V9.0 扩展)

| 接口 | 说明 |
| :--- | :--- |
| `GET /api/health` | 健康检查 |
| `GET /api/transport?mode=&from=&to=&date=` | 高铁/航班班次查询(python) |
| `PUT/GET/DELETE /api/snapshot/:tripId` | 旅程快照备份/恢复(存 Supabase `trips.snapshot`,**需登录**) |
| `GET /api/snapshot` | 快照列表 `[{id, updatedAt}]`(**需登录**,仅返回当前用户) |

> **多用户鉴权(V10)**：`/api/snapshot*` 全部需 `Authorization: Bearer <Supabase access_token>`。后端用 `GET /auth/v1/user` 校验 token 拿 `user_id`,所有快照按 `user_id=eq.` 过滤;首次登录的首个账号会自动收养历史未归属数据。未带 token → `401`。
| `POST /api/llm/chat/completions` | **LLM 代理**(key 在服务端,前端零泄露) |
| `GET /api/amap/place?keywords=&city=` | **高德 Web 服务代理**(key 在服务端) |

> 公网部署时前端 `.env.production` 把这些指向同源 `/api`(`VITE_LLM_BASE_URL=/api/llm`、`VITE_AMAP_PROXY=/api`),Nginx 反代到 8766。本地开发直接走原上游。

---

## 6. 错误码约定

| code | 含义 | 前端处理 |
| :--- | :--- | :--- |
| `MAP_QUOTA_EXCEEDED` | 高德配额超限 | 提示"地图服务繁忙",降级只读 |
| `USERKEY_PLAT_NOMATCH` | Key 类型不匹配 | 改用 JS API 替代 Web 服务 |
| `LLM_TIMEOUT` | AI 生成超时 | 用模板占位 |
| `OFFLINE` | 离线 | 走缓存;无缓存则黄条提示 |
| `NO_ROUTE` | 无可行路线 | 改推荐其他出行方式 |