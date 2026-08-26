// Package model содержит структуры данных audit-лога — контракт совпадает с
// телом запроса HttpAuditSink из пакета fieldlog (см. docs/guides/AUDIT_BACKEND_GUIDE.md
// в rs_tech).
package model

import "encoding/json"

// Entry — одна запись audit-лога. Обязательны Timestamp/Category/LogType/EventName,
// остальные поля опциональны (могут отсутствовать или быть null).
type Entry struct {
	Timestamp          string          `json:"timestamp"`
	Category           string          `json:"category"`
	LogType            string          `json:"logType"`
	EventName          string          `json:"eventName"`
	Payload            json.RawMessage `json:"payload,omitempty"`
	UserID             *string         `json:"userId,omitempty"`
	UserLabel          *string         `json:"userLabel,omitempty"`
	DeviceID           *string         `json:"deviceId,omitempty"`
	AppVersion         *string         `json:"appVersion,omitempty"`
	Platform           *string         `json:"platform,omitempty"`
	OSVersion          *string         `json:"osVersion,omitempty"`
	DeviceModel        *string         `json:"deviceModel,omitempty"`
	NetworkType        *string         `json:"networkType,omitempty"`
	NetworkSignalLevel *int            `json:"networkSignalLevel,omitempty"`
	Permissions        json.RawMessage `json:"permissions,omitempty"`
	BatteryLevel       *int            `json:"batteryLevel,omitempty"`
	BatteryState       *string         `json:"batteryState,omitempty"`
	PowerSaveMode      *bool           `json:"powerSaveMode,omitempty"`
}

// BatchRequest — тело POST /audit/batch.
type BatchRequest struct {
	Entries []Entry `json:"entries"`
}

// Validate проверяет обязательные поля записи (§1 гайда).
func (e Entry) Validate() error {
	if e.Timestamp == "" {
		return errRequired("timestamp")
	}
	if e.Category == "" {
		return errRequired("category")
	}
	if e.LogType == "" {
		return errRequired("logType")
	}
	if e.EventName == "" {
		return errRequired("eventName")
	}
	return nil
}

func errRequired(field string) error {
	return &ValidationError{Field: field}
}

// ValidationError — отсутствует обязательное поле записи.
type ValidationError struct {
	Field string
}

func (e *ValidationError) Error() string {
	return "missing required field: " + e.Field
}
