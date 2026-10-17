package settings

import (
	"fmt"
	"slices"
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
	"notify.machine_requests":  {User, true, boolean},
	"notify.urgent_bypass":     {User, true, boolean},
	"palette":                  {User, "iris", oneOf("iris", "ember", "mono", "tide")},
	"inbox.visibility_default": {Workspace, "5m", duration(30*time.Second, 30*time.Minute)},
	"brief.max_bytes":          {Workspace, int64(12288), integer(4096, 65536)},
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
