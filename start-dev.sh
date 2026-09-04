#!/bin/bash
# 一键启动前后端
# 后端:交通查询(8766)  前端:Vite(5173)
set -e
cd "$(dirname "$0")"

echo "🚀 启动后端(交通查询:8766)..."
(cd server && node index.js) &
BACK_PID=$!

echo "🚀 启动前端(Vite:5173)..."
npm run dev &
FRONT_PID=$!

trap "kill $BACK_PID $FRONT_PID 2>/dev/null" EXIT
echo ""
echo "✅ 前端: http://localhost:5173"
echo "✅ 后端: http://localhost:8766/api/health"
echo "   示例: http://localhost:8766/api/transport?mode=train&from=北京&to=上海&date=2026-09-10"
wait
