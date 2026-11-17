# Новое окно агента — план

Spec — [spec.md](./spec.md). Процесс — [workflow.md](../../workflow.md).

## Фаза 1: Запуск окна

Критерии фазы: `bun run check` зелёный; требования 1–7 покрыты тестами и документами; живая проверка в tmux пройдена.

- [x] Task: Терминал — `screen()` и `press()` у `TmuxTerminal` (3e5328f)
- [x] Task: Запуск — `AgentLauncher` (каталог, сессия agents, диалоги) (792190c)
- [x] Task: CLI — `herald spawn` (1619cd0)
- [x] Task: Канал — инструкции про `herald spawn` и `herald self /exit`; документы (0e7d885)
- [x] Task: Живая проверка — окно в agents, задача, закрытие (f192a17; 2026-11-17: недоверенный каталог, задача, herald self /exit — работают)
- [ ] Task: Conductor - User Manual Verification 'Фаза 1: Запуск окна' (Protocol in workflow.md)
