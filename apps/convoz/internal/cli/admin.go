// Package cli is the convoz command-line client. It imports internal/wire and nothing under internal/server.
package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Exit codes (design §13.2). Admin returns exactly these.
const (
	ExitOK          = 0
	ExitFailure     = 1 // any other failure (a 5xx, an unreadable answer)
	ExitUsage       = 2
	ExitAuth        = 3 // HTTP 401 or 403
	ExitConflict    = 4 // HTTP 409 (a name or handle is taken)
	ExitRateLimited = 5 // HTTP 429, also too_many_pending
	ExitNetwork     = 6 // the socket cannot be reached
	ExitNothing     = 3 // `watch --once --timeout` ended with no item; stderr tells it from a session that ended
)

// errUnreachable marks a failure to talk to the server at all (no socket, refused, timed out).
var errUnreachable = errors.New("server unreachable")

// statusError is an HTTP answer that was not 200.
type statusError struct {
	status int
	msg    string
	code   string // the server's error code, when it sent one
	// retryAfter is how long the server asked the caller to wait (Retry-After), 0 when it did not.
	retryAfter time.Duration
}

func (e *statusError) Error() string { return e.msg }

// exitCode maps an error to its §13.2 exit code. A 400 is a failure (1), not usage (2): usage means the command line was wrong.
func exitCode(err error) int {
	var se *statusError
	switch {
	case errors.Is(err, errUnreachable):
		return ExitNetwork
	case errors.Is(err, errAwaitingOwner):
		return ExitAuth
	case !errors.As(err, &se):
		return ExitFailure
	case se.status == http.StatusUnauthorized || se.status == http.StatusForbidden:
		return ExitAuth
	case se.status == http.StatusConflict:
		return ExitConflict
	case se.status == http.StatusTooManyRequests:
		return ExitRateLimited
	case se.status == http.StatusBadRequest && strings.HasPrefix(se.code, "app_"):
		return ExitUsage // the app is wrong, not the server: fix it and post again
	}
	return ExitFailure
}

// DefaultAdminSocket is where the service creates its admin socket.
const DefaultAdminSocket = "/run/convoz/admin.sock"

// Admin runs `convoz admin <command>`. It returns the process exit code.
func Admin(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] != "bootstrap-link" {
		fmt.Fprintln(stderr, "convoz: usage: convoz admin bootstrap-link [--admin-socket PATH]")
		return ExitUsage
	}
	fs := flag.NewFlagSet("admin bootstrap-link", flag.ContinueOnError)
	socket := fs.String("admin-socket", DefaultAdminSocket, "admin socket of the running server")
	fs.SetOutput(io.Discard)
	if err := fs.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			fs.SetOutput(stdout)
			fs.PrintDefaults()
			return ExitUsage
		}
		fmt.Fprintf(stderr, "convoz: %s\n", err)
		return ExitUsage
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	link, err := BootstrapLink(ctx, *socket)
	if err != nil {
		fmt.Fprintf(stderr, "convoz: %s\n", err)
		return exitCode(err)
	}
	fmt.Fprintln(stdout, link.URL)
	return ExitOK
}

// BootstrapLink asks the server over its admin socket for a one-time bootstrap link.
func BootstrapLink(ctx context.Context, socket string) (wire.BootstrapLink, error) {
	client := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		},
	}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://localhost"+wire.AdminBootstrapLink, bytes.NewReader([]byte("{}")))
	if err != nil {
		return wire.BootstrapLink{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return wire.BootstrapLink{}, fmt.Errorf("%w: cannot reach the admin socket %s: %v", errUnreachable, socket, err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<16))
	if res.StatusCode != http.StatusOK {
		var e wire.Error
		if json.Unmarshal(body, &e) == nil && e.Error.Message != "" {
			return wire.BootstrapLink{}, &statusError{status: res.StatusCode, msg: "server refused: " + e.Error.Message}
		}
		return wire.BootstrapLink{}, &statusError{status: res.StatusCode, msg: fmt.Sprintf("server answered %d", res.StatusCode)}
	}
	var link wire.BootstrapLink
	if err := json.Unmarshal(body, &link); err != nil || link.URL == "" {
		return wire.BootstrapLink{}, errors.New("server answered with an unreadable link")
	}
	return link, nil
}
