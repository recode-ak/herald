# Технологический стек

| Что | Выбор | Почему |
|---|---|---|
| Рантайм | Bun 1.x | как chronicle; `bun:sqlite`, `Bun.serve`, тесты из коробки |
| Язык | TypeScript strict | типобезопасность |
| Линтер/формат | Biome | как chronicle |
| Хранение | SQLite (`bun:sqlite`, WAL) | одна таблица на сущность, без ORM |
| Telegram | Bot API через `fetch`, long polling `getUpdates` | без библиотек; webhook не нужен |
| HTTP | `Bun.serve`, Bearer-токен | без фреймворка |
| Channel Claude Code | `@modelcontextprotocol/sdk` (stdio) | согласовано 2026-11-16; только в `src/channel` |
| Деплой | pm2 + nginx на kalki-server | как chronicle |

Зависимости рантайма: только `@modelcontextprotocol/sdk`. Dev: `@biomejs/biome`, `typescript`, `@types/bun`. Новая — только после обсуждения.
