# Самосброс агента — план

Spec — [spec.md](./spec.md). Процесс — [workflow.md](../../workflow.md).

## Фаза 1: Код

Критерии фазы: `bun run check` зелёный; требования 1–9 покрыты тестами.

- [x] Task: Терминал — многострочный текст вставкой; `TmuxTerminal` в `src/terminal/` (39fa42e)
- [ ] Task: Сигналы хуков — `HookSignals` и `herald hook`
- [ ] Task: Самосброс — `SelfReset` (хуки, `--delay`, срок, notify)
- [ ] Task: CLI — `herald self`, запуск фоном
- [ ] Task: Conductor - User Manual Verification 'Фаза 1: Код' (Protocol in workflow.md)

## Фаза 2: Документы и настройка

Критерии фазы: документы обновлены; хуки настроены; проверка в отдельном окне Claude Code в tmux пройдена.

- [ ] Task: Документы — `docs/model.md`, `docs/install.md`
- [ ] Task: Хуки в `~/.claude/settings.json`, ручная проверка в отдельном окне
- [ ] Task: Автопилот — п. 5 глобального `AGENTS.md`
- [ ] Task: Conductor - User Manual Verification 'Фаза 2: Документы и настройка' (Protocol in workflow.md)
