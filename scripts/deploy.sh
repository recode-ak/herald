#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# deploy.sh — обновление herald на сервере (запускать в /srv/herald).
#
# Шаги: снимок БД pre-deploy → git pull → зависимости по bun.lock → pm2 restart → health.
# Первый запуск (процесса в pm2 ещё нет) — pm2 start.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
export PATH="${HOME}/.bun/bin:${PATH}"
PORT="$(grep -E '^HERALD_PORT=' .env 2>/dev/null | cut -d= -f2 || true)"
PORT="${PORT:-4518}"

if [ -f data/herald.db ]; then
  bash scripts/backup.sh pre-deploy --force
fi

git pull --ff-only
bun install --production --frozen-lockfile

if pm2 describe herald >/dev/null 2>&1; then
  pm2 restart herald --update-env
else
  pm2 start "bun src/server/main.ts" --name herald --cwd "$PROJECT_ROOT"
  pm2 save
fi

for _ in 1 2 3 4 5; do
  sleep 1
  if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null; then
    echo "✅ herald обновлён: $(git log --oneline -1)"
    exit 0
  fi
done
echo "❌ herald не отвечает на /health — pm2 logs herald" >&2
exit 1
