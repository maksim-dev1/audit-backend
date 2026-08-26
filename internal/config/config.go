// Package config загружает конфигурацию сервиса из YAML-файла с подстановкой
// секретов из переменных окружения (синтаксис ${VAR}). Секреты в файле не
// хранятся — только ссылки на env.
package config

import (
	"fmt"
	"os"
	"time"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Server    ServerConfig    `yaml:"server"`
	Database  DatabaseConfig  `yaml:"database"`
	Auth      AuthConfig      `yaml:"auth"`
	Retention RetentionConfig `yaml:"retention"`
}

type ServerConfig struct {
	ListenAddr string `yaml:"listen_addr"`
}

type DatabaseConfig struct {
	// DSN — строка подключения Postgres, напр.
	// postgres://user:pass@host:5432/audit?sslmode=disable
	DSN string `yaml:"dsn"`
}

type AuthConfig struct {
	// APIKey — статический ключ приложения (Authorization: Bearer <key>).
	// Один ключ на приложение, не на пользователя (см. §3 гайда).
	APIKey string `yaml:"api_key"`
}

type RetentionConfig struct {
	// Days — сколько дней хранить записи в audit_logs; 0 = ретеншн выключен.
	Days int `yaml:"days"`
}

// Load читает YAML-файл, подставляет ${VAR} из окружения и валидирует.
func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	expanded := os.Expand(string(raw), os.Getenv)
	var cfg Config
	if err := yaml.Unmarshal([]byte(expanded), &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	cfg.applyDefaults()
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func (c *Config) applyDefaults() {
	if c.Server.ListenAddr == "" {
		c.Server.ListenAddr = ":8080"
	}
	if c.Retention.Days == 0 {
		c.Retention.Days = 90
	}
}

func (c *Config) validate() error {
	if c.Database.DSN == "" {
		return fmt.Errorf("database.dsn is required (set DATABASE_DSN)")
	}
	if c.Auth.APIKey == "" {
		return fmt.Errorf("auth.api_key is required (set AUDIT_API_KEY)")
	}
	return nil
}

// RetentionInterval — длительность хранения записей для крона очистки.
func (r RetentionConfig) RetentionInterval() time.Duration {
	return time.Duration(r.Days) * 24 * time.Hour
}
