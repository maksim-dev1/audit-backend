package httpapi

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"audit-backend/internal/model"
)

type stubStore struct {
	inserted []model.Entry
	err      error
}

func (s *stubStore) InsertBatch(_ context.Context, entries []model.Entry) error {
	if s.err != nil {
		return s.err
	}
	s.inserted = entries
	return nil
}

func newTestHandler(store *stubStore) *Handler {
	return New(store, "secret-key", 1000, 1000, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func doBatch(h *Handler, authHeader, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/audit/batch", bytes.NewBufferString(body))
	if authHeader != "" {
		req.Header.Set("Authorization", authHeader)
	}
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.Batch(rec, req)
	return rec
}

const validBody = `{"entries":[{"timestamp":"2026-08-21T12:00:00.000Z","category":"test","logType":"info","eventName":"ok"}]}`

func TestBatch_Unauthorized(t *testing.T) {
	h := newTestHandler(&stubStore{})
	rec := doBatch(h, "Bearer wrong-key", validBody)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestBatch_MissingAuthHeader(t *testing.T) {
	h := newTestHandler(&stubStore{})
	rec := doBatch(h, "", validBody)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestBatch_Success(t *testing.T) {
	store := &stubStore{}
	h := newTestHandler(store)
	rec := doBatch(h, "Bearer secret-key", validBody)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", rec.Code, rec.Body.String())
	}
	if len(store.inserted) != 1 {
		t.Fatalf("expected 1 entry inserted, got %d", len(store.inserted))
	}
}

func TestBatch_EmptyEntries(t *testing.T) {
	h := newTestHandler(&stubStore{})
	rec := doBatch(h, "Bearer secret-key", `{"entries":[]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestBatch_MissingRequiredField(t *testing.T) {
	h := newTestHandler(&stubStore{})
	rec := doBatch(h, "Bearer secret-key", `{"entries":[{"category":"c","logType":"info","eventName":"e"}]}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestBatch_ExceedsMaxSize(t *testing.T) {
	h := newTestHandler(&stubStore{})
	var sb strings.Builder
	sb.WriteString(`{"entries":[`)
	for i := range maxBatchSize + 1 {
		if i > 0 {
			sb.WriteString(",")
		}
		sb.WriteString(`{"timestamp":"2026-08-21T12:00:00.000Z","category":"c","logType":"info","eventName":"e"}`)
	}
	sb.WriteString(`]}`)
	rec := doBatch(h, "Bearer secret-key", sb.String())
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func TestBatch_InvalidJSON(t *testing.T) {
	h := newTestHandler(&stubStore{})
	rec := doBatch(h, "Bearer secret-key", `not-json`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}
