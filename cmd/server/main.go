// Command server — приёмник audit-логов rs_tech (замена Supabase-синка, см.
// docs/guides/AUDIT_BACKEND_GUIDE.md в rs_tech): POST /audit/batch, batch
// insert в Postgres, retention-очистка по крону.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"audit-backend/internal/config"
	"audit-backend/internal/httpapi"
	"audit-backend/internal/store"
	"audit-backend/internal/webui"
)

// rateLimit/burst — общий лимит на эндпоинт (§8 гайда: защита от шторма).
const (
	rateLimitPerSecond = 20.0
	rateLimitBurst     = 50
)

func main() {
	configPath := flag.String("config", envOr("CONFIG_PATH", "config.yaml"), "path to config file")
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(log)

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Error("config load failed", "err", err)
		os.Exit(1)
	}
	log.Info("config loaded", "listen", cfg.Server.ListenAddr, "retention_days", cfg.Retention.Days)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.Open(ctx, cfg.Database.DSN)
	if err != nil {
		log.Error("store open failed", "err", err)
		os.Exit(1)
	}
	defer st.Close()
	log.Info("connected to postgres")

	handler := httpapi.New(st, cfg.Auth.APIKey, rateLimitPerSecond, rateLimitBurst, log)
	viewer := httpapi.NewViewer(st, log)

	go runRetention(ctx, st, cfg.Retention.RetentionInterval(), log)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /audit/batch", handler.Batch)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := st.Ping(r.Context()); err != nil {
			http.Error(w, "db unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte("ok"))
	})

	// Веб-вьювер audit-логов (см. internal/webui) — без авторизации,
	// сервис предполагается за закрытой сетью/VPN (см. README).
	mux.HandleFunc("GET /audit/technicians", viewer.Technicians)
	mux.HandleFunc("GET /audit/technicians/categories", viewer.Categories)
	mux.HandleFunc("GET /audit/technicians/timeline", viewer.Timeline)
	mux.HandleFunc("GET /audit/logs", viewer.Logs)
	mux.Handle("/", webui.Handler())

	httpSrv := &http.Server{
		Addr:              cfg.Server.ListenAddr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Info("listening", "addr", cfg.Server.ListenAddr)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("http server failed", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		log.Error("graceful shutdown failed", "err", err)
	}
}

// runRetention раз в сутки удаляет записи старше retention (§4 гайда).
// Если retention отключён (interval <= 0), горутина ничего не делает.
func runRetention(ctx context.Context, st *store.Store, retention time.Duration, log *slog.Logger) {
	if retention <= 0 {
		return
	}
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cutoff := time.Now().Add(-retention)
			n, err := st.DeleteOlderThan(ctx, cutoff)
			if err != nil {
				log.Error("retention cleanup failed", "err", err)
				continue
			}
			log.Info("retention cleanup done", "deleted", n, "cutoff", cutoff)
		}
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
