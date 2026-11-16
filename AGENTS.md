# herald — правила для агентов

Что это — [README.md](README.md) и [conductor/product.md](conductor/product.md). Общение, документация, комментарии и коммиты — по-русски.

## Начало сессии

1. Активный трек — [conductor/tracks.md](conductor/tracks.md), его `plan.md` — следующая задача.
2. Процесс — [conductor/workflow.md](conductor/workflow.md) (TDD, коммиты, протокол фазы).

## Карта документов

| Документ | Что в нём |
|---|---|
| `conductor/product.md`, `conductor/tech-stack.md` | цели, принципы, стек и зависимости |
| `docs/model.md` | сущности, состояния, HTTP API, команды CLI, инструменты канала |
| `docs/install.md` | установка сервера и клиента на любую машину, подключение агентов |
| `docs/deploy.md` | наш сервер (kalki-server): где что лежит, обновление |

У факта одно место; из других — ссылка. Ловушки окружения — не в docs, а в chronicle (итог сессии делает это сам).

## Код

- Bun + TypeScript strict, Biome. Зависимости — только из `conductor/tech-stack.md`; новые — по согласованию.
- TDD: сначала тест, запуск (red), потом реализация. Перед коммитом — `bun run check`.
- Слои: `src/domain` (чистые правила, синхронно) ← `src/app` (сценарии, порты) ← `src/infra` (SQLite, Telegram), `src/http`, `src/cli`, `src/channel`; `src/server` — сборка и запуск сервера.
- Классы с API и зоной ответственности; функции-хелперы — только по обоснованию.
- Деплой — по `docs/deploy.md`, только в рамках плана или по просьбе.
