# Установка herald

Сервер — один на всех (наш — [deploy.md](deploy.md)); клиент — на каждой машине с агентами. Команды CLI и инструменты канала — `docs/model.md`.

## Сервер

Нужны Bun ≥ 1.4, бот из BotFather и chat_id получателей (напиши боту `/start`, затем `curl -s https://api.telegram.org/bot<токен>/getUpdates` — поле `message.chat.id`; пока сервер не запущен).

```sh
git clone https://github.com/recode-ak/herald.git herald && cd herald
bun install --production --frozen-lockfile
install -m 600 /dev/null .env && $EDITOR .env
bun src/server/main.ts                          # «herald слушает http://127.0.0.1:4518/»
```

`.env` — минимум три строки (все переменные — `docs/model.md`, «Сервер»):

```sh
HERALD_BOT_TOKEN=123456:ABC…
HERALD_TOKENS=nur:<длинный случайный токен>,nur:<токен второй машины>
HERALD_PEOPLE=nur:<chat_id>
HERALD_TIME_ZONE=Asia/Oral        # пояс, в котором человеку показан срок вопроса (по умолчанию — пояс системы)
```

Токен агента — любая длинная случайная строка (`openssl rand -hex 24`). Постоянная работа — менеджер процессов (`pm2 start "bun src/server/main.ts" --name herald --cwd <herald>`), публикация наружу — reverse proxy с `proxy_read_timeout` больше `HERALD_MAX_WAIT_SECONDS` (по умолчанию 50 с). Проверка — `curl -s http://127.0.0.1:4518/health`. Пример целиком (pm2, nginx, обновление) — [deploy.md](deploy.md).

Сервер с ботом должен быть один: Telegram отдаёт апдейты одному опрашивающему.

Очистка базы по сроку хранения (14 дней) сама не запускается. Поставь её в cron раз в сутки, например: `30 3 * * * cd <herald> && ~/.bun/bin/bun run purge >> data/purge.log 2>&1`. В cron урезан PATH, поэтому путь к Bun полный. Правила и вывод — `docs/model.md`, «Хранение».

## Клиент: CLI `herald`

Нужны Bun ≥ 1.3 и git.

```sh
git clone https://github.com/recode-ak/herald.git ~/dev/tools/herald && cd ~/dev/tools/herald
bun install --production
bun run link                                   # → ~/.local/bin/herald
mkdir -p ~/.config/herald && printf '{"serverUrl":"https://herald.u7-hub.kz","token":"<токен>","host":"<имя машины>"}\n' > ~/.config/herald/config.json
herald notify "herald подключён"               # проверка: сообщение пришло в Telegram
```

Токен выдаёт владелец сервера (строка `HERALD_TOKENS`); `host` — короткое имя машины, его видно в шапке `[host · проект]`. Права на файл с токеном — `chmod 600 ~/.config/herald/config.json`.

## Канал для Claude Code

Канал — MCP-сервер `src/channel/main.ts` (stdio) с capability `claude/channel`: сообщения из Telegram приходят прямо в сессию, у агента есть инструменты `reply`/`notify`, `ask` (и пачкой), `decide`, `answered`, `to_terminal`, `status`, `title`. Настройки — те же, что у CLI (`~/.config/herald/config.json`).

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

Без флага Claude Code молча отбрасывает события канала. Канал видит это по аргументам Claude Code и переходит в режим без событий: указания и ответы ждут в ящике, агент забирает их инструментом `inbox`, в Telegram при старте приходит «⚠️ Окно запущено без канала…». Подробно — `docs/model.md` «Канал».

Чтобы не набирать флаг, — функция в `~/.bashrc` (подкоманды и `-p` — без флага):

```sh
claude() {
  case "$1" in
    mcp|config|plugin|plugins|update|doctor|install|setup-token|-p|--print|-v|--version|-h|--help) command claude "$@" ;;
    *) command claude --dangerously-load-development-channels server:herald "$@" ;;
  esac
}
```

С флагом Claude Code при каждом запуске спрашивает подтверждение dev-канала — один Enter. Включить канал в настройках нельзя: только флагом (2.1.325).

**3. Разрешить инструменты без вопросов** (по желанию) — в `permissions.allow` настроек Claude Code: `mcp__herald__reply`, `mcp__herald__notify`, `mcp__herald__ask`, `mcp__herald__decide`, `mcp__herald__answered`, `mcp__herald__to_terminal`, `mcp__herald__status`, `mcp__herald__title`, `mcp__herald__inbox`.

### Переменные окружения канала

Задаются в `env` записи MCP-сервера (`claude mcp add … -e ИМЯ=значение` или `"env": {…}` в `.mcp.json`).

| Переменная | Смысл |
|---|---|
| `HERALD_SESSION` | явное имя сессии вместо корня git (`[host · имя]`) |
| `CLAUDE_CODE_SESSION_ID` | ставит Claude Code; окно сессии канала — по pid Claude Code (`[host · проект·k3f9]`), см. `docs/model.md` «CLI» |
| `TMUX_PANE` | ставит tmux: панель окна, куда канал набирает `/clear` и `/compact` из Telegram. Claude Code не в tmux — эти команды не выполняются |
| `HERALD_CHANNEL_EVENTS=1\|0` | режим явно: `1` — события, `0` — без событий (по умолчанию — по флагам Claude Code) |
| `HERALD_PERMISSION_RELAY=1` | подтверждение действий Claude Code из Telegram: запрос разрешения приходит вопросом «Разрешить / Запретить». По умолчанию выключено |
| `HERALD_URL`, `HERALD_TOKEN`, `HERALD_HOST`, `HERALD_CONFIG` | переопределить настройки клиента |

### Ограничения research preview

- Протокол Channels может измениться — тогда правится только `src/channel` (CLI и сервер не затронуты).
- Сессия определяется по каталогу запуска Claude Code (корень git) — тот же ключ, что у `herald` в этом каталоге: CLI и канал делят входящие одной сессии.
- Событие приходит на ближайшем шаге агента; если сессия простаивает, оно ждёт следующего хода. Запасной путь — `herald inbox`.
- Claude Code уже предлагает серверу новую ревизию MCP (`server/discover`); на ней события канала он отключает («no unsolicited notification path»). Пока SDK отвечает на старой ревизии — работает; при обновлении SDK проверить.
- Вопросы-подтверждения живут в процессе канала: после перезапуска Claude Code ответ на старый запрос придёт обычным событием `answer`.
- Логи канала — только в stderr (stdout занят MCP).

## Самосброс агента: хуки Claude Code

`herald self` (`docs/model.md` «Самосброс») узнаёт о конце хода и сброса от хуков. В `~/.claude/settings.json` (для всех проектов):

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "$HOME/.local/bin/herald hook" }] }],
    "SessionStart": [
      { "matcher": "clear|compact", "hooks": [{ "type": "command", "command": "$HOME/.local/bin/herald hook" }] }
    ]
  }
}
```

Хук работает только в tmux (`TMUX_PANE`), ничего не печатает и всегда завершается с кодом 0 — окну не мешает. Claude Code должен быть запущен в tmux; без хуков `herald self` работает только с `--delay`.

Новые окна агентов (`herald spawn`) открываются в tmux-сессии `agents` — `tmux attach -t agents`. Нужен tmux ≥ 3.0 (команда окна — без shell) и `claude` в `PATH`.

## Демон машины: окна по `/new`

`herald host` (`docs/model.md` «Демон машины») открывает окна агентов по `/new` из бота, когда активных агентов нет. Нужны CLI с настройками (выше), tmux ≥ 3.0 и `claude` в `PATH`. Ставится службой `systemd --user` — unit пишется из оболочки, чтобы `PATH` был тот же, что в ней (`herald` — скрипт Bun, окнам нужен `claude`):

```sh
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/herald-host.service <<EOF
[Unit]
Description=herald host — окна агентов по /new из Telegram

[Service]
ExecStart=%h/.local/bin/herald host
WorkingDirectory=%h
Environment="PATH=$PATH"
Restart=on-failure
RestartSec=10
# tmux-сервер, запущенный демоном, — в cgroup службы: иначе её стоп или перезапуск закроет окна агентов.
KillMode=process

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now herald-host
journalctl --user -u herald-host -f        # журнал: «herald host: машина <host>…; жду запусков»
```

- Окна — в tmux-сессии `agents` того же tmux-сервера, что у оболочки (сокет по умолчанию): `tmux attach -t agents`. Сервера нет — его поднимает первое окно (`new-session`).
- `PATH` сменился (новый bun, claude) — пересоздать unit той же командой, затем `systemctl --user daemon-reload && systemctl --user restart herald-host`.
- Неверный токен — код 1, `Restart=on-failure` перезапускает раз в 10 с; причина — в журнале.
- **Linger не включается:** служба живёт, пока ты вошёл в систему (есть хоть одна сессия); после выхода `systemd --user` останавливается вместе с демоном. Работа без входа — `loginctl enable-linger` — вне рамок.

## Расширение для pi

Пакет `integrations/pi`: на время сессии pi сообщения из Telegram (указания, поздние ответы) приходят в сессию сами, `/clear` и `/compact` из Telegram выполняются, сессия видна в `/sessions`, пока pi открыт. Настройки — те же, что у CLI; CLI в bash этой сессии pi пишет в тот же ящик (`PI_SESSION_ID`). Подробности — `docs/model.md` «Расширение pi».

В `~/.pi/agent/settings.json` → `packages` добавить путь к `<herald>/integrations/pi` (абсолютный или относительно `~/.pi/agent`, например `../../dev/tools/herald/integrations/pi`), затем перезапустить pi или `/reload`. Зависимостей пакет не ставит: код — `src/pi` репо herald.

- Ответ на вопрос расширение не берёт — его ждёт `herald ask`; вопрос без ожидания — забрать `herald inbox`.
- `HERALD_SESSION` в окружении pi — явное имя сессии, как у CLI.
