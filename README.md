# audit-backend

HTTP-приёмник audit-логов rs_tech — замена тестового `AuditSupabaseSink` на
свою ручку, принимающую пачки от `HttpAuditSink` (пакет
[`fieldlog`](https://github.com/maksim-dev1/fieldlog.git)). Контракт и
рационале — [`AUDIT_BACKEND_GUIDE.md`](../rs_tech/docs/guides/AUDIT_BACKEND_GUIDE.md).

## Запуск (docker compose)

```bash
export AUDIT_API_KEY=change-me
export POSTGRES_PASSWORD=change-me
docker compose up --build
```

Поднимает Postgres + сервис на `:8080`. Схема (`audit_logs` + индексы)
накатывается автоматически при старте (`CREATE TABLE IF NOT EXISTS`).

## Локальный запуск без Docker

```bash
cp config.example.yaml config.yaml
export POSTGRES_HOST=localhost
export POSTGRES_PASSWORD=change-me
export AUDIT_API_KEY=change-me
go run ./cmd/server
```

## Проверка вручную

```bash
curl -X POST http://localhost:8080/audit/batch \
  -H "Authorization: Bearer $AUDIT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"entries":[{"timestamp":"2026-08-21T12:00:00.000Z","category":"test","logType":"info","eventName":"ручная проверка"}]}'
```

Ожидаемо: `202 Accepted`, строка в `audit_logs`.

## Веб-вьювер

`GET /` отдаёт встроенный веб-вьювер audit-лога (портирован из макета
`Audit Log Prototype.dc.html`, дизайн claude.ai/design) — статика встроена в
бинарник (`internal/webui`, `go:embed`), отдельного деплоя фронтенда не
требуется. Переключатель техника (`user_id`), поиск по событию, фильтры
(действия/ошибки+warning/заявки), чипы по категориям, таймлайн ошибок и
warning за всё время с переходом к моменту, детальная панель записи
(payload + контекст устройства), пагинация «Загрузить более ранние».

Без авторизации — сервис предполагается за закрытой сетью/VPN. Read-API,
которым вьювер пользуется:

- `GET /audit/technicians` — список техников (user_id) с последним известным
  устройством и счётчиками total/errors/warnings.
- `GET /audit/technicians/categories?user_id=` — топ категорий техника.
- `GET /audit/technicians/timeline?user_id=` — все warning/error записи техника
  (без payload) для полосы таймлайна.
- `GET /audit/logs?user_id=&search=&category=a,b&actions_only=1&errors_only=1&mission_only=1&before_id=&limit=`
  — страница записей (id DESC на бэкенде, разворачивается в хронологический
  порядок в ответе); `before_id` — keyset-пагинация «догрузить более старые».

## Тесты

```bash
go build ./... && go vet ./... && go test ./...
```

## Структура

```
cmd/server/main.go        — точка входа, wiring, graceful shutdown, retention-крон
internal/config/          — YAML-конфиг + подстановка ${VAR} из env
internal/model/           — Entry/BatchRequest (ингест) + LogRow/Technician/... (read-API)
internal/store/           — Postgres (pgx): схема, batch insert, retention delete, read-запросы
internal/httpapi/         — HTTP-хендлеры: ингест (auth+rate limit) и read-API вьювера
internal/webui/            — статика веб-вьювера (go:embed), index.html + app.js
```

## Безопасность

- Ставь сервис за HTTPS (терминация на реверс-прокси/балансировщике) —
  `payload`/`userId` может содержать чувствительные данные (см. §8 гайда).
- `AUDIT_API_KEY` — секрет, не коммитить; ротация через переменную окружения.
- Rate limit на `/audit/batch` — общий лимитер (не per-IP), значения в
  `cmd/server/main.go` (`rateLimitPerSecond`/`rateLimitBurst`).
