package auth

import (
	"sync"
	"time"
)

// Limiter is a sliding-window counter in memory: at most Max hits per key within Window.
// A restart forgets the counts, which is fine for abuse limits (design §7 DEFAULT 12).
type Limiter struct {
	Window time.Duration
	Max    int

	mu   sync.Mutex
	hits map[string][]time.Time
}

// RetryAfter is how long until key may hit again: zero when it may now, else until its oldest hit leaves the window.
func (l *Limiter) RetryAfter(key string, now time.Time) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	hits := l.hits[key]
	cutoff := now.Add(-l.Window)
	live := 0
	for _, t := range hits {
		if t.After(cutoff) {
			live++
		}
	}
	if live < l.Max {
		return 0
	}
	for _, t := range hits {
		if t.After(cutoff) {
			return t.Add(l.Window).Sub(now)
		}
	}
	return 0
}

// maxKeys bounds memory: past it, keys with no hit in the window are dropped.
const maxKeys = 10_000

// Allow records a hit for key at now and reports whether it is within the limit.
// A refused hit is not recorded, so a flood cannot extend its own block.
func (l *Limiter) Allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.hits == nil {
		l.hits = map[string][]time.Time{}
	}
	if len(l.hits) > maxKeys {
		for k, h := range l.hits {
			if len(h) == 0 || now.Sub(h[len(h)-1]) >= l.Window {
				delete(l.hits, k)
			}
		}
	}
	cutoff := now.Add(-l.Window)
	kept := l.hits[key][:0]
	for _, t := range l.hits[key] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= l.Max {
		l.hits[key] = kept
		return false
	}
	l.hits[key] = append(kept, now)
	return true
}
