// Read-запросы для веб-вьювера audit-логов: список техников, категории,
// таймлайн ошибок/warning, постраничный список записей.
package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"

	"audit-backend/internal/model"
)

// actionCategories — категории, которые вьювер считает «действиями пользователя»
// (кнопка «Только действия»), см. Audit Log Prototype.dc.html.
var actionCategories = []string{"tap", "swipe", "screenView"}

// Technicians возвращает всех user_id, встречавшихся в логе, с последним
// известным устройством и счётчиками за всё время — для шапки-переключателя.
func (s *Store) Technicians(ctx context.Context) ([]model.Technician, error) {
	latestRows, err := s.pool.Query(ctx, `
SELECT DISTINCT ON (user_id)
  user_id, COALESCE(user_label,''), COALESCE(device_model,''),
  COALESCE(platform,''), COALESCE(os_version,''), COALESCE(app_version,''), timestamp
FROM audit_logs
WHERE user_id IS NOT NULL AND user_id <> ''
ORDER BY user_id, timestamp DESC`)
	if err != nil {
		return nil, fmt.Errorf("technicians latest: %w", err)
	}
	byID := map[string]*model.Technician{}
	var order []string
	for latestRows.Next() {
		var t model.Technician
		if err := latestRows.Scan(&t.UserID, &t.UserLabel, &t.DeviceModel, &t.Platform, &t.OSVersion, &t.AppVersion, &t.LastSeen); err != nil {
			latestRows.Close()
			return nil, fmt.Errorf("technicians latest scan: %w", err)
		}
		byID[t.UserID] = &t
		order = append(order, t.UserID)
	}
	latestRows.Close()
	if err := latestRows.Err(); err != nil {
		return nil, fmt.Errorf("technicians latest rows: %w", err)
	}

	countRows, err := s.pool.Query(ctx, `
SELECT user_id, count(*),
  count(*) FILTER (WHERE log_type = 'error'),
  count(*) FILTER (WHERE log_type = 'warning')
FROM audit_logs
WHERE user_id IS NOT NULL AND user_id <> ''
GROUP BY user_id`)
	if err != nil {
		return nil, fmt.Errorf("technicians counts: %w", err)
	}
	defer countRows.Close()
	for countRows.Next() {
		var userID string
		var total, errs, warns int64
		if err := countRows.Scan(&userID, &total, &errs, &warns); err != nil {
			return nil, fmt.Errorf("technicians counts scan: %w", err)
		}
		if t, ok := byID[userID]; ok {
			t.Total, t.Errors, t.Warnings = total, errs, warns
		}
	}
	if err := countRows.Err(); err != nil {
		return nil, fmt.Errorf("technicians counts rows: %w", err)
	}

	out := make([]model.Technician, 0, len(order))
	for _, id := range order {
		out = append(out, *byID[id])
	}
	return out, nil
}

// CategoryCounts возвращает топ категорий по количеству записей техника (для
// чипов фильтра по категориям).
func (s *Store) CategoryCounts(ctx context.Context, userID string) ([]model.CategoryCount, error) {
	rows, err := s.pool.Query(ctx, `
SELECT category, count(*) AS n
FROM audit_logs
WHERE user_id = $1
GROUP BY category
ORDER BY n DESC
LIMIT 12`, userID)
	if err != nil {
		return nil, fmt.Errorf("category counts: %w", err)
	}
	defer rows.Close()
	var out []model.CategoryCount
	for rows.Next() {
		var c model.CategoryCount
		if err := rows.Scan(&c.Category, &c.Count); err != nil {
			return nil, fmt.Errorf("category counts scan: %w", err)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// Timeline возвращает облегчённые warning/error записи техника (без payload)
// за всё время, по возрастанию времени — для полосы таймлайна вьювера.
func (s *Store) Timeline(ctx context.Context, userID string) ([]model.TimelinePoint, error) {
	rows, err := s.pool.Query(ctx, `
SELECT id, timestamp, event_name, category, log_type
FROM audit_logs
WHERE user_id = $1 AND log_type <> 'info'
ORDER BY timestamp ASC
LIMIT 3000`, userID)
	if err != nil {
		return nil, fmt.Errorf("timeline: %w", err)
	}
	defer rows.Close()
	var out []model.TimelinePoint
	for rows.Next() {
		var p model.TimelinePoint
		if err := rows.Scan(&p.ID, &p.Timestamp, &p.EventName, &p.Category, &p.LogType); err != nil {
			return nil, fmt.Errorf("timeline scan: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// ListLogs возвращает страницу записей техника, новейшие сначала внутри
// страницы (потом разворачивается вызывающим кодом при необходимости).
// BeforeID > 0 — постраничная догрузка более старых записей (keyset по id).
func (s *Store) ListLogs(ctx context.Context, q model.ListLogsQuery) ([]model.LogRow, error) {
	limit := q.Limit
	if limit <= 0 || limit > model.MaxLogsLimit {
		limit = model.DefaultLogsLimit
	}

	sql := `
SELECT id, timestamp, category, log_type, event_name, payload,
  user_id, user_label, device_id, app_version, platform,
  os_version, device_model, network_type, network_signal_level,
  permissions, battery_level, battery_state, power_save_mode, received_at
FROM audit_logs
WHERE user_id = $1`
	args := []any{q.UserID}
	arg := func(v any) string {
		args = append(args, v)
		return fmt.Sprintf("$%d", len(args))
	}

	if q.BeforeID > 0 {
		sql += " AND id < " + arg(q.BeforeID)
	}
	if q.Search != "" {
		sql += " AND event_name ILIKE " + arg("%"+q.Search+"%")
	}
	if q.ActionsOnly {
		sql += " AND category = ANY(" + arg(actionCategories) + ")"
	}
	if q.ErrorsOnly {
		sql += " AND log_type <> 'info'"
	}
	if q.MissionOnly {
		sql += " AND (category ILIKE 'Mission%' OR category = " + arg("SyncQueueWorker") + ")"
	}
	if len(q.Categories) > 0 {
		sql += " AND category = ANY(" + arg(q.Categories) + ")"
	}
	sql += " ORDER BY id DESC LIMIT " + arg(limit)

	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("list logs: %w", err)
	}
	defer rows.Close()

	var out []model.LogRow
	for rows.Next() {
		r, err := scanLogRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list logs rows: %w", err)
	}

	// Порядок id DESC отдаём как есть — вьювер показывает новые записи
	// сверху, старые снизу (см. §4 гайда); он же совпадает с ключом
	// keyset-пагинации «догрузить более старые» (before_id = id последней
	// строки в out).
	return out, nil
}

func scanLogRow(rows pgx.Rows) (model.LogRow, error) {
	var r model.LogRow
	err := rows.Scan(
		&r.ID, &r.Timestamp, &r.Category, &r.LogType, &r.EventName, &r.Payload,
		&r.UserID, &r.UserLabel, &r.DeviceID, &r.AppVersion, &r.Platform,
		&r.OSVersion, &r.DeviceModel, &r.NetworkType, &r.NetworkSignalLevel,
		&r.Permissions, &r.BatteryLevel, &r.BatteryState, &r.PowerSaveMode, &r.ReceivedAt,
	)
	if err != nil {
		return r, fmt.Errorf("scan log row: %w", err)
	}
	return r, nil
}
