# Окна агентов без активного агента — план

Spec — [spec.md](./spec.md). Процесс — [workflow.md](../../workflow.md).

## Фаза 1: Домен и хранилище [checkpoint: fd2e5ed]

Критерии фазы: `bun run check` зелёный; требования 1, 2, 4 (правила диалога), 5, 6 покрыты тестами.

- [x] Task: Домен — машина `Host` и запуск `Launch` (`src/domain/host.ts`) (19060ac)
- [x] Task: Домен — диалог `/new` `NewWindowDialog` (`src/domain/new-window.ts`): шаги, выбор по кнопке, ввод, отмена (11e7fd1)
- [x] Task: Домен — команда `/exit` (44d77d1)
- [x] Task: Хранилище — таблицы машин, запусков и диалогов (миграция v7), порт `Store`, очистка (2cfef6b)
- [x] Task: Conductor - User Manual Verification 'Фаза 1: Домен и хранилище' (fd2e5ed) (Protocol in workflow.md)

## Фаза 2: Сценарии сервера и API [checkpoint: 19f928d]

Критерии фазы: `bun run check` зелёный; требования 3, 4, 7 покрыты тестами; `docs/model.md` — сервер.

- [x] Task: Сценарии демона — `HostService`: опрос с ожиданием, итог запуска → reply человеку (f730a06)
- [x] Task: HTTP — `/v1/host/poll`, `/v1/host/done` (391ece6)
- [x] Task: Бот — диалог `/new` (машина → каталог → задача), `/cancel`, подсказки команд (9316b37)
- [x] Task: Документы — `docs/model.md` (сервер: машина, запуск, API, бот, хранение) (2013f77)
- [x] Task: Conductor - User Manual Verification 'Фаза 2: Сценарии сервера и API' (19f928d) (Protocol in workflow.md)

## Фаза 3: Демон и канал [checkpoint: 1ba8872]

Критерии фазы: `bun run check` зелёный; требования 8–10 покрыты тестами и документами; локальная проверка демона против локального сервера.

- [x] Task: Клиент — `hostPoll`, `hostDone` (dab8e9d)
- [x] Task: CLI — демон `herald host` (734a9b5)
- [x] Task: Канал — `/exit` без статуса после команды (5110c9a)
- [x] Task: Документы — `docs/model.md` (CLI, канал), `docs/install.md` (unit `systemd --user`, linger) (f836b32)
- [x] Task: Conductor - User Manual Verification 'Фаза 3: Демон и канал' (1ba8872) (Protocol in workflow.md)

## Фаза 4: Выкатка и живая проверка [checkpoint: 92d9000]

Критерии фазы: сервер выкачен (с подтверждения Нурболата), служба на машине, `/new` и `/exit` работают вживую.

- [x] Task: Выкатка сервера по `docs/deploy.md` — только после `ask` без таймаута (1119143)
- [x] Task: Служба `herald-host` на машине по `docs/install.md` (вне репо)
- [x] Task: Живая проверка — `/new` в `~/herald-livetest`, задача, `/sessions`, `/exit` (живьём)
- [x] Task: Conductor - User Manual Verification 'Фаза 4: Выкатка и живая проверка' (Protocol in workflow.md)

## Заметки к реализации (тактика, решено по ходу)

- Маршруты `/v1/host/*` — в том же `HttpApi`: машина = `caller.session.host` (клиент и так шлёт `session` в каждом теле), человек — по токену. Отдельный разбор тела не нужен.
- `HostService` (`src/app/host.ts`): `poll(caller, waitMs)` — `Host.seen`/`touch` + `saveHost`, невыданные `pendingLaunches` → `take` → сохранить → вернуть; пусто — ждать темы waiter `h:<person>:<host>` до `waitMs`. `done(caller, id, outcome)` — чужой запуск/машина — `ForbiddenError`; `finish` → сохранить → reply человеку на `chatId/messageId` запуска: «🪟 Окно открыто на <машина>: …» / «⚠️ Окно не открылось на <машина>: …».
- Бот (`HumanService` → отдельный класс диалога в `src/app/new-window.ts`, чтобы не раздувать `human.ts`): `/new` — машины на связи (`hostsOf` + `isOnline`), каталоги машины — корни (`root`) сессий человека на этой машине, свежие первыми, без повторов (у `Session` нужен геттер `root`). `/new` сбрасывает `chatTarget`; выбор в `/sessions` удаляет диалог. Текст при живом (не `isExpired`) диалоге идёт в диалог раньше `chatTarget`; reply на сообщение сессии — как раньше (не диалог). Ошибка домена в диалоге — «⚠️ …», диалог остаётся. Задача → `Launch.create` (id `l_…`) + `deleteDialog` + `waiter.notify('h:…')` + «⏳ Открываю окно на <машина>…».
- `callback_data`: `n:<token>:h:<i>`, `n:<token>:d:<i>`, `n:<token>:x` (отмена); `token` — `NewWindowDialog.token`; не тот токен или нет диалога — «⚠️ кнопка устарела».
- Подсказки: `Messages.UNKNOWN_COMMAND` и «Выбери адресата… (/clear, /compact)» — с `/exit`; список команд — с `/new`, `/cancel` (тесты `human.test.ts` ~396, 416, 512 правятся под новый текст).
- pi: `/exit` не трогаем — расширение уже отвечает «⚠️ /exit не выполнена: pi не знает этой команды».
- Демон (`herald host`): `AgentLauncher` с `cwd = home`, сессия tmux `agents`, таймаут 60 с; итог ok — `pane`, `window`, `dir`; ошибка — `LaunchError.message` (там хвост экрана).
- Фаза 2 готова: `/v1/host/poll` `{ waitMs? }` → `{ launches: LaunchWire[] }` (`{ id, dir, prompt, createdAt }`, тип — `src/http/wire.ts`); `/v1/host/done` `{ id, ok, text }` → `{ ok: true }`; повтор итога — 400, чужой — 403, сбой Telegram — 502 (итог уже сохранён: демону не повторять, а логировать). Сервер урезает `waitMs` до `HERALD_MAX_WAIT_SECONDS`.
- Отчёт `purge` теперь с `hosts`, `launches`, `dialogs` — отразить в `docs/model.md`, «Хранение».
- Цикл задачи удобно делать скриптом (если не стёрт): `/tmp/claude-1000/-home-nur-dev-tools-herald/6db7a092-b82b-4e88-bbc6-23f0c75a0d17/scratchpad/done.sh "<коммит>" "<note>" "<уникальный фрагмент задачи>" "<фрагмент следующей>"` — коммит, git note, отметка в плане, коммит плана.
- Ф3 готова: `herald host [--tmux] [--timeout]` (`src/cli/host.ts`, `HostDaemon`); сессия клиента демона — `{ host из настроек, root: $HOME }`; итог ok — «<каталог> (окно @N, панель %M)». Unit службы — `docs/install.md` «Демон машины».
- Локальная проверка Ф3 (сервер с фейковым Bot API через `HERALD_TELEGRAM_API`, tmux на своём сокете, фейковый `claude`) — скрипт `/tmp/claude-1000/-home-nur-dev-tools-herald/ad8fbe14-51f7-4bc5-a436-cd106e6c2477/scratchpad/check-host.ts` (если не стёрт); итог — в git note контрольной точки 1ba8872.
- Скрипт цикла задачи (копия): `/tmp/claude-1000/-home-nur-dev-tools-herald/ad8fbe14-51f7-4bc5-a436-cd106e6c2477/scratchpad/done.sh`.
- Не запушены коммиты Фаз 2–3 (с 19f928d и раньше — см. `git log origin/main..`): push и выкатка — только после `ask` без таймаута.
