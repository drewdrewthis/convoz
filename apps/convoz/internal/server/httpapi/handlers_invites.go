package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Agent invites (owner ruling, 2026-10-18; design §3.4a). The owner and any approved agent make them; the owner revokes any, an agent
// its own. A request over the internet spends one (deviceCode, mintSession).

// inviteMarkJSON says who invited the agent behind a waiting request. The owner's card reads it: "invited by @x", or "invited by you".
type inviteMarkJSON struct {
	By      string `json:"by"`
	ByOwner bool   `json:"by_owner"`
	Note    string `json:"note"`
}

// inviteMarks reads who invited the agent behind each waiting request: logins by machine request id, session requests by
// identity request id. A request from the tailnet has no entry.
func (s *Server) inviteMarks(ctx context.Context, d pdb.DBTX, now time.Time) (logins, sessions map[int64]*inviteMarkJSON, err error) {
	byLogin, bySession, err := auth.InviteMarks(ctx, d, now)
	if err != nil || len(byLogin)+len(bySession) == 0 {
		return nil, nil, err
	}
	handles, err := identity.Handles(ctx, d)
	if err != nil {
		return nil, nil, err
	}
	owner, err := identity.Owner(ctx, d)
	if err != nil {
		return nil, nil, err
	}
	view := func(in map[int64]auth.InviteMark) map[int64]*inviteMarkJSON {
		out := make(map[int64]*inviteMarkJSON, len(in))
		for id, m := range in {
			out[id] = &inviteMarkJSON{By: handles[m.MakerID], ByOwner: m.MakerID == owner.ID, Note: m.Note}
		}
		return out
	}
	return view(byLogin), view(bySession), nil
}

// inviteView is an invite as the API shows it, without the token.
func inviteView(inv auth.Invite, handles map[int64]string, ownerID int64) wire.Invite {
	return wire.Invite{
		ID: inv.ID, Hint: inv.Hint, Maker: handles[inv.MakerID], MakerIsOwner: inv.MakerID == ownerID,
		ConversationID: inv.ConversationID, Note: inv.Note, CreatedAt: inv.CreatedAt, ExpiresAt: inv.ExpiresAt,
	}
}

// makeInvite makes an invite for the maker in by.Actor and answers the view that carries the token. server is the address the invited
// agent connects to. It runs its own write transaction; the admin socket uses it too.
func makeInvite(ctx context.Context, store *pdb.Store, clock platform.Clock, by auth.AuditEntry, in wire.CreateInviteRequest, server string) (wire.Invite, error) {
	var (
		inv   auth.Invite
		token string
	)
	err := store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		inv, token, err = auth.CreateInvite(ctx, tx.DBTX(), flowPorts, auth.NewInvite{By: by, ConversationID: in.ConversationID, Note: in.Note}, clock.Now())
		return err
	})
	if err != nil {
		return wire.Invite{}, err
	}
	return inviteWithToken(ctx, store.Reader.SQL(), inv, token, server)
}

// inviteWithToken is the view of a new invite: the token, once, and the command the invited agent runs.
func inviteWithToken(ctx context.Context, d pdb.DBTX, inv auth.Invite, token, server string) (wire.Invite, error) {
	handles, err := identity.Handles(ctx, d)
	if err != nil {
		return wire.Invite{}, err
	}
	owner, err := identity.Owner(ctx, d)
	if err != nil {
		return wire.Invite{}, err
	}
	out := inviteView(inv, handles, owner.ID)
	out.Token, out.Server, out.Login = token, server, "convoz login --server "+server+" --invite "+token
	return out, nil
}

// inviteRefused answers the refusals of the invite routes and reports whether err was one.
func inviteRefused(w http.ResponseWriter, err error) bool {
	var invalid *auth.FieldError
	switch {
	case errors.Is(err, auth.ErrInviteCap):
		writeErr(w, http.StatusTooManyRequests, wire.CodeInviteCap, "Too many invites are open. Revoke one, or wait for one to be used or to run out.")
	case errors.Is(err, auth.ErrNotInConversation):
		writeErr(w, http.StatusForbidden, wire.CodeNotInConversation, "You can invite only into a conversation you are in.")
	case errors.As(err, &invalid):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", invalid.Field, invalid.Message)
	default:
		return false
	}
	return true
}

// agentServer is the address an invited agent connects to: the agents-only address when the server has one, else the owner's.
func (s *Server) agentServer() string {
	if s.Cfg.AgentOrigin != "" {
		return s.Cfg.AgentOrigin
	}
	return s.Cfg.Origin
}

// callerAudit names who is calling for the audit line: the person's device, or the agent's session and machine (I-40).
func callerAudit(c *call) auth.AuditEntry {
	return auth.AuditEntry{Actor: c.p.Identity(), Device: c.p.DeviceID, Machine: c.p.LeaseMachine, Session: c.p.SessionID}
}

// createInvite is POST /api/invites: the owner's, or an approved agent's. The maker is the credential.
func (s *Server) createInvite(w http.ResponseWriter, r *http.Request, c *call) {
	var in wire.CreateInviteRequest
	if !decode(w, r, &in) {
		return
	}
	out, err := makeInvite(r.Context(), s.Store, s.Clock, callerAudit(c), in, s.agentServer())
	switch {
	case inviteRefused(w, err):
	case err != nil:
		s.internalError(w, r, err)
	default:
		writeJSON(w, http.StatusCreated, wire.InviteAnswer{Invite: out})
	}
}

// listInvites is GET /api/invites: every open invite for the owner, the caller's own for an agent.
func (s *Server) listInvites(w http.ResponseWriter, r *http.Request, c *call) {
	ctx, d := r.Context(), s.reader()
	maker := int64(0)
	if c.p.SessionID != 0 {
		maker = c.p.IdentityID
	}
	list, err := auth.OpenInvites(ctx, d, maker, s.Clock.Now())
	var handles map[int64]string
	if err == nil {
		handles, err = identity.Handles(ctx, d)
	}
	var owner identity.Human
	if err == nil {
		owner, err = identity.Owner(ctx, d)
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out := wire.InvitesResponse{Invites: make([]wire.Invite, 0, len(list))}
	for _, inv := range list {
		out.Invites = append(out.Invites, inviteView(inv, handles, owner.ID))
	}
	writeJSON(w, http.StatusOK, out)
}

// revokeInvite is DELETE /api/invites/:id. The owner revokes any open invite, an agent its own; another maker's is as unknown as a
// spent one.
func (s *Server) revokeInvite(w http.ResponseWriter, r *http.Request, c *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		return auth.RevokeInvite(ctx, tx.DBTX(), flowPorts, id, callerAudit(c), c.p.SessionID == 0, s.Clock.Now())
	})
	switch {
	case errors.Is(err, auth.ErrNoInvite):
		writeErr(w, http.StatusNotFound, "not_found", "No such open invite.")
	case err != nil:
		s.internalError(w, r, err)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

// expireInvites writes the expiry of the invites that ran out, with an audit line each. It writes only when one is due.
func (s *Server) expireInvites(ctx context.Context) error {
	due, err := auth.InvitesDue(ctx, s.reader(), s.Clock.Now())
	if err != nil || !due {
		return err
	}
	return s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		_, err := auth.ExpireInvites(ctx, tx.DBTX(), flowPorts, s.Clock.Now())
		return err
	})
}
