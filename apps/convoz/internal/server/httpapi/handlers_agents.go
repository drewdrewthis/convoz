package httpapi

import (
	"net/http"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// listAgents is GET /api/agents: the agents an agent may bring into a conversation, so it can find a handle. It is the crew list
// without anything private: no ids, keys, machines, or who made the agent. Disabled agents and the caller are left out.
func (s *Server) listAgents(w http.ResponseWriter, r *http.Request, c *call) {
	ctx, d := r.Context(), s.reader()
	list, err := identity.List(ctx, d)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	states, err := identity.Statuses(ctx, d)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	out := make([]wire.AgentRow, 0, len(list))
	for _, e := range list {
		if e.Kind != "agent" || e.Disabled || e.ID == c.p.Identity() {
			continue
		}
		state := identity.Idle().State
		if st, ok := states[e.ID]; ok {
			state = st.State
		}
		out = append(out, wire.AgentRow{Handle: e.Handle, DisplayName: e.DisplayName, Description: e.Description, State: state})
	}
	writeJSON(w, http.StatusOK, wire.AgentsResponse{Agents: out})
}
