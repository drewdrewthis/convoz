package wire

import "encoding/json"

// Routes of the agent surface: the brief, the handoff notes, the agent's own profile, and the asks and status routes the
// ask and status work packages serve.
const (
	RouteBrief    = "/api/brief"
	RouteHandoffs = "/api/handoffs"
	RouteProfile  = "/api/me/profile"
	RouteAsks     = "/api/asks"
	RouteStatus   = "/api/status"
)

// Sizes the CLI and the server check the same way (design §3.8, §13).
const (
	MaxHandoffBytes = 4096
	MaxBriefBytes   = 65536
)

// BriefSection is one titled part of the brief. Text includes the title line.
type BriefSection struct {
	Key   string `json:"key"`
	Title string `json:"title"`
	Text  string `json:"text"`
}

// BriefResponse is GET /api/brief. Text is the whole brief (the sections joined); Bytes is its length.
type BriefResponse struct {
	Text     string         `json:"text"`
	Sections []BriefSection `json:"sections"`
	Bytes    int            `json:"bytes"`
	Page     int            `json:"page"`
}

// HandoffRequest is POST /api/handoffs. The identity and the session come from the lease, never from the body.
type HandoffRequest struct {
	ClientID string `json:"client_id"`
	Body     string `json:"body"`
}

// Handoff is a stored note with the session and machine that wrote it.
type Handoff struct {
	ID        int64  `json:"id"`
	Body      string `json:"body"`
	CreatedAt int64  `json:"created_at"`
	Session   string `json:"session"`
	Machine   string `json:"machine"`
}

// HandoffsResponse is GET /api/handoffs, newest first.
type HandoffsResponse struct {
	Handoffs []Handoff `json:"handoffs"`
}

// ProfileRequest is PATCH /api/me/profile; a field left out stays as it is. The handle is not in it.
type ProfileRequest struct {
	DisplayName  *string   `json:"display_name,omitempty"`
	Description  *string   `json:"description,omitempty"`
	Capabilities *[]string `json:"capabilities,omitempty"`
}

// ProfileResponse is the profile after the change.
type ProfileResponse struct {
	Handle       string   `json:"handle"`
	DisplayName  string   `json:"display_name"`
	Description  string   `json:"description"`
	Capabilities []string `json:"capabilities"`
}

// AskOption is one choice of an ask with the reason for it.
type AskOption struct {
	Label string `json:"label"`
	Why   string `json:"why"`
}

// AskRequest is POST /api/asks: a question, the recommended answer with its reason, and at least one alternative.
type AskRequest struct {
	ClientID       string          `json:"client_id"`
	ConversationID int64           `json:"conversation_id"`
	Question       string          `json:"question"`
	Recommended    AskOption       `json:"recommended"`
	Alternatives   []AskOption     `json:"alternatives"`
	Urgent         bool            `json:"urgent,omitempty"`
	ThreadRootID   int64           `json:"thread_root_id,omitempty"`
	App            json.RawMessage `json:"app,omitempty"`
}

// StatusRequest is PUT /api/status.
type StatusRequest struct {
	State string `json:"state"`
	Doing string `json:"doing,omitempty"`
	Next  string `json:"next,omitempty"`
}
