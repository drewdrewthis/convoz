//go:build testhooks

package httpapi

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/notify"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/testroutes"
)

// testPushHost is the one host the fake push service answers for; subscriptions to it pass the allow-list in this build.
const testPushHost = "push.testonly.example"

func init() {
	moduleHooks = append(moduleHooks, notifyHooks)
	if platform.HooksEnabled() {
		notify.AllowHost(testPushHost)
		testPushClient = func() notify.HTTPClient { return fake }
		testPushPaused = func() bool { return fake.held() }
	}
}

// fake is the process's fake push service. It never touches the network: every push the server posts, to any host, ends here.
var fake = &fakePush{status: map[string]int{}, received: []pushRecord{}}

// pushRecord is one push as the service received it. The body is the encrypted record, so a test with the subscription's private key can read it.
type pushRecord struct {
	Endpoint   string `json:"endpoint"`
	Topic      string `json:"topic"`
	Urgency    string `json:"urgency"`
	TTL        string `json:"ttl"`
	Encoding   string `json:"content_encoding"`
	Auth       string `json:"authorization"`
	Size       int    `json:"size"`
	BodyB64    string `json:"body"`
	Status     int    `json:"status"`
	ReceivedAt int64  `json:"received_at"`
}

type fakePush struct {
	mu       sync.Mutex
	store    *pdb.Store
	clock    platform.Clock
	status   map[string]int // endpoint -> the status to answer; absent is 201
	hold     bool
	received []pushRecord // kept in memory and in the data file, so a restart still shows what came before it
}

const fakeKV = "testhooks.push.received"

func (f *fakePush) held() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hold
}

// Do is the HTTP client the sender uses: it records the push and answers with the scripted status.
func (f *fakePush) Do(req *http.Request) (*http.Response, error) {
	body, err := io.ReadAll(req.Body)
	if err != nil {
		return nil, err
	}
	endpoint := req.URL.String()
	f.mu.Lock()
	code := http.StatusCreated
	if c, ok := f.status[endpoint]; ok {
		code = c
	}
	// Like Apple, refuse a VAPID token whose sub is not a mailto of one address or an https URL.
	if claims, err := notify.VAPIDClaims(req.Header.Get("Authorization")); err != nil {
		code = http.StatusForbidden
	} else if sub, _ := claims["sub"].(string); !notify.ValidVAPIDSubject(sub) {
		code = http.StatusForbidden
	}
	rec := pushRecord{
		Endpoint: endpoint, Topic: req.Header.Get("Topic"), Urgency: req.Header.Get("Urgency"), TTL: req.Header.Get("TTL"),
		Encoding: req.Header.Get("Content-Encoding"), Auth: req.Header.Get("Authorization"), Size: len(body),
		BodyB64: base64.StdEncoding.EncodeToString(body), Status: code, ReceivedAt: f.clock.Now().UnixMilli(),
	}
	f.received = append(f.received, rec)
	snapshot, _ := json.Marshal(f.received)
	store := f.store
	f.mu.Unlock()
	if store != nil {
		_ = store.Writer.Tx(req.Context(), func(ctx context.Context, tx *pdb.Tx) error {
			return pdb.New(tx.DBTX()).SetKV(ctx, pdb.SetKVParams{Key: fakeKV, Value: sql.NullString{String: string(snapshot), Valid: true}})
		})
	}
	return &http.Response{StatusCode: code, Status: strconv.Itoa(code), Header: http.Header{}, Body: io.NopCloser(strings.NewReader("")), Request: req}, nil
}

// notifyHooks registers the fake push service's route.
func notifyHooks(mux *http.ServeMux, s *Server) {
	fake.mu.Lock()
	fake.store, fake.clock = s.Store, s.Clock
	if v, err := pdb.New(s.Store.Reader.SQL()).GetKV(context.Background(), fakeKV); err == nil && v.Valid {
		_ = json.Unmarshal([]byte(v.String), &fake.received)
		if fake.received == nil {
			fake.received = []pushRecord{}
		}
	} else if err != nil && !errors.Is(err, sql.ErrNoRows) {
		s.Log.Printf("fake push: %v", err)
	}
	fake.mu.Unlock()
	mux.HandleFunc(testroutes.Push, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			fake.mu.Lock()
			defer fake.mu.Unlock()
			reply(w, nil, map[string]any{"received": fake.received})
			return
		}
		var in struct {
			Status map[string]int `json:"status"`
			Hold   *bool          `json:"hold"`
			Rewind bool           `json:"rewind"`
		}
		if json.NewDecoder(r.Body).Decode(&in) != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		fake.mu.Lock()
		for endpoint, code := range in.Status {
			fake.status[endpoint] = code
		}
		if in.Hold != nil {
			fake.hold = *in.Hold
		}
		fake.mu.Unlock()
		var err error
		if in.Rewind {
			err = s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
				return pdb.New(tx.DBTX()).SetConsumerOffset(ctx, pdb.SetConsumerOffsetParams{Consumer: "push", LastEventID: 0, Now: s.Clock.Now().UnixMilli()})
			})
		}
		reply(w, err, nil)
	})
}
