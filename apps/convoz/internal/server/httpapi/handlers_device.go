package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/tailnet"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// hostInfoLimit caps each self-reported field so the stored JSON stays under the column's 200 characters.
const hostInfoLimit = 30

// clip keeps printable ASCII only (the owner reads this text and a machine controls it: no control, bidi or
// look-alike characters), then cuts it to hostInfoLimit.
func clip(s string) string {
	out := make([]byte, 0, hostInfoLimit)
	for i := 0; i < len(s) && len(out) < hostInfoLimit; i++ {
		if c := s[i]; c >= 0x20 && c <= 0x7e {
			out = append(out, c)
		}
	}
	return string(out)
}

// interval is the poll interval new device requests get: 5 s, or what the test build asks for.
func (s *Server) interval() time.Duration {
	if d, ok := platform.PollIntervalOverride(); ok {
		return d
	}
	return auth.DefaultInterval
}

// nodeName asks Tailscale which node an address belongs to. It is empty when Tailscale is off, the address
// is not an IP, or whois cannot say: the owner then sees "unknown". It is shown, never trusted.
func (s *Server) nodeName(ctx context.Context, source string) string {
	if !s.Cfg.TailscaleOn || net.ParseIP(source) == nil {
		return ""
	}
	node, err := tailnet.Whois(ctx, s.Cfg.TailscaleBin, source)
	if err != nil {
		return ""
	}
	return node.Name
}

func (s *Server) deviceCode(w http.ResponseWriter, r *http.Request, _ *call) {
	var in wire.DeviceCodeRequest
	if !decode(w, r, &in) {
		return
	}
	if !auth.ValidMachineName(in.Name) {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "name", "A machine name has 1 to 60 characters from a-z, 0-9, . and -.")
		return
	}
	info, _ := json.Marshal(wire.HostInfo{Hostname: clip(in.HostInfo.Hostname), OS: clip(in.HostInfo.OS), Arch: clip(in.HostInfo.Arch), CLIVersion: clip(in.HostInfo.CLIVersion)})
	source := s.source(r)
	req := auth.DeviceRequest{Name: in.Name, HostInfo: string(info), Source: source, SourceNode: s.nodeName(r.Context(), source), Interval: s.interval()}
	var out auth.DeviceCode
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		out, err = auth.RequestDeviceCode(ctx, tx.DBTX(), req, s.userCodes, s.Clock.Now())
		return err
	})
	var limited *auth.RateLimitedError
	switch {
	case errors.Is(err, auth.ErrTooManyPending):
		writeErr(w, http.StatusTooManyRequests, wire.CodeTooManyPending, "Three machines are already waiting. Deny the waiting requests in Convoz, then run convoz login again.")
	case errors.Is(err, auth.ErrPendingFull):
		writeErr(w, http.StatusTooManyRequests, wire.CodeTooManyPending, "Too many machines are waiting. Deny the waiting requests in Convoz, then run convoz login again.")
	case errors.As(err, &limited):
		retryAfter(w, limited.RetryAfter)
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "This machine asked too often. Try again later.")
	case err != nil:
		s.internalError(w, r, err)
	default:
		writeJSON(w, http.StatusOK, wire.DeviceCodeResponse{
			DeviceCode: out.DeviceCode, UserCode: out.UserCode,
			Interval: max(1, int(out.Interval/time.Second)), IntervalMs: out.Interval.Milliseconds(), ExpiresIn: int(out.ExpiresIn / time.Second),
		})
	}
}

// expiredToken is the one answer for every code that is not worth anything: unknown, expired, denied and
// told, or already used. The same bytes every time, so a probe learns nothing.
func expiredToken(w http.ResponseWriter) {
	writeErr(w, http.StatusBadRequest, wire.CodeExpiredToken, "That code is not valid any more. Run convoz login again.")
}

func (s *Server) deviceToken(w http.ResponseWriter, r *http.Request, _ *call) {
	var in wire.DeviceTokenRequest
	if !decode(w, r, &in) {
		return
	}
	// A code that is not live is answered from the reader: a probe with wrong codes never takes the writer.
	now := s.Clock.Now()
	live, err := auth.DeviceCodeLive(r.Context(), s.reader(), in.DeviceCode, now)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !live {
		if !s.tokenMissLimit.Allow(s.source(r), now) {
			w.Header().Set("Retry-After", "60")
			writeErr(w, http.StatusTooManyRequests, "rate_limited", "Too many tries. Wait a minute.")
			return
		}
		expiredToken(w)
		return
	}
	var res auth.PollResult
	err = s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		res, err = auth.PollDeviceCode(ctx, tx.DBTX(), s.Keys, in.DeviceCode, now)
		return err
	})
	switch {
	case err != nil:
		s.internalError(w, r, err)
	case res.Outcome == auth.PollPending:
		writeErr(w, http.StatusBadRequest, wire.CodeAuthorizationPending, "Waiting for the owner to approve.")
	case res.Outcome == auth.PollSlowDown:
		writeErr(w, http.StatusBadRequest, wire.CodeSlowDown, "Poll less often.")
	case res.Outcome == auth.PollDenied:
		writeErr(w, http.StatusBadRequest, wire.CodeAccessDenied, "The owner denied the request.")
	case res.Outcome == auth.PollApproved:
		writeJSON(w, http.StatusOK, wire.DeviceTokenResponse{MachineKey: res.Key, MachineID: res.MachineID, MachineName: res.MachineName})
	default:
		expiredToken(w)
	}
}

// retryAfter sets the Retry-After header in whole seconds, at least 1.
func retryAfter(w http.ResponseWriter, d time.Duration) {
	w.Header().Set("Retry-After", strconv.Itoa(max(1, int((d+time.Second-1)/time.Second))))
}

// requestJSON is one pending machine request as the owner sees it.
type requestJSON struct {
	ID        int64           `json:"id"`
	Name      string          `json:"name"`
	UserCode  string          `json:"user_code"`
	HostInfo  json.RawMessage `json:"host_info"`
	SourceIP  *string         `json:"source_ip"`
	NodeName  *string         `json:"node_name"`
	CreatedAt int64           `json:"created_at"`
	ExpiresAt int64           `json:"expires_at"`
}

func requestsJSON(list []auth.Request) []requestJSON {
	out := make([]requestJSON, 0, len(list))
	for _, q := range list {
		row := requestJSON{ID: q.ID, Name: q.Name, UserCode: q.UserCode, HostInfo: json.RawMessage("null"), CreatedAt: q.CreatedAt, ExpiresAt: q.ExpiresAt}
		if q.HostInfo != "" {
			row.HostInfo = json.RawMessage(q.HostInfo)
		}
		if net.ParseIP(q.Source) != nil {
			ip := q.Source
			row.SourceIP = &ip
		}
		if q.SourceNode != "" {
			node := strings.TrimSuffix(q.SourceNode, ".")
			row.NodeName = &node
		}
		out = append(out, row)
	}
	return out
}

func (s *Server) machineRequests(w http.ResponseWriter, r *http.Request, _ *call) {
	list, err := auth.PendingRequests(r.Context(), s.reader(), s.Clock.Now())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"requests": requestsJSON(list)})
}

func (s *Server) now(w http.ResponseWriter, r *http.Request, _ *call) {
	list, err := auth.PendingRequests(r.Context(), s.reader(), s.Clock.Now())
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"machine_requests": requestsJSON(list)})
}
