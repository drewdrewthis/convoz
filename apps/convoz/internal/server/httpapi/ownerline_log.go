package httpapi

import (
	"net/http"
	"strconv"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
)

// logOwnerLine writes one line for a text that ownerline refused, so ops can count refusals by agent and field. The text is never
// logged: it may be private.
func (s *Server) logOwnerLine(r *http.Request, c *call, conv int64, field, why string) {
	agent := strconv.FormatInt(c.p.Identity(), 10)
	if p, found, err := identity.ByID(r.Context(), s.reader(), c.p.Identity()); err == nil && found {
		agent = p.Handle
	}
	s.Log.Printf("msg=%q agent=%s field=%s conv=%d why=%q", "owner line rejected", agent, field, conv, why)
}
