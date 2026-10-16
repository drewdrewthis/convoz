package platform

import "sync"

// Frame is a live-only server-sent event: it has no seq, is never replayed and never stored (design §5.4).
type Frame struct {
	Event string
	Data  []byte
	// Conversation is the conversation the frame is about. A stream writes a frame only to a reader who may see
	// that conversation, as it does for a stored event. A frame with Conversation 0 is refused, so a publisher that
	// forgets the conversation leaks to nobody.
	Conversation int64
}

// Bus wakes the waiting streams and long polls after a commit. It carries no data from the database: a waiter
// that wakes reads the state again. It holds no clock; time is the caller's.
type Bus struct {
	mu       sync.Mutex
	changed  chan struct{}           // closed on every Notify
	identity map[int64]chan struct{} // closed when something for that identity changes
	subs     map[*Subscription]struct{}
}

// Subscription receives live frames. C is closed when the subscriber falls too far behind (it must refetch) or
// when it cancels.
type Subscription struct {
	C      chan Frame
	bus    *Bus
	closed bool
}

// frameBuffer is how many live frames a subscriber may lag by before it is cut off.
const frameBuffer = 256

// NewBus returns a bus with no waiters.
func NewBus() *Bus {
	return &Bus{changed: make(chan struct{}), identity: map[int64]chan struct{}{}, subs: map[*Subscription]struct{}{}}
}

// Changed returns a channel that closes at the next Notify. Take it BEFORE reading the state it guards, so a
// commit between the read and the wait is not missed.
func (b *Bus) Changed() <-chan struct{} {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.changed
}

// ChangedFor is Changed for one identity's inbox.
func (b *Bus) ChangedFor(identityID int64) <-chan struct{} {
	b.mu.Lock()
	defer b.mu.Unlock()
	ch, ok := b.identity[identityID]
	if !ok {
		ch = make(chan struct{})
		b.identity[identityID] = ch
	}
	return ch
}

// Notify wakes every waiter on Changed, and the waiters of each identity named. Call it after the commit.
func (b *Bus) Notify(identityIDs ...int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	close(b.changed)
	b.changed = make(chan struct{})
	for _, id := range identityIDs {
		if ch, ok := b.identity[id]; ok {
			close(ch)
			delete(b.identity, id)
		}
	}
}

// Subscribe starts receiving live frames.
func (b *Bus) Subscribe() *Subscription {
	s := &Subscription{C: make(chan Frame, frameBuffer), bus: b}
	b.mu.Lock()
	b.subs[s] = struct{}{}
	b.mu.Unlock()
	return s
}

// Cancel stops the subscription. It is safe to call twice.
func (s *Subscription) Cancel() {
	s.bus.mu.Lock()
	defer s.bus.mu.Unlock()
	s.bus.drop(s)
}

func (b *Bus) drop(s *Subscription) {
	if s.closed {
		return
	}
	s.closed = true
	delete(b.subs, s)
	close(s.C)
}

// Publish sends a live frame to every subscriber. A subscriber whose buffer is full is closed instead of waited for.
func (b *Bus) Publish(f Frame) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for s := range b.subs {
		select {
		case s.C <- f:
		default:
			b.drop(s)
		}
	}
}
