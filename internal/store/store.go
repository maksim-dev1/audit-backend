// Package store отвечает за хранение audit-записей в Postgres — batch insert
// и retention-очистку (см. §4 AUDIT_BACKEND_GUIDE.md).
package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"audit-backend/internal/model"
)

const schema = `
CREATE TABLE IF NOT EXISTS audit_logs (
  id                    BIGSERIAL PRIMARY KEY,
  timestamp             TIMESTAMPTZ NOT NULL,
  category              TEXT NOT NULL,
  log_type              TEXT NOT NULL,
  event_name            TEXT NOT NULL,
  payload               JSONB,
  user_id               TEXT,
  user_label            TEXT,
  device_id             TEXT,
  app_version           TEXT,
  platform              TEXT,
  os_version            TEXT,
  device_model          TEXT,
  network_type          TEXT,
  network_signal_level  SMALLINT,
  permissions           JSONB,
  battery_level         SMALLINT,
  battery_state         TEXT,
  power_save_mode       BOOLEAN,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs (user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_device_id ON audit_logs (device_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_category ON audit_logs (category, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_log_type ON audit_logs (log_type) WHERE log_type <> 'info';
`

// Store — пул подключений к Postgres.
type Store struct {
	pool *pgxpool.Pool
}

// Open подключается к Postgres и накатывает схему (CREATE TABLE IF NOT EXISTS).
func Open(ctx context.Context, dsn string) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	if _, err := pool.Exec(ctx, schema); err != nil {
		pool.Close()
		return nil, fmt.Errorf("migrate schema: %w", err)
	}
	return &Store{pool: pool}, nil
}

// Close закрывает пул подключений.
func (s *Store) Close() {
	s.pool.Close()
}

// InsertBatch вставляет пачку записей одним batch-запросом (см. §2 гайда —
// бэкенду не нужно ничего делать под клиентский батчинг, просто вставлять
// массив целиком).
func (s *Store) InsertBatch(ctx context.Context, entries []model.Entry) error {
	if len(entries) == 0 {
		return nil
	}

	batch := &pgx.Batch{}
	const stmt = `
INSERT INTO audit_logs (
  timestamp, category, log_type, event_name, payload,
  user_id, user_label, device_id, app_version, platform,
  os_version, device_model, network_type, network_signal_level,
  permissions, battery_level, battery_state, power_save_mode
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`

	for _, e := range entries {
		ts, err := time.Parse(time.RFC3339, e.Timestamp)
		if err != nil {
			return fmt.Errorf("parse timestamp %q: %w", e.Timestamp, err)
		}
		var payload, permissions any
		if len(e.Payload) > 0 {
			payload = e.Payload
		}
		if len(e.Permissions) > 0 {
			permissions = e.Permissions
		}
		batch.Queue(stmt,
			ts, e.Category, e.LogType, e.EventName, payload,
			e.UserID, e.UserLabel, e.DeviceID, e.AppVersion, e.Platform,
			e.OSVersion, e.DeviceModel, e.NetworkType, e.NetworkSignalLevel,
			permissions, e.BatteryLevel, e.BatteryState, e.PowerSaveMode,
		)
	}

	br := s.pool.SendBatch(ctx, batch)
	defer br.Close()
	for range entries {
		if _, err := br.Exec(); err != nil {
			return fmt.Errorf("insert: %w", err)
		}
	}
	return nil
}

// DeleteOlderThan удаляет записи старше given cutoff (retention, см. §4 гайда).
func (s *Store) DeleteOlderThan(ctx context.Context, cutoff time.Time) (int64, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM audit_logs WHERE timestamp < $1`, cutoff)
	if err != nil {
		return 0, fmt.Errorf("delete older than: %w", err)
	}
	return tag.RowsAffected(), nil
}

// Ping проверяет соединение с БД (для /healthz).
func (s *Store) Ping(ctx context.Context) error {
	return s.pool.Ping(ctx)
}
