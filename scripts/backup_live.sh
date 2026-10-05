#!/bin/bash
# travel 线上数据每日备份:从 travel-server 拉数据到本机 backups/daily/(每天一个 tar 包,保留 60 天)
# ⚠️ launchd 定时执行用的是 ~/.travel-scripts/backup_live.sh(同一份逻辑)。
#    launchd 下 macOS TCC 对 Desktop 只增不删,rsync/按日目录覆盖方案跑不通,故用每日新 tar 包。
#    手动执行任何一份都可以:bash scripts/backup_live.sh
# 用法: bash backup_live.sh   (可放入 launchd / WorkBuddy automation 每日执行)
set -euo pipefail
REMOTE="travel-server"
REMOTE_DIR="/opt/travel/server/data"
DAILY="$HOME/Desktop/codex/travel/backups/daily"
KEEP=60
TODAY=$(date +%Y%m%d)
OUT="$DAILY/travel-data-$TODAY.tar.gz"
TMP=$(mktemp /tmp/travel-data-XXXXXX.tar)

# 1) 服务器侧打包(排除 jwt_secret,避免本机留存服务器密钥)拉回 /tmp 暂存
ssh "$REMOTE" "cd '$REMOTE_DIR' && tar czf - --exclude='jwt_secret' ." > "$TMP"

# 2) 校验非空后落到 daily/(同日已存在则加时间后缀,不覆盖)
if [ ! -s "$TMP" ]; then echo "EMPTY_TAR $(date '+%F %T')"; rm -f "$TMP"; exit 1; fi
if [ -e "$OUT" ]; then OUT="$DAILY/travel-data-$TODAY-$(date +%H%M%S).tar.gz"; fi
mv "$TMP" "$OUT"

# 3) 清理 60 天前的旧包(launchd 下 TCC 拦删除,此条仅手动跑时生效)
find "$DAILY" -name 'travel-data-*.tar.gz' -mtime +$KEEP -delete 2>/dev/null || true

SIZE=$(du -h "$OUT" | cut -f1)
echo "BACKUP_DONE $(date '+%F %T')  file=$OUT  size=$SIZE"
