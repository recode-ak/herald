# Самосброс агента — итог

Завершён 2026-11-17.

- `herald self <команда> [--message] [--timeout] [--delay] [--foreground]` — агент сам набирает команду (`/clear`, `/compact`…) в свою панель tmux и затем сообщение для продолжения. Идёт фоном (`setsid -f`), лог — `~/.local/state/herald/self/<панель>.log`.
- Моменты набора — по хукам Claude Code (`herald hook`): `Stop` → команда, `SessionStart` (`clear` / `compact`) → пауза 1 с → сообщение. Без хуков — `--delay`. Не дождался — `notify` человеку с текстом сообщения.
- `TmuxTerminal` переехал в `src/terminal/`; многострочный текст — вставкой (`paste-buffer -p`).
- Хуки — в `~/.claude/settings.json` (описание — `docs/install.md`); Автопилот (п. 4, 5, 7 глобального `AGENTS.md`) — сброс на границе фаз через `herald self`.
- Проверено вживую в отдельном окне Claude Code 2.1.326.

Вне рамок: самосброс в pi средствами расширения (`newSession` + `sendUserMessage`).
