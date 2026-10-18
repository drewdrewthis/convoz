package auth

import (
	"sort"
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
		l.shrink(now)
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

// shrink drops the keys with no hit in the window; if the map is still over maxKeys (a flood of live keys), it drops the keys whose
// latest hit is oldest until it is back to maxKeys/2, so the map never grows without a bound.
func (l *Limiter) shrink(now time.Time) {
	for k, h := range l.hits {
		if len(h) == 0 || now.Sub(h[len(h)-1]) >= l.Window {
			delete(l.hits, k)
		}
	}
	if len(l.hits) <= maxKeys {
		return
	}
	type last struct {
		key string
		at  time.Time
	}
	all := make([]last, 0, len(l.hits))
	for k, h := range l.hits {
		all = append(all, last{k, h[len(h)-1]})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].at.Before(all[j].at) })
	for _, e := range all[:len(all)-maxKeys/2] {
		delete(l.hits, e.key)
	}
}
