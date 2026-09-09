# 腾讯云部署指南(travel)

> 目标:前端静态 + Node 后端 8766 + Nginx 反代 + HTTPS,公网可访问。数据经 Supabase 云同步,支持手机/多设备。

## 0. 前置检查
- 一台**腾讯云服务器**(大陆区需 ICP 备案;无备案用香港/海外区实例,80/443 免备案)
- 一个**域名**(解析到该服务器公网 IP);无域名可用 `http://<公网IP>:3000` 验证,但高德 JS Key 域名白名单需可用域名
- Node.js ≥ 18(server 用全局 `fetch`/ESM)
- python3

## 1. Supabase 云同步(跨设备数据互通)
1. 到 [supabase.com](https://supabase.com) 注册并**新建项目**(免费档即可)
2. 打开 **SQL Editor**,执行建表:
```sql
-- trips 快照表(snapshot 为整旅程 jsonb;updated_at 用于冲突合并)
create table if not exists public.trips (
  id text primary key,
  title text,
  snapshot jsonb,
  updated_at timestamptz default now()
);
```
3. 在项目 **Settings → API** 复制 `Project URL` 和 `service_role` key
4. 填到服务器上的 `server/.env`(见 §4)

> 说明:用 service_role(绕过 RLS)仅在服务端使用,勿放进前端 bundle。

## 2. 服务器初始化
```bash
# 安装 Node(>=18)与 python3(若已装可跳过)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs python3

# 安装 Nginx + certbot(Let's Encrypt)
sudo apt-get install -y nginx python3-certbot-nginx
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
