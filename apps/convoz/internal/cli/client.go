package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// requestTimeout bounds one HTTP call; the login poll loop retries a call that timed out.
const requestTimeout = 10 * time.Second

var errNotLoggedIn = errors.New("this machine is not logged in: run convoz login")

// client talks to one server.
type client struct {
	base string
	http *http.Client
}

// validServer accepts an https URL, or an http URL on localhost or a loopback address (development).
func validServer(raw string) (string, error) {
	u, err := url.Parse(strings.TrimRight(raw, "/"))
	if err != nil || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return "", fmt.Errorf("--server %q is not a server address like https://convoz.example.ts.net", raw)
	}
	switch u.Scheme {
	case "https":
	case "http":
		host := u.Hostname()
		if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			return "", fmt.Errorf("--server %q: http is only allowed for localhost; use https", raw)
		}
	default:
		return "", fmt.Errorf("--server %q must start with https://", raw)
	}
	return u.String(), nil
}

func newClient(server string) *client {
	return &client{base: server, http: &http.Client{Timeout: requestTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

// call sends one JSON request. token, when set, is sent as a bearer credential. A non-2xx answer is a
// *statusError carrying the server's code and message; a failure to reach the server wraps errUnreachable.
func (c *client) call(ctx context.Context, method, path, token string, in, out any) error {
	var body io.Reader
	if in != nil {
		raw, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, body)
	if err != nil {
		return err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("%w: cannot reach %s: %v", errUnreachable, c.base, err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("%w: the answer from %s was cut off: %v", errUnreachable, c.base, err)
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		var e wire.Error
		if json.Unmarshal(raw, &e) == nil && e.Error.Code != "" {
			return &statusError{status: res.StatusCode, code: e.Error.Code, msg: e.Error.Message}
		}
		return &statusError{status: res.StatusCode, msg: fmt.Sprintf("the server answered %d", res.StatusCode)}
	}
	if out == nil || len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("the server's answer is not readable: %w", err)
	}
	return nil
}

// statusCode is the HTTP status of err, or 0.
func statusCode(err error) (int, string) {
	var se *statusError
	if errors.As(err, &se) {
		return se.status, se.code
	}
	return 0, ""
}
