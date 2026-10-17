package settings

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
)

// Scope says who a setting belongs to: the whole workspace (the owner's to change) or one user.
type Scope string

const (
	Workspace Scope = "workspace"
	User      Scope = "user"
)

// def is one registry row. check turns a decoded JSON value into the value to store, or says why it is not allowed.
type def struct {
	scope   Scope
	initial any
	check   func(v any) (any, error)
}

// registry is the whole set of server settings (design §11). A key not listed here does not exist (I-29).
var registry = map[string]def{
	"notify.previews":          {User, "full", oneOf("full", "sender", "none")},
	"notify.asks":              {User, "all", oneOf("all", "urgent", "none")},
	"notify.mentions":          {User, true, boolean},
	"notify.threads":           {User, true, boolean},
	"notify.pending_adds":      {User, true, boolean},
	"notify.machine_requests":  {User, true, boolean},
	"notify.urgent_bypass":     {User, true, boolean},
	"notify.quiet_hours":       {User, nil, quietHours},
	"palette":                  {User, "iris", oneOf("iris", "ember", "mono", "tide")},
	"inbox.visibility_default": {Workspace, "5m", duration(30*time.Second, 30*time.Minute)},
	"brief.max_bytes":          {Workspace, int64(12288), integer(4096, 65536)},
	// The engine that turns voice notes into words: "none", or the name of an engine the build has (the transcript module resolves it).
	"transcription.engine": {Workspace, "none", engineName},
}

// Keys lists every registry key in a fixed order.
func Keys() []string {
	keys := make([]string, 0, len(registry))
	for k := range registry {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

// engineName accepts 1 to 32 characters of a-z, 0-9 and "-"; whether the build has that engine is the transcript module's to say.
func engineName(v any) (any, error) {
	if s, ok := v.(string); ok && s != "" && len(s) <= 32 && strings.Trim(s, "abcdefghijklmnopqrstuvwxyz0123456789-") == "" {
		return s, nil
	}
	return nil, fmt.Errorf("must be an engine name such as \"none\"")
}

func boolean(v any) (any, error) {
	if b, ok := v.(bool); ok {
		return b, nil
	}
	return nil, fmt.Errorf("must be true or false")
}

func oneOf(allowed ...string) func(any) (any, error) {
	return func(v any) (any, error) {
		if s, ok := v.(string); ok && slices.Contains(allowed, s) {
			return s, nil
		}
		return nil, fmt.Errorf("must be one of %v", allowed)
	}
}

func integer(lo, hi int64) func(any) (any, error) {
	return func(v any) (any, error) {
		if f, ok := v.(float64); ok && f == float64(int64(f)) && int64(f) >= lo && int64(f) <= hi {
			return int64(f), nil
		}
		return nil, fmt.Errorf("must be a whole number from %d to %d", lo, hi)
	}
}

var clockTime = regexp.MustCompile(`^([01][0-9]|2[0-3]):[0-5][0-9]$`)

// quietHours accepts null (no quiet hours) or {"start": "22:00", "end": "07:00", "tz": "Europe/Berlin"}: clock times in a
// zone (UTC when tz is left out). End before start is a window over midnight. It stores the three fields, none missing.
func quietHours(v any) (any, error) {
	if v == nil {
		return nil, nil
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("must be null or {start, end, tz}")
	}
	out := map[string]any{"tz": "UTC"}
	for k, raw := range m {
		str, isStr := raw.(string)
		switch {
		case !isStr:
			return nil, fmt.Errorf("%s must be text", k)
		case k == "start" || k == "end":
			if !clockTime.MatchString(str) {
				return nil, fmt.Errorf("%s must be a time like 22:00", k)
			}
		case k == "tz":
			if _, err := time.LoadLocation(str); err != nil || str == "" {
				return nil, fmt.Errorf("tz must be a zone like Europe/Berlin")
			}
		default:
			return nil, fmt.Errorf("has no field %q", k)
		}
		out[k] = str
	}
	if out["start"] == nil || out["end"] == nil {
		return nil, fmt.Errorf("needs start and end")
	}
	return out, nil
}

// duration accepts a Go duration string ("5m", "90s") inside [lo, hi] and stores it as written.
func duration(lo, hi time.Duration) func(any) (any, error) {
	return func(v any) (any, error) {
		if s, ok := v.(string); ok {
			if d, err := time.ParseDuration(s); err == nil && d >= lo && d <= hi {
				return s, nil
			}
		}
		return nil, fmt.Errorf("must be a duration from %s to %s", lo, hi)
	}
}
