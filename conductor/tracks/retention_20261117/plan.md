# Очистка БД herald — план

Spec — [spec.md](./spec.md). Процесс — [workflow.md](../../workflow.md).

## Фаза 1: Очистка в herald [checkpoint: 12a47ff]

Критерии фазы: `bun run check` зелёный; политика покрыта тестами хранилища; `bun run purge` работает на временной базе.

- [x] Task: Срок хранения в домене — `Retention` (дни ≥ 1, `cutoff(now)`) (376bf2c)
- [x] Task: Миграция v5 — `message_links.created_at` (bc08fa1)
- [x] Task: `Store.purge(cutoff, { dryRun })` — правила политики, счётчики удалённого и оставшегося (7ba357c)
- [x] Task: Команда `bun run purge` — аргументы, `HERALD_RETENTION_DAYS`, JSON, коды выхода (c93e5b3)
- [x] Task: Бот — кнопка на удалённом вопросе: «вопрос устарел и удалён» (23f0480)
- [x] Task: Документы — `docs/model.md` «Хранение», `docs/deploy.md`, `docs/install.md` (bb214e8)
- [x] Task: Conductor - User Manual Verification 'Фаза 1: Очистка в herald' (12a47ff) (Protocol in workflow.md)

## Фаза 2: server-ops и выкатка

Критерии фазы: herald обновлён на проде; служба `herald-retention` стоит в cron; статус виден в health-check.

- [ ] Task: Выкатка herald (`scripts/deploy.sh`), `bun run purge --dry-run` на проде
- [ ] Task: Служба server-ops `herald-retention` — скрипт, `service.conf`, README, таблица служб; `deploy.sh --only`
- [ ] Task: Ручной прогон и проверка `40-statusfiles`; отметка в `docs/deploy.md`
- [ ] Task: Conductor - User Manual Verification 'Фаза 2: server-ops и выкатка' (Protocol in workflow.md)
