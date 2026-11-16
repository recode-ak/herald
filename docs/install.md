# Установка herald

Сервер — один на всех (наш — [deploy.md](deploy.md)); клиент — на каждой машине с агентами. Команды CLI и инструменты канала — `docs/model.md`.

## Сервер

Нужны Bun ≥ 1.4, бот из BotFather и chat_id получателей (напиши боту `/start`, затем `curl -s https://api.telegram.org/bot<токен>/getUpdates` — поле `message.chat.id`; пока сервер не запущен).

```sh
git clone <репо herald> herald && cd herald
bun install --production --frozen-lockfile
install -m 600 /dev/null .env && $EDITOR .env
bun src/server/main.ts                          # «herald слушает http://127.0.0.1:4518/»
```

`.env` — минимум три строки (все переменные — `docs/model.md`, «Сервер»):

```sh
HERALD_BOT_TOKEN=123456:ABC…
HERALD_TOKENS=nur:<длинный случайный токен>,nur:<токен второй машины>
HERALD_PEOPLE=nur:<chat_id>
```

Токен агента — любая длинная случайная строка (`openssl rand -hex 24`). Постоянная работа — менеджер процессов (`pm2 start "bun src/server/main.ts" --name herald --cwd <herald>`), публикация наружу — reverse proxy с `proxy_read_timeout` больше `HERALD_MAX_WAIT_SECONDS` (по умолчанию 50 с). Проверка — `curl -s http://127.0.0.1:4518/health`. Пример целиком (pm2, nginx, бэкап, обновление) — [deploy.md](deploy.md).

Сервер с ботом должен быть один: Telegram отдаёт апдейты одному опрашивающему.

## Клиент: CLI `herald`

Нужны Bun ≥ 1.3 и git.

```sh
git clone <репо herald> ~/dev/tools/herald && cd ~/dev/tools/herald
bun install --production
bun run link                                   # → ~/.local/bin/herald
mkdir -p ~/.config/herald && printf '{"serverUrl":"https://herald.u7-hub.kz","token":"<токен>","host":"<имя машины>"}\n' > ~/.config/herald/config.json
herald notify "herald подключён"               # проверка: сообщение пришло в Telegram
```

Токен выдаёт владелец сервера (строка `HERALD_TOKENS`); `host` — короткое имя машины, его видно в шапке `[host · проект]`. Права на файл с токеном — `chmod 600 ~/.config/herald/config.json`.

## Канал для Claude Code

Канал — MCP-сервер `src/channel/main.ts` (stdio) с capability `claude/channel`: сообщения из Telegram приходят прямо в сессию, у агента есть инструменты `reply`/`notify`, `ask`, `decide`, `status`. Настройки — те же, что у CLI (`~/.config/herald/config.json`).

**1. Зарегистрировать MCP-сервер** — для всех проектов (`~/.claude.json`):

```sh
claude mcp add --scope user herald -- bun ~/dev/tools/herald/src/channel/main.ts
```

или в одном проекте — `.mcp.json` в корне:

```json
{
  "mcpServers": {
    "herald": { "command": "bun", "args": ["/home/<я>/dev/tools/herald/src/channel/main.ts"] }
  }
}
```

**2. Запускать Claude Code с каналом.** Channels — research preview; свой канал (не из маркетплейса) включается флагом при каждом запуске:

```sh
claude --dangerously-load-development-channels server:herald
```

Без флага сервер работает как обычный MCP: инструменты есть, но сообщения из Telegram в сессию не приходят — их можно забрать `herald inbox`.

**3. Разрешить инструменты без вопросов** (по желанию) — в `permissions.allow` настроек Claude Code: `mcp__herald__reply`, `mcp__herald__notify`, `mcp__herald__ask`, `mcp__herald__decide`, `mcp__herald__status`.

### Переменные окружения канала

Задаются в `env` записи MCP-сервера (`claude mcp add … -e ИМЯ=значение` или `"env": {…}` в `.mcp.json`).

| Переменная | Смысл |
|---|---|
| `HERALD_SESSION` | явное имя сессии вместо корня git (`[host · имя]`) |
| `HERALD_PERMISSION_RELAY=1` | подтверждение действий Claude Code из Telegram: запрос разрешения приходит вопросом «Разрешить / Запретить». По умолчанию выключено |
| `HERALD_URL`, `HERALD_TOKEN`, `HERALD_HOST`, `HERALD_CONFIG` | переопределить настройки клиента |

### Ограничения research preview

- Протокол Channels может измениться — тогда правится только `src/channel` (CLI и сервер не затронуты).
- Сессия определяется по каталогу запуска Claude Code (корень git) — тот же ключ, что у `herald` в этом каталоге: CLI и канал делят входящие одной сессии.
- Событие приходит на ближайшем шаге агента; если сессия простаивает, оно ждёт следующего хода. Запасной путь — `herald inbox`.
- Вопросы-подтверждения живут в процессе канала: после перезапуска Claude Code ответ на старый запрос придёт обычным событием `answer`.
- Логи канала — только в stderr (stdout занят MCP).
