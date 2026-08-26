package model

import (
	"encoding/json"
	"time"
)

// LogRow — запись audit_logs как читается из БД (для веб-вьювера, см.
// docs/guides/AUDIT_BACKEND_GUIDE.md §4). В отличие от Entry (тело входящего
// запроса), тут Timestamp/ReceivedAt — уже time.Time, плюс ID.
type LogRow struct {
	ID                 int64           `json:"id"`
	Timestamp          time.Time       `json:"timestamp"`
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
	ReceivedAt         time.Time       `json:"receivedAt"`
}

// Technician — техник (user_id/user_label), агрегат для шапки-переключателя
// вьювера: последнее известное устройство + счётчики за всё время.
type Technician struct {
	UserID      string    `json:"userId"`
	UserLabel   string    `json:"userLabel,omitempty"`
	DeviceModel string    `json:"deviceModel,omitempty"`
	Platform    string    `json:"platform,omitempty"`
	OSVersion   string    `json:"osVersion,omitempty"`
	AppVersion  string    `json:"appVersion,omitempty"`
	Total       int64     `json:"total"`
	Errors      int64     `json:"errors"`
	Warnings    int64     `json:"warnings"`
	LastSeen    time.Time `json:"lastSeen"`
}

// CategoryCount — количество записей по category (для чипов фильтра).
type CategoryCount struct {
	Category string `json:"category"`
	Count    int64  `json:"count"`
}

// TimelinePoint — облегчённая запись warning/error для полосы таймлайна
// (без payload — только то, что нужно для точки на шкале и перехода к строке).
type TimelinePoint struct {
	ID        int64     `json:"id"`
	Timestamp time.Time `json:"timestamp"`
	EventName string    `json:"eventName"`
	Category  string    `json:"category"`
	LogType   string    `json:"logType"`
}

// Границы страницы для GET /audit/logs (см. internal/store.ListLogs).
const (
	DefaultLogsLimit = 200
	MaxLogsLimit     = 500
)

// ListLogsQuery — параметры GET /audit/logs (см. internal/store.ListLogs).
type ListLogsQuery struct {
	UserID      string
	Search      string
	Categories  []string
	ActionsOnly bool
	ErrorsOnly  bool
	MissionOnly bool
	BeforeID    int64
	Limit       int
}
