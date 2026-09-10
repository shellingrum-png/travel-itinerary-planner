# 腾讯云部署指南(travel)

> 目标:前端静态 + Node 后端 8766 + Nginx 反代 + HTTPS,公网可访问。数据经 Supabase 云同步,支持手机/多设备。

## 0. 前置检查
- 一台**腾讯云服务器**(大陆区需 ICP 备案;无备案用香港/海外区实例,80/443 免备案)
- 一个**域名**(解析到该服务器公网 IP);无域名可用 `http://<公网IP>:3000` 验证,但高德 JS Key 域名白名单需可用域名
- Node.js ≥ 18(server 用全局 `fetch`/ESM)
- python3

## 1. Supabase 云同步(跨设备数据互通)

### 1.1 建表
到 [supabase.com](https://supabase.com) 注册并**新建项目**(免费档即可),打开 **SQL Editor** 执行:

```sql
create table if not exists public.trips (
  id              text primary key,
  title           text,
  destination     text,
  start_date      text,
  end_date        text,
  status          text,
  total_budget    numeric,
  companion_count integer,
  currency        text,
  city_nodes      jsonb,
  snapshot        jsonb,          -- 整旅程快照(核心字段)
  user_id         text,           -- 归属账号(V10 多用户隔离)
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);
create index if not exists trips_user_id_idx on public.trips (user_id);
```

### 1.2 ⚠️ 必须开启 RLS 并撤销匿名权限

**这一步不能省。** Supabase 的 anon key 是**公开打进前端 bundle** 的(设计如此),
若表不设防,任何人拿到 anon key 就能**读/改/删你的全部数据** —— 绕过自建后端
的 `user_id` 隔离。后端的 `service_role` 带 `BYPASSRLS`,所以开了 RLS 应用照常工作。

```sql
alter table public.trips enable row level security;
revoke all on table public.trips from anon, authenticated;
```

验证(应返回 `rls_on=true` 且无 anon/authenticated 权限):
```sql
select relrowsecurity as rls_on from pg_class where relname = 'trips';
select grantee, privilege_type from information_schema.role_table_grants
  where table_name = 'trips' and grantee in ('anon','authenticated');
```

### 1.3 ⚠️ 关闭「邮箱确认」

**Authentication → Providers → Email → 关掉 `Confirm email`**
(或用 Management API:`PATCH /v1/projects/{ref}/config/auth` 传 `{"mailer_autoconfirm": true}`)

原因:Supabase 默认要求注册后点邮件确认,未确认时**签发的 user 对象没有 session**
→ 前端拿不到登录态,注册后会卡住。个人/家庭应用无需邮箱验证。

若已有账号停在未确认状态,手动激活:
```sql
update auth.users set email_confirmed_at = now()
  where email = 'xxx@qq.com' and email_confirmed_at is null;
```

### 1.4 填密钥
在项目 **Settings → API** 复制 `Project URL` / `anon(publishable)` / `service_role`,
分别填到:

| 值 | 填到 | 说明 |
|---|---|---|
| `Project URL` | `server/.env` 的 `SUPABASE_URL` **和** `.env.production` 的 `VITE_SUPABASE_URL` | 前后端都要 |
| `service_role` | `server/.env` 的 `SUPABASE_KEY` | ⚠️ 仅服务端,**绝不能进前端** |
| `anon(publishable)` | `server/.env` 的 `SUPABASE_ANON_KEY` **和** `.env.production` 的 `VITE_SUPABASE_ANON_KEY` | 公开无妨;后端用它校验登录 JWT |

> 说明:用 service_role(绕过 RLS)仅在服务端使用,勿放进前端 bundle。

## 2. 服务器初始化

> 当前实际环境为 **腾讯云 OpenCloudOS 9.4(RHEL/dnf 系)**,与下面 Ubuntu 示例不同:
> 包管理用 `dnf`;Node 没有 deb 源,建议直接下二进制包(见下)。

**Ubuntu/Debian 示例:**
```bash
# 安装 Node(>=18)与 python3(若已装可跳过)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs python3

# 安装 Nginx + certbot(Let's Encrypt)
sudo apt-get install -y nginx python3-certbot-nginx
```

**OpenCloudOS / RHEL 系:**
```bash
sudo dnf install -y python3 nginx
# Node 用二进制包(经 npmmirror 加速)
cd /tmp && curl -sLO https://npmmirror.com/mirrors/node/v20.18.1/node-v20.18.1-linux-x64.tar.xz
tar -xf node-v20.18.1-linux-x64.tar.xz && mv node-v20.18.1-linux-x64 /usr/local/
ln -sf /usr/local/node-v20.18.1-linux-x64/bin/{node,npm,npx} /usr/local/bin/
```

## 3. 部署代码
```bash
cd /home/youruser
git clone git@github.com:shellingrum-png/travel-itinerary-planner.git travel
cd travel
# 前端依赖 + 构建(读取 .env.production,/api 同源代理,已随仓库提交)
npm ci && npm run build
```
> `npm run build` 需要 `tsc --noEmit` 通过;产物 `dist/`。

> ⚠️ **`server/` 下必须有 `package.json`** 且含 `"type": "module"`。
> 后端用 ESM(`import ... from`),缺这个文件会报
> `SyntaxError: Cannot use import statement outside a module`。
> 若 `server/` 是单独拷到服务器(没跟着根目录),记得补:
> ```bash
> echo '{"name":"travel-server","private":true,"type":"module"}' > server/package.json
> ```

## 4. 配置后端 `server/.env`(gitignored,不入仓库)
```bash
cd /home/youruser/travel/server && cp ../.env.example .env && nano .env
```
填这些(**全部只在服务端**):
```bash
# 高德 Web 服务 Key(前端 /api/amap/place 代理用;高德开放平台申请)
AMAP_WEB_KEY=你的高德webkey

# AI 卡片上游(TokenHub / DeepSeek 二选一,与 .env 里 VITE_LLM_BASE_URL 保持一致的上游)
LLM_BASE_URL=https://tokenhub.tencentmaas.com/plan/v3
LLM_API_KEY=你的tokenhub/测key
LLM_MODEL=deepseek-v4-flash

# 云同步(§1)
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_KEY=service_role_key
# 校验登录 JWT 用(anon/publishable key)
SUPABASE_ANON_KEY=sb_publishable_xxx
```

## 5. 注册后端 systemd 服务 + 配 Nginx
```bash
sudo cp deploy/travel.service /etc/systemd/system/travel.service
sudo sed -i 's#/home/youruser/travel#/home/youruser/travel#g' /etc/systemd/system/travel.service  # 如路径不同
sudo systemctl daemon-reload && sudo systemctl enable --now travel
curl -s http://127.0.0.1:8766/api/health   # → {"ok":true,...}
```
```bash
# 配置 Nginx
sudo cp deploy/nginx.conf /etc/nginx/sites-available/travel
sudo sed -i 's/your-domain.com/你的域名/g; s/youruser/你的用户名/g' /etc/nginx/sites-available/travel
sudo ln -sf /etc/nginx/sites-available/travel /etc/nginx/sites-enabled/travel
sudo nginx -t && sudo systemctl reload nginx
```

### 5.1 无域名部署(裸 IP,当前线上形态)

线上是 `http://82.156.201.148/`,没有域名。此时:

- 用 `deploy/nginx.conf` 的变体:把 `server_name` 改成 `_`,`listen 80 default_server`
- 静态根指向实际部署路径(线上为 `/opt/travel/dist`)
- 腾讯云**安全组只放行 80**(其他端口默认被挡);服务器本身无 firewalld

```nginx
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    root /opt/travel/dist;
    index index.html;
    location / { try_files $uri $uri/ /index.html; }
    location /api/ {
        proxy_pass http://127.0.0.1:8766;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_read_timeout 60s;
    }
    location ~* \.(js|css|png|jpg|jpeg|gif|svg|woff2?)$ {
        expires 7d;
        add_header Cache-Control "public, max-age=604800, immutable";
    }
}
```

> ⚠️ **裸 IP + HTTP 的坑**:`http://纯IP` 不是浏览器的「安全上下文」,
> `crypto.randomUUID`、`navigator.clipboard` 等 API 会**不可用**
> (表现为本地 localhost 正常、上公网就崩)。代码里已做降级
> (见 `src/frontend/utils/uuid.ts`),但**根治需要 HTTPS**。

## 6. 配置 HTTPS
```bash
sudo certbot --nginx -d 你的域名
# 按提示选 redirect 到 https;certbot 会自动改写 nginx.conf
```

## 7. 高德控制台域名白名单(必须)
到 [高德开放平台](https://console.amap.com) → 应用 → 你的 JS Key → **域名白名单**里加入你的域名(如 `https://your-domain.com`)。否则地图/POI/逆地理在公网加载失败。(安全密钥 `securityJsCode` 也依赖此白名单。)

## 8. 部署/更新一次命令
```bash
cd /home/youruser/travel && chmod +x deploy/deploy.sh && ./deploy/deploy.sh
```

## 9. 验证
- 浏览器访问 `https://your-domain.com`
- 客户端(电脑) 新建旅程 → 等几秒(防抖) → 手机浏览器打开同一域名 → 应用打开时自动 `reconcile` 拉取/推送,应能看到同一旅程
- 概览页 `https://your-domain.com/trip/<id>/overview` → 看总花费/每日开车公里/住哪/当日景点
- LLM: `curl -X POST https://your-domain.com/api/llm/chat/completions -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"hi"}]}'`

## 常见问题
- **地图不显示**:检查 §7 高德域名白名单 是否含当前域名
- **跨设备不同步**:确认 `server/.env` 的 `SUPABASE_URL/KEY` 正确,且 `trips` 表已建;后端日志看 `snapSave` 是否成功
- **手机看不到数据**:公网后 IndexedDB 仍存各设备本地,靠云同步互通;先确认电脑端已自动备份(控制台 `[云同步] 推送 N 个`)
- **交通班次查询慢/失败**:python 抓取 12306/同程,偶发被风控;主流程(地图/排点/概览)不依赖它
- **注册后卡在「正在进入…」**:Supabase 邮箱确认没关(见 §1.3);已有账号可手动补确认
- **本地能跑、公网一片空白**:多半是核心 API 报错被吞掉。先开浏览器控制台看报错,再看
  nginx 访问日志(`/var/log/nginx/access.log`)确认前端实际请求的路径 —— 曾出现
  `/api/api/snapshot` 这类**重复前缀**(生产变量语义是「源站」而非「前缀」,见 `.env.production`)
- **换账号后数据串了 / 看到别人的旅程**:各账号数据按 userId 分库
  (`travel_planner__<userId>`);若迁移旧库后未销毁会导致继承,已修(迁移后
  `Dexie.delete` 旧库 + reconcile 清理继承数据)
