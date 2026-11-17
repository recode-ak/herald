# Новое окно агента — план

Spec — [spec.md](./spec.md). Процесс — [workflow.md](../../workflow.md).

## Фаза 1: Запуск окна

Критерии фазы: `bun run check` зелёный; требования 1–7 покрыты тестами и документами; живая проверка в tmux пройдена.

- [x] Task: Терминал — `screen()` и `press()` у `TmuxTerminal` (3e5328f)
- [ ] Task: Запуск — `AgentLauncher` (каталог, сессия agents, диалоги)
- [ ] Task: CLI — `herald spawn`
- [ ] Task: Канал — инструкции про `herald spawn` и `herald self /exit`; документы
- [ ] Task: Живая проверка — окно в agents, задача, закрытие
- [ ] Task: Conductor - User Manual Verification 'Фаза 1: Запуск окна' (Protocol in workflow.md)
