#!/usr/bin/env bash
# PiNovelStudio PostgreSQL 备份
BACKUP_DIR="/root/PiNovelStudio/platform/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
docker exec platform-postgres pg_dump -U postgres platform > "$BACKUP_DIR/platform_pg.bak.$TIMESTAMP.sql"
# 保留最近 7 天
find "$BACKUP_DIR" -name "platform_pg.bak.*" -mtime +7 -delete
