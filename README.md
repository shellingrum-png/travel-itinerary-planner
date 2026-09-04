# 旅行行程规划助手 (Travel Itinerary Planner)

轻量级个人旅行行程规划工具:地图可视化 + 结构化时间轴 + 智能路径计算 + 行中记账。Web(H5)验证优先,后续可套壳 Taro(微信小程序)或 React Native。

## 核心功能

- **三步创建向导**:城市/天数 → 城际晚数分配 → 模板匹配(青甘大环线经典一键套用)
- **双模式切换**:`✍️编辑规划`(地图选点/顺路优化)/ `📖行程预览`(极简大字+AI避坑卡+导航直达)
- **全局顺路优化·酒店锚点**:起点=第一晚酒店、终点=最后一晚酒店,景点按「最近酒店」归位,酒店固定不动;支持预览确认/复制到新行程
- **单日行程时长统计**:路上时长 + 游览时长
- **AI 景点卡片**:推荐理由 / 避坑指南 / 建议时长(TokenHub deepseek-v4-flash)
- **记账**:预算 / 人均 / 分摊

## 快速开始

```bash
# 1. 克隆仓库
git clone <repo-url> travel && cd travel

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp .env.example .env   # 填入高德 Key / LLM Key(见 docs/API.md)

# 4. 启动开发服务器
npm run dev
```

## 文档导航

| 文档 | 说明 |
| :--- | :--- |
| [docs/PRD.md](docs/PRD.md) | 产品需求文档(V6.1 全局顺路优化·酒店锚点版) |
| [docs/TECH_DESIGN.md](docs/TECH_DESIGN.md) | **技术方案**(选型/架构/服务/测试/里程碑对照) |
| [docs/ROADMAP.md](docs/ROADMAP.md) | MVP 里程碑与排期 |
| [docs/DB_SCHEMA.md](docs/DB_SCHEMA.md) | 数据模型与建表 SQL |
| [docs/API.md](docs/API.md) | 外部接口对接与内部接口约定 |
| [docs/WIREFLOW.md](docs/WIREFLOW.md) | 页面流程与状态机 |

## 目录结构

```
travel/
├── docs/                  # 全部文档
│   ├── PRD.md             # 主产品需求文档
│   ├── TECH_DESIGN.md     # 技术方案
│   ├── ROADMAP.md         # 里程碑与验收
│   ├── DB_SCHEMA.md       # 数据模型
│   ├── API.md             # 接口设计
│   └── WIREFLOW.md        # 页面流程
├── config/                # 前端常量
├── src/
│   ├── frontend/          # Web(H5) 前端
│   │   ├── pages/         # 页面
│   │   ├── components/    # 复用组件
│   │   ├── stores/        # 状态管理(zustand)
│   │   ├── services/      # API 与本地库服务
│   │   ├── utils/         # 平台无关核心逻辑(时间级联/TSP/冲突/边界推导)
│   │   └── types/         # TS 类型
│   └── utils/             # 跨端共用工具
└── .env.example
```

## 技术栈

- **前端**:React 18 + TypeScript + Vite
- **状态管理**:zustand
- **路由**:React Router v6
- **本地存储**:IndexedDB(Dexie.js)
- **地图**:高德 JS API 2.0(PlaceSearch 搜索 / Driving·Walking·Transfer 路线规划,**全程免 Web 服务 Key**)
- **AI 卡片**:TokenHub 腾讯云大模型(deepseek-v4-flash)
- **可选同步**:Supabase

> ⚠️ 高德与 LLM 均收费,务必在本地做缓存,见 PRD §6.2。