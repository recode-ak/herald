# Окна агентов без активного агента — план

Spec — [spec.md](./spec.md). Процесс — [workflow.md](../../workflow.md).

## Фаза 1: Домен и хранилище

Критерии фазы: `bun run check` зелёный; требования 1, 2, 4 (правила диалога), 5, 6 покрыты тестами.

- [~] Task: Домен — машина `Host` и запуск `Launch` (`src/domain/host.ts`)
- [ ] Task: Домен — диалог `/new` `NewWindowDialog` (`src/domain/new-window.ts`): шаги, выбор по кнопке, ввод, отмена
- [ ] Task: Домен — команда `/exit`
- [ ] Task: Хранилище — таблицы машин, запусков и диалогов (миграция v7), порт `Store`, очистка
- [ ] Task: Conductor - User Manual Verification 'Фаза 1: Домен и хранилище' (Protocol in workflow.md)

## Фаза 2: Сценарии сервера и API

Критерии фазы: `bun run check` зелёный; требования 3, 4, 7 покрыты тестами; `docs/model.md` — сервер.

- [ ] Task: Сценарии демона — `HostService`: опрос с ожиданием, итог запуска → reply человеку
- [ ] Task: HTTP — `/v1/host/poll`, `/v1/host/done`
- [ ] Task: Бот — диалог `/new` (машина → каталог → задача), `/cancel`, подсказки команд
- [ ] Task: Документы — `docs/model.md` (сервер: машина, запуск, API, бот, хранение)
- [ ] Task: Conductor - User Manual Verification 'Фаза 2: Сценарии сервера и API' (Protocol in workflow.md)

## Фаза 3: Демон и канал

Критерии фазы: `bun run check` зелёный; требования 8–10 покрыты тестами и документами; локальная проверка демона против локального сервера.

- [ ] Task: Клиент — `hostPoll`, `hostDone`
- [ ] Task: CLI — демон `herald host`
- [ ] Task: Канал — `/exit` без статуса после команды
- [ ] Task: Документы — `docs/model.md` (CLI, канал), `docs/install.md` (unit `systemd --user`, linger)
- [ ] Task: Conductor - User Manual Verification 'Фаза 3: Демон и канал' (Protocol in workflow.md)

## Фаза 4: Выкатка и живая проверка

Критерии фазы: сервер выкачен (с подтверждения Нурболата), служба на машине, `/new` и `/exit` работают вживую.

- [ ] Task: Выкатка сервера по `docs/deploy.md` — только после `ask` без таймаута
- [ ] Task: Служба `herald-host` на машине по `docs/install.md`
- [ ] Task: Живая проверка — `/new` в `~/herald-livetest`, задача, `/sessions`, `/exit`
- [ ] Task: Conductor - User Manual Verification 'Фаза 4: Выкатка и живая проверка' (Protocol in workflow.md)
