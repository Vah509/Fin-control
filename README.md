# Fin-control

Личное приложение учёта денег (срез остатков на дату, движения). PWA на Vite + React + TypeScript, хранилище Supabase, позже Android с SQLite.

**Новый чат или новый разработчик: начни с [docs/STATUS.md](docs/STATUS.md).**

Документы:
- [docs/STATUS.md](docs/STATUS.md): состояние, ближайшие шаги, долги
- [docs/WORKFLOW.md](docs/WORKFLOW.md): порядок работы, состав ZIP, правила актуальности документов
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): слои, модули ядра, экраны, тесты
- [docs/DATA-MODEL.md](docs/DATA-MODEL.md): таблицы базы
- [docs/DECISIONS.md](docs/DECISIONS.md): решения, расхождения с брифами, открытые вопросы
- [docs/ROADMAP.md](docs/ROADMAP.md): дорожная карта
- [docs/CHANGELOG.md](docs/CHANGELOG.md): журнал изменений
- [docs/keep-alive-worker.md](docs/keep-alive-worker.md): будильник базы (Cloudflare Worker)
- [supabase/README.md](supabase/README.md): как применять миграции

Проверка: `npm ci`, `npm run build`, `npx vitest run`.
