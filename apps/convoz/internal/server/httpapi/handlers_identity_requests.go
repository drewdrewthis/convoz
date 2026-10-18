package httpapi

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/upload"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// convRefJSON names the conversation a request wants to join, by the title the owner already knows.
type convRefJSON struct {
	ID    int64  `json:"id"`
	Title string `json:"title"`
}

// introJSON is what an agent said about itself in a request. Every text in it is the agent's own and the card shows it as data:
// plain text, never markup. The avatar is only ever an <img> of the cleaned SVG this URL serves (I-32).
type introJSON struct {
	Ref          string       `json:"ref"`
	Handle       string       `json:"handle"`
	DisplayName  string       `json:"display_name"`
	Description  string       `json:"description"`
	AvatarURL    *string      `json:"avatar_url"`
	Conversation *convRefJSON `json:"conversation"`
}

// identityRequestJSON is a waiting request of a logged-in machine, as Now shows it. The machine name is the server's own.
type identityRequestJSON struct {
	introJSON
	Machine   string `json:"machine"`
	MachineID int64  `json:"machine_id"`
	// ViaInternet is true when the request came in on the agents-only listener; the card says "via internet".
	ViaInternet bool  `json:"via_internet"`
	CreatedAt   int64 `json:"created_at"`
	ExpiresAt   int64 `json:"expires_at"`
}

func (s *Server) introOf(ctx context.Context, d pdb.DBTX, r auth.IdentityRequest) (introJSON, error) {
	out := introJSON{Ref: r.Ref, Handle: r.Handle, DisplayName: r.DisplayName, Description: r.Description}
	if out.DisplayName == "" {
		out.DisplayName = r.Handle
	}
	if r.HasAvatar {
		url := "/api/identity-requests/" + r.Ref + "/avatar.svg"
		out.AvatarURL = &url
	}
	if r.ConversationID != 0 {
		title, ok, err := flowPorts.Conversations.OwnerConversation(ctx, d, r.ConversationID)
		if err != nil {
			return out, err
		}
		if ok {
			out.Conversation = &convRefJSON{ID: r.ConversationID, Title: title}
		}
	}
	return out, nil
}

// loginIntros maps each waiting device-flow request to the identity it carries.
func (s *Server) loginIntros(ctx context.Context, d pdb.DBTX, now time.Time) (map[int64]introJSON, error) {
	list, err := auth.LoginIdentityRequests(ctx, d, now)
	if err != nil {
		return nil, err
	}
	out := make(map[int64]introJSON, len(list))
	for id, r := range list {
		if out[id], err = s.introOf(ctx, d, r); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (s *Server) identityRequestViews(ctx context.Context, d pdb.DBTX, now time.Time) ([]identityRequestJSON, error) {
	list, err := auth.PendingIdentityRequests(ctx, d, now)
	if err != nil {
		return nil, err
	}
	via, err := auth.ViaInternetRefs(ctx, d)
	if err != nil {
		return nil, err
	}
	out := make([]identityRequestJSON, 0, len(list))
	for _, r := range list {
		intro, err := s.introOf(ctx, d, r)
		if err != nil {
			return nil, err
		}
		out = append(out, identityRequestJSON{introJSON: intro, Machine: r.MachineName, MachineID: r.MachineID, ViaInternet: via[r.Ref], CreatedAt: r.CreatedAt, ExpiresAt: r.ExpiresAt})
	}
	return out, nil
}

// cleanAvatar rebuilds the SVG an agent sent from an allow-list (I-32). An empty one passes. It writes the 400 itself.
func cleanAvatar(w http.ResponseWriter, raw string) (string, bool) {
	if raw == "" {
		return "", true
	}
	clean, err := upload.SanitizeAvatar(raw)
	if err != nil {
		writeFieldErr(w, http.StatusBadRequest, "invalid_avatar", "avatar_svg", "The avatar must be a plain SVG: no DOCTYPE, no ENTITY, at most 4096 characters once cleaned.")
		return "", false
	}
	return clean, true
}

// identityRefused answers the refusals of an identity package and reports whether err was one. handleField names the request field
// the handle came in as.
func identityRefused(w http.ResponseWriter, err error, handleField string) bool {
	var invalid *auth.FieldError
	switch {
	case errors.Is(err, auth.ErrHandleTaken):
		writeFieldErr(w, http.StatusConflict, wire.CodeHandleTaken, handleField, "That handle is taken or was used before.")
	case errors.As(err, &invalid):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", invalid.Field, invalid.Message)
	default:
		return false
	}
	return true
}

// approveIdentity is POST /api/identity-requests/:ref/approve: the owner's one tap for an agent on a logged-in machine.
func (s *Server) approveIdentity(w http.ResponseWriter, r *http.Request, c *call) {
	var in struct{}
	if !decode(w, r, &in) {
		return
	}
	var made auth.ApprovedIdentity
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		made, err = auth.ApproveIdentity(ctx, tx.DBTX(), flowPorts, auth.IdentityApproval{Ref: r.PathValue("ref"), Human: c.human, DeviceID: c.dev.ID}, s.Clock.Now())
		return err
	})
	switch {
	case errors.Is(err, auth.ErrIdentityGone):
		writeErr(w, http.StatusNotFound, "not_found", "That request is gone. It was decided or it expired.")
	case identityRefused(w, err, "handle"):
	case err != nil:
		s.internalError(w, r, err)
	default:
		s.Bus.Notify(made.Agent.ID)
		writeJSON(w, http.StatusCreated, map[string]any{"identity": map[string]any{"id": made.Agent.ID, "handle": made.Agent.Handle, "display_name": made.Agent.DisplayName, "kind": "agent"}, "machine": map[string]any{"id": made.MachineID, "name": made.MachineName}})
	}
}

// denyIdentity is POST /api/identity-requests/:ref/deny.
func (s *Server) denyIdentity(w http.ResponseWriter, r *http.Request, c *call) {
	var in struct{}
	if !decode(w, r, &in) {
		return
	}
	var denied bool
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		var err error
		denied, err = auth.DenyIdentity(ctx, tx.DBTX(), journalPort{}, c.human, c.dev.ID, r.PathValue("ref"), s.Clock.Now())
		return err
	})
	switch {
	case err != nil:
		s.internalError(w, r, err)
	case !denied:
		writeErr(w, http.StatusNotFound, "not_found", "That request is gone. It was decided or it expired.")
	default:
		s.Bus.Notify()
		writeJSON(w, http.StatusOK, map[string]any{})
	}
}

// identityRequestAvatar is GET /api/identity-requests/:ref/avatar.svg: the cleaned SVG a waiting request carries, served so it can only
// draw (I-32). Only the owner can read it, and only by the ref.
func (s *Server) identityRequestAvatar(w http.ResponseWriter, r *http.Request, _ *call) {
	svg, found, err := auth.IdentityAvatar(r.Context(), s.reader(), r.PathValue("ref"))
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !found {
		writeErr(w, http.StatusNotFound, "not_found", "No avatar.")
		return
	}
	h := w.Header()
	h.Set("Content-Type", "image/svg+xml")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Cache-Control", "private, no-cache")
	_, _ = w.Write([]byte(svg))
}
