package httpapi

import (
	"context"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"testing"
	"time"
)

// The real agent server: once its ctx (the signal context) is cancelled, shuttingDown is true for a request it serves, so a cancel
// at SIGTERM stays a 500 (issue 125). shuttingDown calls BaseContext(nil), so this fails if BaseContext starts using its argument.
func TestTheAgentServerIsShuttingDownOnceItsContextIsCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	hs := NewServer(nil, nil, nil, nil, Config{}, nil).AgentHTTPServer(ctx, log.New(io.Discard, "", 0), time.Second)
	hs.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, strconv.FormatBool(shuttingDown(r)))
	})
	hs.SetKeepAlivesEnabled(false)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = hs.Serve(ln) }()
	defer hs.Close()

	ask := func() string {
		res, err := http.Get("http://" + ln.Addr().String() + "/")
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return string(b)
	}
	if got := ask(); got != "false" {
		t.Fatalf("server up: shuttingDown answered %q, want false", got)
	}
	cancel() // SIGTERM
	if got := ask(); got != "true" {
		t.Fatalf("ctx cancelled: shuttingDown answered %q, want true", got)
	}
}
