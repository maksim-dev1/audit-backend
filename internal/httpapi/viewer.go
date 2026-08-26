// Read-эндпоинты для веб-вьювера audit-логов (см. web/, Audit Log Prototype.dc.html).
// Без авторизации — сервис предполагается за закрытой сетью/VPN (см. README).
package httpapi

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"audit-backend/internal/model"
)

// Reader — read-часть хранилища, нужная вьюверу (реализует store.Store).
type Reader interface {
	Technicians(ctx context.Context) ([]model.Technician, error)
	CategoryCounts(ctx context.Context, userID string) ([]model.CategoryCount, error)
	Timeline(ctx context.Context, userID string) ([]model.TimelinePoint, error)
	ListLogs(ctx context.Context, q model.ListLogsQuery) ([]model.LogRow, error)
}

// ViewerHandler — обработчики GET /audit/technicians, /audit/logs и т.п.
type ViewerHandler struct {
	store Reader
	log   *slog.Logger
}

// NewViewer создаёт ViewerHandler.
func NewViewer(store Reader, log *slog.Logger) *ViewerHandler {
	return &ViewerHandler{store: store, log: log}
}

// Technicians — GET /audit/technicians.
func (h *ViewerHandler) Technicians(w http.ResponseWriter, r *http.Request) {
	techs, err := h.store.Technicians(r.Context())
	if err != nil {
		h.log.Error("list technicians failed", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, techs)
}

// Categories — GET /audit/technicians/categories?user_id=.
func (h *ViewerHandler) Categories(w http.ResponseWriter, r *http.Request) {
	userID := r.URL.Query().Get("user_id")
	if userID == "" {
		http.Error(w, "user_id is required", http.StatusBadRequest)
		return
	}
	cats, err := h.store.CategoryCounts(r.Context(), userID)
	if err != nil {
		h.log.Error("category counts failed", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, cats)
}

// Timeline — GET /audit/technicians/timeline?user_id=.
func (h *ViewerHandler) Timeline(w http.ResponseWriter, r *http.Request) {
	userID := r.URL.Query().Get("user_id")
	if userID == "" {
		http.Error(w, "user_id is required", http.StatusBadRequest)
		return
	}
	points, err := h.store.Timeline(r.Context(), userID)
	if err != nil {
		h.log.Error("timeline failed", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, points)
}

// Logs — GET /audit/logs?user_id=&search=&category=a,b&actions_only=1&errors_only=1&mission_only=1&before_id=&limit=.
func (h *ViewerHandler) Logs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	userID := q.Get("user_id")
	if userID == "" {
		http.Error(w, "user_id is required", http.StatusBadRequest)
		return
	}

	query := model.ListLogsQuery{
		UserID:      userID,
		Search:      q.Get("search"),
		ActionsOnly: q.Get("actions_only") == "1",
		ErrorsOnly:  q.Get("errors_only") == "1",
		MissionOnly: q.Get("mission_only") == "1",
	}
	if cats := q.Get("category"); cats != "" {
		query.Categories = strings.Split(cats, ",")
	}
	if v := q.Get("before_id"); v != "" {
		id, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			http.Error(w, "invalid before_id", http.StatusBadRequest)
			return
		}
		query.BeforeID = id
	}
	query.Limit = model.DefaultLogsLimit
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil {
			http.Error(w, "invalid limit", http.StatusBadRequest)
			return
		}
		query.Limit = n
	}

	rows, err := h.store.ListLogs(r.Context(), query)
	if err != nil {
		h.log.Error("list logs failed", "err", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	// Полная страница => скорее всего есть ещё более старые записи.
	writeJSON(w, map[string]any{
		"rows":    rows,
		"hasMore": len(rows) == query.Limit,
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("write json failed", "err", err)
	}
}
