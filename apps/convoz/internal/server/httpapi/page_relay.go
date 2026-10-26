package httpapi

import (
	"crypto/rand"
	"encoding/base64"
	"sync"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// The page relay (page-share.feature): the shares the owner's extension holds and the one request in flight for each. It lives in
// memory only, so a restart ends every share; the extension sees 404 on its next poll and offers "Share this tab" again.
const (
	// pageWaitMax is how long an agent's request waits for the extension; the CLI's default timeout (30 s) is longer.
	pageWaitMax = 25 * time.Second
	// pagePollMax caps the extension's long poll (?wait=N seconds).
	pagePollMax = 25 * time.Second
	// pageHeartbeat ends a share whose extension has not polled for this long: the panel was closed without its goodbye.
	pageHeartbeat = 45 * time.Second
	// pageShotEvery is the least time between two screenshots of one share.
	pageShotEvery = 2 * time.Second
)

// pageRelay is the state of all shares. The zero value is ready.
type pageRelay struct {
	mu       sync.Mutex
	shares   map[string]*pageShare   // by id
	byConv   map[int64]*pageShare    // the one live share of a conversation
	requests map[string]*pageRequest // in flight, by id
}

// pageShare is one tab shared with one conversation by one person.
type pageShare struct {
	id       string
	conv     int64
	origin   string
	owner    int64 // the person who shared it: only that person's extension polls, answers and ends it
	lastPoll time.Time
	lastShot time.Time
	inflight *pageRequest
	wake     chan struct{} // a new request for the long poll; buffered 1
	ended    chan struct{} // closed when the share ends
}

// pageRequest is one agent's read or shot, waiting for the extension.
type pageRequest struct {
	id    string
	op    string
	share *pageShare
	taken bool             // a poll handed it to the extension
	done  chan pageOutcome // buffered 1: the extension's answer
}

// pageOutcome is what the agent's request ends with.
type pageOutcome struct {
	result wire.PageResult
	status int // 0 for a result the extension sent; else the error status (413: the answer was too big)
}

func randomPageID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b) // never fails (crypto/rand)
	return base64.RawURLEncoding.EncodeToString(b)
}

func (p *pageRelay) init() {
	if p.shares == nil {
		p.shares, p.byConv, p.requests = map[string]*pageShare{}, map[int64]*pageShare{}, map[string]*pageRequest{}
	}
}

// live is the share of id if it is still live at now; a share past its heartbeat ends here. Call with mu held.
func (p *pageRelay) live(share *pageShare, now time.Time) *pageShare {
	if share == nil {
		return nil
	}
	if now.Sub(share.lastPoll) > pageHeartbeat {
		p.end(share)
		return nil
	}
	return share
}

// end removes the share and fails its request in flight. Call with mu held.
func (p *pageRelay) end(share *pageShare) {
	if p.shares[share.id] != share {
		return
	}
	delete(p.shares, share.id)
	if p.byConv[share.conv] == share {
		delete(p.byConv, share.conv)
	}
	if share.inflight != nil {
		delete(p.requests, share.inflight.id)
		share.inflight = nil
	}
	close(share.ended)
}

// start shares a tab of origin with conv, ending the conversation's older share.
func (p *pageRelay) start(conv, owner int64, origin string, now time.Time) wire.PageShare {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.init()
	if old := p.byConv[conv]; old != nil {
		p.end(old)
	}
	share := &pageShare{id: randomPageID(), conv: conv, origin: origin, owner: owner, lastPoll: now, wake: make(chan struct{}, 1), ended: make(chan struct{})}
	p.shares[share.id] = share
	p.byConv[conv] = share
	return wire.PageShare{ID: share.id, ConversationID: conv, TabOrigin: origin}
}

// stop ends the share id of owner; false when there is none.
func (p *pageRelay) stop(id string, owner int64) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	share := p.shares[id]
	if share == nil || share.owner != owner {
		return false
	}
	p.end(share)
	return true
}

// list is the live shares of the conversations visible says the caller sees.
func (p *pageRelay) list(now time.Time, visible func(conv int64) bool) []wire.PageShare {
	p.mu.Lock()
	var mine []wire.PageShare
	for _, share := range p.byConv {
		if p.live(share, now) != nil {
			mine = append(mine, wire.PageShare{ID: share.id, ConversationID: share.conv, TabOrigin: share.origin})
		}
	}
	p.mu.Unlock()
	out := []wire.PageShare{} // visible reads the database: never under mu
	for _, s := range mine {
		if visible(s.ConversationID) {
			out = append(out, s)
		}
	}
	return out
}

// Why a request cannot be queued.
const (
	pageNoShare = iota + 1
	pageBusy
	pageTooSoon
)

// ask queues an agent's request on the live share of conv; refused says why not (pageNoShare, pageBusy, pageTooSoon).
func (p *pageRelay) ask(conv int64, op string, now time.Time) (req *pageRequest, refused int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.init()
	share := p.live(p.byConv[conv], now)
	switch {
	case share == nil:
		return nil, pageNoShare
	case share.inflight != nil:
		return nil, pageBusy
	case op == wire.PageOpShot && !share.lastShot.IsZero() && now.Sub(share.lastShot) < pageShotEvery:
		return nil, pageTooSoon
	}
	if op == wire.PageOpShot {
		share.lastShot = now
	}
	req = &pageRequest{id: randomPageID(), op: op, share: share, done: make(chan pageOutcome, 1)}
	share.inflight = req
	p.requests[req.id] = req
	select {
	case share.wake <- struct{}{}:
	default:
	}
	return req, 0
}

// drop forgets req when nobody answered it in time, so the share takes the next request.
func (p *pageRelay) drop(req *pageRequest) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.requests[req.id] == req {
		delete(p.requests, req.id)
	}
	if req.share.inflight == req {
		req.share.inflight = nil
	}
}

// poll is one turn of the extension's long poll: the share's waiting request, or nil. found is false when the share id of owner
// is not live; then the extension stops polling. Each poll is the share's heartbeat.
func (p *pageRelay) poll(id string, owner int64, now time.Time) (share *pageShare, req *pageRequest, found bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	share = p.live(p.shares[id], now)
	if share == nil || share.owner != owner {
		return nil, nil, false
	}
	share.lastPoll = now
	if r := share.inflight; r != nil && !r.taken {
		r.taken = true
		return share, r, true
	}
	return share, nil, true
}

// answer hands the extension's outcome to the request id of owner's share; false when no such request waits.
func (p *pageRelay) answer(id string, owner int64, out pageOutcome) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	req := p.requests[id]
	if req == nil || req.share.owner != owner || !req.taken {
		return false
	}
	delete(p.requests, id)
	if req.share.inflight == req {
		req.share.inflight = nil
	}
	req.done <- out
	return true
}

// request is the request id of owner's share that the extension holds, for checking an answer before it is read; nil when none.
func (p *pageRelay) request(id string, owner int64) *pageRequest {
	p.mu.Lock()
	defer p.mu.Unlock()
	req := p.requests[id]
	if req == nil || req.share.owner != owner || !req.taken {
		return nil
	}
	return req
}
