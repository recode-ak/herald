# herald v1 — план

Spec — [spec.md](./spec.md). Процесс — [workflow.md](../../workflow.md): TDD (red → green), коммит на задачу, протокол фазы. КП — критерии приёмки spec.

## Фаза 1: Каркас и домен

Критерии фазы: `bun run check` зелёный; домен (сессия, вопрос, входящие, доступ) покрыт тестами, без ввода-вывода; `docs/model.md` описывает сущности и состояния.

- [x] Task: Каркас и базовая линия (2e9582e)
    - [x] `package.json` (скрипты `test`, `lint`, `typecheck`, `check`, `link`), `tsconfig.json` (strict), `biome.json`, `LICENSE` (MIT-0) — по образцу chronicle
    - [x] Базовая линия: `bun run check` зелёный на пустом наборе, результат — в git note
- [x] Task: Доступ — люди и токены (2e9582e)
    - [x] Тесты: разбор `HERALD_TOKENS` и `HERALD_PEOPLE` (корректные строки, пустые, дубли, человек без chat_id); поиск человека по токену и по chat_id
    - [x] Реализация `src/domain/access`
- [x] Task: Сессия (ed1bf24)
    - [x] Тесты: ключ `host + корень` / явный `--session`, имя проекта из корня, статус с временем, активность по последнему обращению, «активна» — в пределах окна
    - [x] Реализация `src/domain/session`
- [x] Task: Вопрос (ba1daf3)
    - [x] Тесты: варианты и рекомендованный (рекомендованный — из вариантов), состояния `open → answered | decided`, ответ после `decided` или повторный — поздний (`lateAnswers`), `decide` только из `open` и без удержания «Жди меня» (`hold`)
    - [x] Реализация `src/domain/question`
- [ ] Task: Входящие
    - [ ] Тесты: виды `answer`, `late-answer`, `directive`; состояния `queued → read`; порядок выдачи; принадлежность сессии
    - [ ] Реализация `src/domain/inbox`
- [ ] Task: `docs/model.md` — сущности, состояния, правила
- [ ] Task: Conductor - User Manual Verification 'Фаза 1: Каркас и домен' (Protocol in workflow.md)

## Фаза 2: Хранилище и сценарии

Критерии фазы: все сценарии spec (ФТ 1–8, 10) работают на SQLite в памяти и фейковом Telegram; доступ по человеку проверен тестами.

- [ ] Task: SQLite-хранилище
    - [ ] Тесты (`:memory:`): сессии, вопросы, входящие, связь `message_id → сессия/вопрос`, offset Telegram; схема создаётся при старте, WAL
    - [ ] Реализация `src/infra/sqlite`
- [ ] Task: Порт Telegram и фейк
    - [ ] Интерфейс `TelegramPort` (отправить с кнопками, изменить, ответить на callback) и `FakeTelegram` для тестов
- [ ] Task: Сценарии агента — `notify`, `ask`, `decide`, `status`, `inbox` (выдача и подтверждение прочтения)
    - [ ] Тесты: шапка `[host · проект]`, ошибка доставки, кнопки вариантов + «Жди меня», обновление сообщения при `decide`, статус без отправки в Telegram, отметка «прочитано агентом»
    - [ ] Реализация `src/app`
- [ ] Task: Сценарии человека — обработка апдейтов Telegram
    - [ ] Тесты: кнопка варианта → ответ; reply на вопрос → свободный ответ; reply на прочее сообщение сессии → указание; поздний ответ → `late-answer`; `/sessions` с кнопками выбора и последующий текст → указание выбранной сессии; `/status`; отметка «в ящике сессии X»; чужой chat_id и чужая сессия — отказ (КП 7)
    - [ ] Реализация `src/app`
- [ ] Task: Ожидание (long poll)
    - [ ] Тесты: ожидание ответа на вопрос и новых входящих с таймаутом; пробуждение при событии; часы — за интерфейсом
    - [ ] Реализация
- [ ] Task: Conductor - User Manual Verification 'Фаза 2: Хранилище и сценарии' (Protocol in workflow.md)

## Фаза 3: HTTP-сервер и Telegram-адаптер

Критерии фазы: сервер поднимается из `.env`, отдаёт API по Bearer-токену, опрашивает Telegram (в тестах — локальный фейк Bot API); `docs/model.md` описывает HTTP API.

- [ ] Task: HTTP API (`Bun.serve`)
    - [ ] Тесты (сервер на случайном порту): токен → человек, неверный токен — 401 (КП 7); эндпоинты notify, ask, вопрос с `wait`, decide, status, inbox с `wait`, подтверждение прочтения
    - [ ] Реализация `src/http`
- [ ] Task: Адаптер Telegram Bot API (`fetch`)
    - [ ] Тесты против локального фейка Bot API: `getUpdates` long polling с сохранением offset, `sendMessage` с inline-кнопками, `editMessageText`, `answerCallbackQuery`, ошибки и повторы
    - [ ] Реализация `src/infra/telegram`
- [ ] Task: Точка входа сервера — конфиг из `.env`, сборка, корректная остановка; `docs/model.md` — HTTP API
- [ ] Task: Conductor - User Manual Verification 'Фаза 3: HTTP-сервер и Telegram-адаптер' (Protocol in workflow.md)

## Фаза 4: CLI

Критерии фазы: CLI-сценарии КП 1–5, 7 проходят сквозным тестом CLI → сервер → фейковый Telegram; `bun run link` ставит `herald`.

- [ ] Task: Клиент herald (общий для CLI и канала)
    - [ ] Тесты: конфиг `~/.config/herald/config.json` (и переопределение через env), ключ сессии (host, корень git, `--session`), переподключение long poll до таймаута
    - [ ] Реализация `src/client`
- [ ] Task: Команды `notify`, `ask`, `decide`, `status`, `inbox`
    - [ ] Тесты: аргументы, JSON-вывод, коды выхода (ответ / таймаут / ошибка), `ask` без `--timeout` ждёт бесконечно
    - [ ] Реализация `src/cli`, `bun run link`
- [ ] Task: Сквозной тест `test/e2e/` — КП 1–5, 7 для CLI
- [ ] Task: `docs/model.md` — команды CLI
- [ ] Task: Conductor - User Manual Verification 'Фаза 4: CLI' (Protocol in workflow.md)

## Фаза 5: Channel для Claude Code

Критерии фазы: MCP-сервер канала объявляет `claude/channel`, отдаёт инструменты, доставляет входящие событиями и подтверждает прочтение; подтверждение действий — по настройке; `docs/install.md` описывает подключение.

- [ ] Task: Зависимость `@modelcontextprotocol/sdk` (согласована в spec) — `package.json`, `tech-stack.md`
- [ ] Task: Сервер канала (stdio)
    - [ ] Тесты (фейковый клиент herald, транспорт MCP в памяти): capability, инструменты `reply`/`notify`, `ask` (сразу id), `decide`, `status`; цикл входящих → `notifications/claude/channel` с `meta` (вид, id вопроса) → подтверждение прочтения
    - [ ] Реализация `src/channel`
- [ ] Task: Подтверждение действий из Telegram
    - [ ] Тесты: `permission_request` → вопрос «разрешить / запретить» → `notifications/claude/channel/permission`; выключено по умолчанию
    - [ ] Реализация
- [ ] Task: `docs/install.md` — подключение канала (`.mcp.json`, флаг запуска, ограничения research preview)
- [ ] Task: Conductor - User Manual Verification 'Фаза 5: Channel для Claude Code' (Protocol in workflow.md)

## Фаза 6: Деплой и установка

Критерии фазы: сервер работает на kalki-server за `https://herald.u7-hub.kz`; реальный бот проходит КП 1–7 (КП 6 — в живой сессии Claude Code); установка клиента — не больше 5 команд (КП 8). Выкатка и действия на сервере — с уведомлением и ожиданием подтверждения.

- [ ] Task: Действия Нурболата (уведомление): бот в BotFather, DNS `herald.u7-hub.kz`, репо на GitHub (публичность — вопрос в уведомлении)
- [ ] Task: Скрипты и документы деплоя — `scripts/deploy.sh`, `backup.contract`, `scripts/backup.sh`, `docs/deploy.md`, `docs/install.md` (сервер и клиент)
- [ ] Task: Выкатка на kalki-server — `/srv/herald`, `.env` (600), pm2; nginx и certbot — Нурболат (sudo); мониторинг health-check server-ops — по согласованию
- [ ] Task: Смоук на реальном боте — КП 1–7, результат — в git note
- [ ] Task: Conductor - User Manual Verification 'Фаза 6: Деплой и установка' (Protocol in workflow.md)

## Фаза 7: Перевод Автопилота и итог

Критерии фазы: КП 9 выполнен; финальный гейт зелёный; итог трека с принятыми стратегическими решениями.

- [ ] Task: Клиент herald на рабочей машине (конфиг, `bun run link`, канал в Claude Code)
- [ ] Task: Инструкция «Автопилот» в `~/.pi/agent/AGENTS.md` → herald (`ask`, `status` и `inbox` на границах задач, канал в Claude Code); память агента; удалить `~/.local/bin/agent-notify` и `agent-notify.env`
- [ ] Task: Финальный гейт — `bun run check`, сравнение с базовой линией; `summary.md` трека: сделанное, решения (вопрос → варианты → выбранное → как переиграть), отложенное
- [ ] Task: Conductor - User Manual Verification 'Фаза 7: Перевод Автопилота и итог' (Protocol in workflow.md)

## Риски

- **Channels — research preview:** протокол может измениться — канал изолирован в `src/channel`.
- **Доставка событий канала посреди длинного хода** не проверить без живой сессии — проверка в смоуке Ф6; запасной путь — `herald inbox` на границах задач.
- **Bun на сервере 1.3.x** (ловушка chronicle с `bun.lock`) — `deploy.sh` по образцу chronicle.
