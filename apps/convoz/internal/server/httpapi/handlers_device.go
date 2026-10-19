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
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/tailnet"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// hostInfoLimit caps each self-reported field so the stored JSON stays under the column's 200 characters.
const hostInfoLimit = 30

// clip keeps printable ASCII only (the owner reads this text and a machine controls it: no control, bidi or
// look-alike characters) and drops < > & " and \\, which JSON escapes to up to six characters each and would
// push the stored host info past the column's 200 characters. Then it cuts the rest to hostInfoLimit.
func clip(s string) string {
	out := make([]byte, 0, hostInfoLimit)
	for i := 0; i < len(s) && len(out) < hostInfoLimit; i++ {
		if c := s[i]; c >= 0x20 && c <= 0x7e && !strings.ContainsRune(`<>&"\\`, rune(c)) {
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
	if !s.Cfg.TailscaleOn || agentClient(ctx) != "" || net.ParseIP(source) == nil { // an internet address is no node of ours
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
	var intro *auth.IdentityPackage
	if in.Identity != nil {
		avatar, ok := cleanAvatar(w, in.Identity.AvatarSVG)
		if !ok {
			return
		}
		intro = &auth.IdentityPackage{Handle: in.Identity.Handle, DisplayName: in.Identity.DisplayName, Description: in.Identity.Description, AvatarSVG: avatar, ConversationID: in.Identity.ConversationID}
	}
	info, _ := json.Marshal(wire.HostInfo{Hostname: clip(in.HostInfo.Hostname), OS: clip(in.HostInfo.OS), Arch: clip(in.HostInfo.Arch), CLIVersion: clip(in.HostInfo.CLIVersion)})
	source := s.source(r)
	node := s.nodeName(r.Context(), source)
	via := agentClient(r.Context()) != ""
	if via {
		source = viaInternet + source
	}
	req := auth.DeviceRequest{Name: in.Name, HostInfo: string(info), Source: source, SourceNode: node, Interval: s.interval()}
	var out auth.DeviceCode
	// Over the internet a request is made only for a usable invite, which it spends. On the tailnet an invite is not needed, but one that
	// is sent is one-use as well (owner ruling, ask 52): it is spent here the same way, and a used one makes no request.
	useInvite := via || in.Invite != ""
	spent := !useInvite
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		now := s.Clock.Now()
		var inv auth.Invite
		if useInvite {
			if inv, spent, err = auth.TakeInvite(ctx, tx.DBTX(), flowPorts, in.Invite, now); err != nil || !spent {
				return err // no invite: nothing is made, and the answer below looks like an accepted request
			}
			// The global limit counts the starts that carry an invite only: a flood without one makes no card, so it must not use up the hour.
			if via && !s.agentStartAll.Allow("all", now) {
				return errAgentStartsFull
			}
			if intro != nil {
				intro.ConversationID = inv.ConversationID // the invited agent never picks another conversation
			}
		}
		// The identity is checked before the request is made: a refused handle makes no request, and a request reserves nothing.
		if intro != nil {
			if via {
				*intro, err = checkIntroBlind(ctx, tx.DBTX(), *intro)
			} else {
				*intro, err = auth.CheckIdentityPackage(ctx, tx.DBTX(), flowPorts, *intro)
			}
			if err != nil {
				return err
			}
		}
		if via {
			handle := ""
			if intro != nil {
				handle = intro.Handle
			}
			if err = auth.CheckNoPendingDuplicate(ctx, tx.DBTX(), in.Name, handle, now); err != nil {
				return err
			}
		}
		if out, err = auth.RequestDeviceCode(ctx, tx.DBTX(), req, s.userCodes, now); err != nil {
			return err
		}
		if intro != nil {
			if err = auth.AttachLoginIdentity(ctx, tx.DBTX(), out.RequestID, *intro, now); err != nil {
				return err
			}
		}
		if useInvite {
			if err = auth.SpendInvite(ctx, tx.DBTX(), flowPorts, inv, auth.InviteLogin, out.RequestID, now); err != nil {
				return err
			}
		}
		// The owner is told (a card in Now, a push): the event names the request, the push reads its name and code when it is sent.
		_, err = event.Append(ctx, tx.DBTX(), now, eventMachineRequested, map[string]any{"request_id": out.RequestID, "via_internet": via})
		return err
	})
	if err == nil && spent {
		s.Bus.Notify()
	}
	var limited *auth.RateLimitedError
	switch {
	case errors.Is(err, errAgentStartsFull):
		w.Header().Set("Retry-After", "3600")
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "Too many login requests. Try again later.")
	case identityRefused(w, err, "handle"):
	case errors.Is(err, auth.ErrDuplicatePending):
		writeErr(w, http.StatusConflict, "duplicate_pending", "A request with that name or handle is already waiting for the owner.")
	case errors.Is(err, auth.ErrTooManyPending):
		writeErr(w, http.StatusTooManyRequests, wire.CodeTooManyPending, "Three machines are already waiting. Deny the waiting requests in Convoz, then run convoz login again.")
	case errors.Is(err, auth.ErrPendingFull):
		writeErr(w, http.StatusTooManyRequests, wire.CodeTooManyPending, "Too many machines are waiting. Deny the waiting requests in Convoz, then run convoz login again.")
	case errors.As(err, &limited):
		retryAfter(w, limited.RetryAfter)
		writeErr(w, http.StatusTooManyRequests, "rate_limited", "This machine asked too often. Try again later.")
	case err != nil:
		s.internalError(w, r, err)
	case !spent && !via:
		writeErr(w, http.StatusBadRequest, wire.CodeInviteSpent, inviteSpentMessage)
	case !spent:
		// The stranger's answer: the same as an accepted request. The code belongs to nothing and polls like an expired one.
		writeJSON(w, http.StatusOK, wire.DeviceCodeResponse{
			DeviceCode: auth.FakeDeviceCode(), UserCode: auth.NewUserCode(),
			Interval: max(1, int(s.interval()/time.Second)), IntervalMs: s.interval().Milliseconds(), ExpiresIn: int(auth.RequestTTL / time.Second),
		})
	default:
		writeJSON(w, http.StatusOK, wire.DeviceCodeResponse{
			DeviceCode: out.DeviceCode, UserCode: out.UserCode,
			Interval: max(1, int(out.Interval/time.Second)), IntervalMs: out.Interval.Milliseconds(), ExpiresIn: int(out.ExpiresIn / time.Second),
		})
	}
}

// inviteSpentMessage is what the tailnet is told about a bad invite; the internet is not told which invites are valid.
const inviteSpentMessage = "This invite was used or has expired. Ask the owner for a new one."

// errAgentStartsFull rolls a start back when the hour's global budget for starts with an invite is used up.
var errAgentStartsFull = errors.New("too many login starts with an invite this hour")

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
	ID       int64           `json:"id"`
	Name     string          `json:"name"`
	UserCode string          `json:"user_code"`
	HostInfo json.RawMessage `json:"host_info"`
	SourceIP *string         `json:"source_ip"`
	// ViaInternet is true when the request came in on the agent listener; the card then says "via internet".
	ViaInternet bool    `json:"via_internet"`
	NodeName    *string `json:"node_name"`
	CreatedAt   int64   `json:"created_at"`
	ExpiresAt   int64   `json:"expires_at"`
	// Invite says who invited the agent behind the request; null for a request from the tailnet.
	Invite *inviteMarkJSON `json:"invite"`
	// Identity is what the agent that ran convoz login --as said about itself; null for a plain login.
	Identity *introJSON `json:"identity"`
}

func (s *Server) requestsJSON(list []auth.Request, intros map[int64]introJSON, invites map[int64]*inviteMarkJSON) []requestJSON {
	out := make([]requestJSON, 0, len(list))
	for _, q := range list {
		row := requestJSON{ID: q.ID, Name: q.Name, UserCode: q.UserCode, HostInfo: json.RawMessage("null"), CreatedAt: q.CreatedAt, ExpiresAt: q.ExpiresAt, Invite: invites[q.ID]}
		if in, ok := intros[q.ID]; ok {
			row.Identity = &in
		}
		if q.HostInfo != "" {
			row.HostInfo = json.RawMessage(q.HostInfo)
		}
		src, via := strings.CutPrefix(q.Source, viaInternet)
		row.ViaInternet = via
		if net.ParseIP(src) != nil {
			row.SourceIP = &src
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
	now := s.Clock.Now()
	list, err := auth.PendingRequests(r.Context(), s.reader(), now)
	var intros map[int64]introJSON
	if err == nil {
		intros, err = s.loginIntros(r.Context(), s.reader(), now)
	}
	var logins map[int64]*inviteMarkJSON
	if err == nil {
		logins, _, err = s.inviteMarks(r.Context(), s.reader(), now)
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"requests": s.requestsJSON(list, intros, logins)})
}

// checkIntroBlind is CheckIdentityPackage for a caller nobody has vouched for. A taken or retired handle, a look-alike display name and
// a conversation that is not available all give the same accepted answer as a clean package, so the open door cannot be used to probe the
// owner's people and chats; the approval runs the full rules again and refuses with its reason. A conversation that is not available is dropped.
func checkIntroBlind(ctx context.Context, d pdb.DBTX, in auth.IdentityPackage) (auth.IdentityPackage, error) {
	conv := in.ConversationID
	in.ConversationID = 0
	in.MayReturn = true // only a spent invite gets here
	out, err := auth.CheckIdentityPackage(ctx, d, flowPorts, in)
	var field *auth.FieldError
	if err != nil && !errors.Is(err, auth.ErrHandleTaken) && !(errors.As(err, &field) && field.Field == "display_name") {
		return out, err
	}
	if conv != 0 {
		if _, ok, cerr := flowPorts.Conversations.OwnerConversation(ctx, d, conv); cerr != nil {
			return out, cerr
		} else if ok {
			out.ConversationID = conv
		}
	}
	return out, nil
}
