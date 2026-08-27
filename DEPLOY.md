# Деплой audit-backend — мини-инструкция

Два compose-файла под разные сценарии:

| Файл | Когда | Postgres |
|---|---|---|
| `compose.yml` | Свежее окружение, нет готовой БД | поднимает свой (том `audit_pgdata`) |
| `compose.prod.yml` | Есть внешняя managed БД, свой контур доступа | не поднимает — подключается по `DATABASE_DSN` |

## 1. Универсальный (`compose.yml`)

```bash
export AUDIT_API_KEY=$(openssl rand -hex 32)   # обязателен, без дефолта
export POSTGRES_PASSWORD=$(openssl rand -hex 16)  # опционален, дефолт "audit"

docker compose up -d --build
```

Поднимает Postgres 16 + сервис на `:8080`. Схема (`audit_logs` + индексы)
накатывается сама при старте (`CREATE TABLE IF NOT EXISTS`) — миграций
руками катать не нужно.

Проверка:
```bash
curl http://localhost:8080/audit/technicians   # -> []
```

Остановить: `docker compose down` (данные в volume останутся).
Снести вместе с данными: `docker compose down -v`.

## 2. Прод с внешней БД (`compose.prod.yml`)

```bash
export DATABASE_DSN="postgres://user:pass@host:5432/audit?sslmode=require"
export AUDIT_API_KEY=$(openssl rand -hex 32)

docker compose -f compose.prod.yml up -d --build
```

`compose.prod.yml` держим под конкретный контур (порт наружу и комментарий
про сеть доступа — см. сам файл), под другую инфраструктуру просто
поправь `ports:` под себя.

## Обязательные env-переменные

- `AUDIT_API_KEY` — статический ключ приложения (`Authorization: Bearer <key>`
  на `/audit/batch`). Один ключ на всё приложение, не на пользователя.
  Генерировать через `openssl rand -hex 32`, не коммитить.
- `DATABASE_DSN` (только `compose.prod.yml`) — полная строка подключения
  Postgres.
- `POSTGRES_PASSWORD` (только `compose.yml`) — пароль для своего Postgres,
  дефолт `audit` — обязательно сменить вне локальной разработки.

## Сеть и безопасность

- Read-API (`/audit/technicians`, `/audit/logs`, веб-вьювер на `GET /`) —
  **без авторизации**. Не открывать в публичный интернет как есть — только
  за VPN/Tailscale/реверс-прокси с отдельной аутентификацией, либо в закрытом
  контуре.
- `/audit/batch` (приём логов) защищён `AUDIT_API_KEY`, но это единственный
  секрет — держи его как обычный пароль (env/secret-manager, не в git).
- HTTPS терминировать на реверс-прокси перед сервисом — сам сервис TLS не
  поднимает.
- Ставь сервис за общий rate-limiter уровня прокси тоже: встроенный лимитер
  в `/audit/batch` общий на все клиенты (не per-IP) — см.
  `cmd/server/main.go` (`rateLimitPerSecond`/`rateLimitBurst`).

## Retention

Настраивается в `config.yaml` (`retention.days`, дефолт 7). Чистка старых
записей — фоновая горутина, раз в сутки + сразу при старте сервиса.
`days: 0` — ретеншн выключен (хранить бессрочно).

## Обновление версии

```bash
git pull
docker compose up -d --build   # (или -f compose.prod.yml)
```

Пересобирает образ, накатывает новую схему (если появилась) автоматически,
Postgres не трогает.

## Проверка живости

```bash
curl -f http://<host>:<port>/audit/technicians || echo "DOWN"
```

Логи контейнера: `docker compose logs -f server`.
