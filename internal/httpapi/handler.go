// Package httpapi реализует HTTP-приём audit-пачек (§1, §5 AUDIT_BACKEND_GUIDE.md):
// авторизация статическим ключом, парсинг/валидация, batch insert, 202 Accepted.
package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"golang.org/x/time/rate"

	"audit-backend/internal/model"
)

// Inserter — интерфейс хранилища, нужный обработчику (см. store.Store.InsertBatch).
type Inserter interface {
	InsertBatch(ctx context.Context, entries []model.Entry) error
}

// Handler — обработчик POST /audit/batch.
type Handler struct {
	store   Inserter
	apiKey  string
	limiter *rate.Limiter
	log     *slog.Logger
}

// maxBatchSize — верхняя граница, совпадает с maxBatchSize клиента
// HttpAuditSink (§2 гайда); защита от аномального тела запроса.
const maxBatchSize = 50

// New создаёт Handler. rateLimit/burst — общий (не per-IP) лимит запросов —
// это внутренний телеметрический канал одного приложения, не публичный API
// (см. §8 гайда — защита от шторма самологирующихся ошибок).
func New(store Inserter, apiKey string, rateLimit float64, burst int, log *slog.Logger) *Handler {
	return &Handler{
		store:   store,
		apiKey:  apiKey,
		limiter: rate.NewLimiter(rate.Limit(rateLimit), burst),
		log:     log,
	}
}

// Batch — POST /audit/batch.
func (h *Handler) Batch(w http.ResponseWriter, r *http.Request) {
	if !h.checkAuth(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if !h.limiter.Allow() {
		http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
		return
	}

	var req model.BatchRequest
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		http.Error(w, "invalid json body", http.StatusBadRequest)
		return
	}
	if len(req.Entries) == 0 {
		http.Error(w, "entries must not be empty", http.StatusBadRequest)
		return
	}
	if len(req.Entries) > maxBatchSize {
		http.Error(w, "entries exceeds max batch size", http.StatusBadRequest)
		return
	}
	for i, e := range req.Entries {
		if err := e.Validate(); err != nil {
			h.log.Warn("invalid entry", "index", i, "err", err)
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	}

	if err := h.store.InsertBatch(r.Context(), req.Entries); err != nil {
		h.log.Error("insert batch failed", "err", err, "count", len(req.Entries))
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	h.log.Info("batch inserted", "count", len(req.Entries))
	w.WriteHeader(http.StatusAccepted)
}

func (h *Handler) checkAuth(r *http.Request) bool {
	const prefix = "Bearer "
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, prefix) {
		return false
	}
	token := auth[len(prefix):]
	return subtle.ConstantTimeCompare([]byte(token), []byte(h.apiKey)) == 1
}
