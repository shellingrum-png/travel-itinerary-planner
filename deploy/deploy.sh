#!/usr/bin/env bash
# travel 一键部署脚本(在服务器上执行,需在项目根目录运行)
# 流程:拉代码 → 装依赖 → 构建前端 → 用 systemd 重启后端
# 前置:仓库已 clone 到该机,且 deploy/travel.service 已注册、Nginx 已指向 dist
set -euo pipefail

cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"

echo "🔍 当前目录: $APP_DIR"

echo "⬇️  拉取最新代码..."
git pull --ff-only

echo "📦 安装前端依赖..."
npm ci

echo "🛠  构建前端(tsc + vite build)..."
npm run build   # 产物 dist/,读取 .env.production(/api 同源代理)

echo "🐍 后端 Python 依赖(12306/同程查询)..."
# server/scripts/providers 走 urllib 标准库;若需第三方依赖,在此 pip install -r
python3 -c "import sys; sys.path.insert(0, 'server'); import importlib.util as u; print('transport_service OK' if u.find_spec('providers') else 'providers 缺失')" || true

echo "♻️  重启后端(Node 8766)..."
sudo systemctl restart travel

echo "✅ 部署完成。前端已更新,后端已重启。"
echo "   检查: curl -s http://127.0.0.1:8766/api/health"
echo "   Nginx: 浏览器访问 https://your-domain.com (需提前配好域名+证书)"
