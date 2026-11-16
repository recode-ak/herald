# herald v1 — итог трека

Spec — [spec.md](./spec.md), план — [plan.md](./plan.md). Трек: 2026-11-16.

## Сделано

- **Домен** (`src/domain`): доступ (люди и токены), сессия, вопрос (`open → answered | decided`, поздние ответы, «Жди меня»), входящие (`answer`, `late-answer`, `directive`). Описание — `docs/model.md`.
- **Сценарии и хранилище** (`src/app`, `src/infra`): агент — `notify`, `ask`, `decide`, `status`, `inbox`, `ack`; человек — кнопки, reply, `/sessions`, `/status`, отказ чужим; SQLite (WAL); long poll ожидания.
- **Сервер** (`src/http`, `src/server`): HTTP API по Bearer-токену, адаптер Telegram Bot API на `fetch` (long polling, offset).
- **CLI** `herald` (`src/cli`, `src/client`): JSON-вывод, коды 0/2/1, `bun run link`.
- **Канал Claude Code** (`src/channel`): MCP stdio с `claude/channel`, инструменты `reply`/`notify`, `ask`, `decide`, `status`; входящие — событиями; подтверждение действий из Telegram по `HERALD_PERMISSION_RELAY=1`.
- **Деплой**: kalki-server, `/srv/herald`, pm2, `https://herald.u7-hub.kz`, health-check server-ops (`4518:herald`). Документы — `docs/install.md`, `docs/deploy.md`.
- **Автопилот** (`~/.pi/agent/AGENTS.md`) переведён на herald: вопросы — `ask` с ожиданием 3 мин и `decide` по таймауту, `status` и `inbox --ack` на границах задач, уведомления — `herald notify`, в Claude Code — канал.
- На ноутбуке: `herald` в `~/.local/bin`, канал — `claude mcp add --scope user herald` (Connected).

## Финальный гейт

`bun run check`: biome — 71 файл без замечаний, tsc — чисто, тесты — 249 pass / 0 fail (32 файла). Покрытие — 98.43% функций, 99.55% строк.

Базовая линия (2e9582e): 8 тестов, 0 fail (на пустом наборе tsc падает с TS18003, поэтому линию сняли с первым модулем). Итого: +241 тест, регрессий нет.

## Критерии приёмки

| КП | Статус |
|---|---|
| 1–5 | ✅ смоук на реальном боте (CLI с ноутбука), e2e-тесты |
| 6 — канал в живой сессии Claude Code | ⏳ за Нурболатом (ниже); e2e канала по stdio — зелёный |
| 7 — неверный токен и чужой chat_id | ✅ смоук; чужой chat_id — второй аккаунт (`/start`, `/status` без ответа) и тест `human.test.ts` |
| 8 — деплой и установка ≤ 5 команд | ✅ |
| 9 — Автопилот на herald | ✅ (`agent-notify` удалил Нурболат) |

## За Нурболатом

1. КП 6: запустить `claude --dangerously-load-development-channels server:herald` в любом проекте → написать reply боту → указание приходит в сессию; попросить агента `ask` → нажать кнопку → событие `answer`. Удобно — алиас в `~/.bashrc`.
2. По желанию — `permissions.allow` в `~/.claude/settings.json`: `mcp__herald__reply`, `mcp__herald__notify`, `mcp__herald__ask`, `mcp__herald__decide`, `mcp__herald__status`.

## Решения

Стратегические, принятые Нурболатом: репо публичное; бэкап не нужен; мониторинг — только «жив» (health-check server-ops).

Стратегических решений, принятых агентом без ответа, нет. Решения по формулировке Автопилота (Фаза 7), которые легко переиграть правкой `~/.pi/agent/AGENTS.md`:

| Вопрос | Варианты | Выбрано и почему | Как переиграть |
|---|---|---|---|
| Как ждать ответа в Claude Code | инструмент `ask` + фоновый `sleep 180` / CLI `herald ask --timeout 180` | канал, если подключён (ответ — событием, сессия не занята); иначе CLI | п. 4 |
| Граница фаз | `notify` и ожидание / `ask` «сброс / продолжаю здесь» | `ask` — ответ кнопкой, тот же механизм таймаута | п. 5 |
| Данные, push, выкатка, деструктивный git | `notify` и ожидание в терминале / `ask` без `--timeout` | `ask` без таймаута — ответ виден агенту сразу, из Telegram | последний абзац раздела |
| herald недоступен | стоп / терминал с ожиданием по п. 4 | терминал — работа не стоит из-за посредника | абзац «herald:» |

## После трека

Нурболат по итогам работы через Telegram добавил (на `main`, выкачено): квитанции реакциями, «Жди меня» только у открытого вопроса (4df44bd); окно сессии Claude Code и название от агента (1c7416d); кнопки убираются после ответа (eb73519); Markdown агента → HTML Telegram (c50dd04); метки «кто на связи» 🟢/⚪ (094ccee). Гейт — 284 pass / 0 fail.

## Отложено

Из spec «За рамками»: webhook, несколько ботов, веб-интерфейс, запуск агентов из Telegram, расширение для pi (если `inbox` на границах задач окажется медленным), автозапуск pm2.
