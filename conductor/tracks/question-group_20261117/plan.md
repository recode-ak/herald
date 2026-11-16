# Пачка вопросов по очереди — план

Spec — [spec.md](./spec.md). Процесс — [workflow.md](../../workflow.md).

## Фаза 1: Домен, хранилище, сервер [checkpoint: badf558]

Критерии фазы: `bun run check` зелёный; требования 1–17 покрыты тестами; старый одиночный `ask` работает без изменений.

- [x] Task: Домен — `Question` как пачка пунктов: ответ по пункту, `decide` по неотвеченным, `moveToTerminal`, `answerInTerminal`; вид входящих `to-terminal` (0fd9793)
- [x] Task: Хранилище — миграция v6 (`items`, `terminal_at`, `message_links.item`), чтение старых строк (0fd9793)
- [x] Task: Бот — пункты по очереди, «Вопрос N из M», ответ по пункту, `answer` по готовности пачки (5610755)
- [x] Task: Бот — «Жди меня (вся пачка)», «🖥 В терминал», итог решения агента (5610755)
- [x] Task: Агент и HTTP — `ask` с `questions`, `decide`/`answered` с `answers`, `POST /v1/to-terminal`, провод (40362c5)
- [x] Task: Conductor - User Manual Verification 'Фаза 1: Домен, хранилище, сервер' (badf558) (Protocol in workflow.md)

## Фаза 2: Клиенты, документы и выкатка

Критерии фазы: требования 18–19 покрыты тестами; документы обновлены; сервер выкачен, ручная проверка пройдена.

- [x] Task: Клиент и CLI — пачка в `ask`, `--answers`, `herald to-terminal` (934b4be)
- [x] Task: Канал — `ask`/`decide`/`answered` с пачкой, `to_terminal`, событие `to-terminal`, инструкции (c5f11d5)
- [x] Task: Мост pi — доставка `to-terminal` (6ad9c80)
- [ ] Task: Документы — `docs/model.md`, `docs/install.md`
- [ ] Task: Выкатка и ручная проверка на проде
- [ ] Task: Conductor - User Manual Verification 'Фаза 2: Клиенты, документы и выкатка' (Protocol in workflow.md)
