package settings

import (
	"encoding/json"
	"testing"
)

func TestRegistry_DefaultsPassTheirOwnCheck(t *testing.T) {
	for key, def := range registry {
		raw, _ := json.Marshal(def.initial)
		var v any
		_ = json.Unmarshal(raw, &v)
		if _, err := def.check(v); err != nil {
			t.Errorf("%s: default %v is refused by its own check: %v", key, def.initial, err)
		}
	}
}

func TestRegistry_RangesAreEnforced(t *testing.T) {
	for _, c := range []struct {
		key string
		val any
		ok  bool
	}{
		{"brief.max_bytes", float64(4096), true}, {"brief.max_bytes", float64(4095), false}, {"brief.max_bytes", float64(65537), false}, {"brief.max_bytes", 1.5, false},
		{"inbox.visibility_default", "30s", true}, {"inbox.visibility_default", "29s", false}, {"inbox.visibility_default", "31m", false}, {"inbox.visibility_default", float64(5), false},
		{"notify.previews", "sender", true}, {"notify.previews", "all", false},
		{"transcription.engine", "none", true}, {"transcription.engine", "whisper-local", true}, {"transcription.engine", "", false}, {"transcription.engine", "Bad Name", false}, {"transcription.engine", true, false},
	} {
		if _, err := registry[c.key].check(c.val); (err == nil) != c.ok {
			t.Errorf("%s = %v: accepted=%v, want %v", c.key, c.val, err == nil, c.ok)
		}
	}
}
