# Пачка вопросов по очереди — план

Spec — [spec.md](./spec.md). Процесс — [workflow.md](../../workflow.md).

## Фаза 1: Домен, хранилище, сервер

Критерии фазы: `bun run check` зелёный; требования 1–17 покрыты тестами; старый одиночный `ask` работает без изменений.

- [ ] Task: Домен — `Question` как пачка пунктов: ответ по пункту, `decide` по неотвеченным, `moveToTerminal`, `answerInTerminal`; вид входящих `to-terminal`
- [ ] Task: Хранилище — миграция v6 (`items`, `terminal_at`, `message_links.item`), чтение старых строк
- [ ] Task: Бот — пункты по очереди, «Вопрос N из M», ответ по пункту, `answer` по готовности пачки
- [ ] Task: Бот — «Жди меня (вся пачка)», «🖥 В терминал», итог решения агента
- [ ] Task: Агент и HTTP — `ask` с `questions`, `decide`/`answered` с `answers`, `POST /v1/to-terminal`, провод
- [ ] Task: Conductor - User Manual Verification 'Фаза 1: Домен, хранилище, сервер' (Protocol in workflow.md)

## Фаза 2: Клиенты, документы и выкатка

Критерии фазы: требования 18–19 покрыты тестами; документы обновлены; сервер выкачен, ручная проверка пройдена.

- [ ] Task: Клиент и CLI — пачка в `ask`, `--answers`, `herald to-terminal`
- [ ] Task: Канал — `ask`/`decide`/`answered` с пачкой, `to_terminal`, событие `to-terminal`, инструкции
- [ ] Task: Мост pi — доставка `to-terminal`
- [ ] Task: Документы — `docs/model.md`, `docs/install.md`
- [ ] Task: Выкатка и ручная проверка на проде
- [ ] Task: Conductor - User Manual Verification 'Фаза 2: Клиенты, документы и выкатка' (Protocol in workflow.md)
