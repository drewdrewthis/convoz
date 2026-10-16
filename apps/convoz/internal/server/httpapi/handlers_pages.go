package httpapi

import (
	"net/http"
	"strconv"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/console"
)

// chatPage serves the conversation page; an id that is not a number, does not exist or is not the caller's gets the 404 page.
func (s *Server) chatPage(w http.ResponseWriter, r *http.Request, c *call) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err == nil && id > 0 {
		_, found, verr := s.visibleView(r.Context(), s.reader(), c.p, id)
		if verr != nil {
			s.internalError(w, r, verr)
			return
		}
		if found {
			chatServe(w, r)
			return
		}
	}
	notFoundServe(w, r)
}

var (
	chatServe     = console.Page("chat")
	notFoundServe = console.NotFound()
)
