#!/bin/bash
# travel 线上数据每日备份：从 travel-server 同步到本机双保险
# 用法: bash backup_live.sh   （可放入 launchd / WorkBuddy automation 每日执行）
set -euo pipefail

REMOTE="travel-server"
REMOTE_DIR="/opt/travel/server/data"
BASE="$HOME/Desktop/codex/travel/backups"
LIVE="$BASE/live"
SNAP="$BASE/snapshot-$(date +%Y%m%d)"

mkdir -p "$LIVE" "$SNAP"

# 1) 实时镜像到 live/（排除 jwt_secret，避免本机留存服务器密钥）
rsync -az --delete --exclude='jwt_secret' "$REMOTE:$REMOTE_DIR/" "$LIVE/"

# 2) 每日一份带日期的快照副本（不被 --delete 冲掉，保留历史）
rsync -az "$LIVE/" "$SNAP/"

# 3) 统计报告
COUNT=$(find "$LIVE" -type f | wc -l | tr -d ' ')
SIZE=$(du -sh "$LIVE" 2>/dev/null | cut -f1)
echo "BACKUP_DONE $(date '+%F %T')  files=$COUNT  size=$SIZE  live=$LIVE  snap=$SNAP"
