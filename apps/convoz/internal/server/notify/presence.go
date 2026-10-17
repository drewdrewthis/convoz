package notify

import (
	"sync"
	"time"
)

// focusTTL is how long a device's "I am looking at conversation N" lasts. The client repeats it every 30 s while it looks.
const focusTTL = 90 * time.Second

// Presence remembers which conversation each device has open and focused, so a push for it is held back (active_here).
// It lives in memory: after a restart the first report from each device brings it back, and a push that slips through is harmless.
type Presence struct {
	mu sync.Mutex
	by map[int64]focus // device -> where it looks
}

type focus struct {
	conversation int64
	at           time.Time
}

// Set records that the device looks at the conversation (0 for none).
func (p *Presence) Set(device, conversation int64, now time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.by == nil {
		p.by = map[int64]focus{}
	}
	if conversation == 0 {
		delete(p.by, device)
		return
	}
	p.by[device] = focus{conversation, now}
}

// On reports whether some device looks at the conversation now.
func (p *Presence) On(conversation int64, now time.Time) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, f := range p.by {
		if f.conversation == conversation && now.Sub(f.at) < focusTTL {
			return true
		}
	}
	return false
}
