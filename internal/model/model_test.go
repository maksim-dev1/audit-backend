package model

import "testing"

func TestEntryValidate(t *testing.T) {
	valid := Entry{Timestamp: "2026-08-21T12:00:00.000Z", Category: "test", LogType: "info", EventName: "ok"}
	if err := valid.Validate(); err != nil {
		t.Fatalf("expected valid entry to pass, got %v", err)
	}

	cases := []struct {
		name  string
		entry Entry
	}{
		{"missing timestamp", Entry{Category: "c", LogType: "info", EventName: "e"}},
		{"missing category", Entry{Timestamp: "t", LogType: "info", EventName: "e"}},
		{"missing logType", Entry{Timestamp: "t", Category: "c", EventName: "e"}},
		{"missing eventName", Entry{Timestamp: "t", Category: "c", LogType: "info"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.entry.Validate(); err == nil {
				t.Fatalf("expected validation error for %s", tc.name)
			}
		})
	}
}
