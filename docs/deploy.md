# Наш сервер (kalki-server)

Как развёрнут herald у нас — пример; общая инструкция — [install.md](install.md).

| Что | Где |
|---|---|
| Код | `/srv/herald` (git clone, ветка `main`) |
| Секреты | `/srv/herald/.env` (600): `HERALD_BOT_TOKEN`, `HERALD_TOKENS`, `HERALD_PEOPLE` — Bun читает его сам; прочие переменные — `docs/model.md`, «Сервер» |
| БД | `/srv/herald/data/herald.db` (SQLite, WAL) |
| Процесс | pm2 `herald`: `bun src/server/main.ts`, слушает `127.0.0.1:4518` (chronicle — 4517) |
| Публикация | nginx `/etc/nginx/sites-available/herald.u7-hub.kz` → `https://herald.u7-hub.kz` (сертификат certbot) |
| Бэкап | нет (решение 2026-11-16): в БД только оперативные сессии, вопросы и входящие; `backup.contract` нет — backup-orchestrator и offsite-backup herald не видят |
| Мониторинг | health-check server-ops, только «жив»: `HEALTH_INTERNAL_SERVICES` в `~/server-ops/config/common.env` (порт 4518 слушается, pm2 `herald` online) |
| Клиент на сервере | `~/.config/herald/config.json` (`serverUrl: http://127.0.0.1:4518`, `host: kalki-server`), `~/.local/bin/herald` |

Telegram опрашивает только этот процесс (long polling): второй экземпляр с тем же ботом получит `409 Conflict` — сервер должен быть один.

Токены: по одному на контур (ноутбук, сервер), каждый сопоставлен человеку — любой можно отозвать, убрав из `HERALD_TOKENS` и перезапустив процесс (`pm2 restart herald --update-env`).

## Первая установка

```bash
ssh kalki_server
git clone https://github.com/recode-ak/herald.git /srv/herald && cd /srv/herald
install -m 600 /dev/null .env && $EDITOR .env      # HERALD_BOT_TOKEN, HERALD_TOKENS, HERALD_PEOPLE
bash scripts/deploy.sh                              # зависимости, pm2 start, проверка /health
```

nginx (sudo) — `/etc/nginx/sites-available/herald.u7-hub.kz`, затем `ln -s` в `sites-enabled`, `nginx -t && systemctl reload nginx`, `certbot --nginx -d herald.u7-hub.kz`:

```nginx
server {
    listen 80;
    server_name herald.u7-hub.kz;

    location / {
        proxy_pass http://127.0.0.1:4518;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        # long poll: сервер держит запрос до HERALD_MAX_WAIT_SECONDS (50 с)
        proxy_read_timeout 90s;
    }
}
```

## Обновление

```bash
ssh kalki_server
cd /srv/herald && bash scripts/deploy.sh
```

`git pull` → `bun install --production --frozen-lockfile` → `pm2 restart` → `/health`. Ждущие long poll при перезапуске обрываются — клиенты переподключаются сами.

## Оговорки

- Bun на сервере — 1.4.x, как у разработчика: `bun.lock` читается, установка строго по нему. Обновлять Bun на сервере — вместе с остальными сервисами.
- В неинтерактивной ssh-сессии нет `~/.local/bin` и `~/.bun/bin` в PATH — вызывать через `bash -ic` или по полным путям.
- Автозапуск pm2 после перезагрузки сервера не настроен (общая особенность сервера).
