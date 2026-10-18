package wire

import "encoding/json"

// Routes of the agent surface: the brief, the handoff notes, the agent's own profile, and the asks and status routes the
// ask and status work packages serve.
const (
	RouteBrief    = "/api/brief"
	RouteHandoffs = "/api/handoffs"
	RouteProfile  = "/api/me/profile"
	RouteHandle   = "/api/me/handle"
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
	// AvatarSVG is the SVG text of the caller's avatar, or null to go back to the letter on a tint (any caller, I-32).
	AvatarSVG json.RawMessage `json:"avatar_svg,omitempty"`
}

// ProfileResponse is the profile after the change.
type ProfileResponse struct {
	Handle       string   `json:"handle"`
	DisplayName  string   `json:"display_name"`
	Description  string   `json:"description"`
	Capabilities []string `json:"capabilities"`
	AvatarURL    string   `json:"avatar_url,omitempty"`
}

// StatusRequest is PUT /api/status.
type StatusRequest struct {
	State string `json:"state"`
	Doing string `json:"doing,omitempty"`
	Next  string `json:"next,omitempty"`
}

// AgentStatus is what PUT /api/status stores and answers.
type AgentStatus struct {
	State     string `json:"state"`
	Doing     string `json:"doing"`
	Next      string `json:"next"`
	Since     int64  `json:"since"`
	UpdatedAt int64  `json:"updated_at"`
}

// OpenAsk is an ask of an agent that waits for the owner.
type OpenAsk struct {
	ID             int64  `json:"id"`
	ConversationID int64  `json:"conversation_id"`
	Question       string `json:"question"`
	Urgent         bool   `json:"urgent"`
}

// CrewStatus is one agent's row of GET /api/status.
type CrewStatus struct {
	AgentStatus
	IdentityID int64     `json:"identity_id"`
	Handle     string    `json:"handle"`
	Online     bool      `json:"online"`
	OpenAsks   []OpenAsk `json:"open_asks"`
}

// StatusList is the body of GET /api/status.
type StatusList struct {
	Statuses []CrewStatus `json:"statuses"`
}

// Rail is one conversation's rank in the owner's rail, as PATCH prefs and the prefs.changed frame carry it.
type Rail struct {
	ID   int64   `json:"id"`
	Rank float64 `json:"rank"`
}

// PrefsRequest is PATCH /api/conversations/:id/prefs. MutedUntil stays raw so an absent field (leave it) and null (unmute) differ.
type PrefsRequest struct {
	Starred    *bool           `json:"starred"`
	MutedUntil json.RawMessage `json:"muted_until"`
	Place      *struct {
		After *int64 `json:"after"`
	} `json:"place"`
}

// PrefsResult is the answer of PATCH prefs and the data of the prefs.changed frame.
type PrefsResult struct {
	ConversationID int64  `json:"conversation_id"`
	Starred        bool   `json:"starred"`
	MutedUntil     *int64 `json:"muted_until"`
	Ranks          []Rail `json:"ranks"`
}

// HandleRequest is POST /api/me/handle: the agent asks the owner for a new handle. With Request it asks what became of that request.
type HandleRequest struct {
	Handle  string `json:"handle"`
	Request string `json:"request,omitempty"`
}

// HandleRequestState is a waiting handle request (202).
type HandleRequestState struct {
	Ref        string `json:"ref"`
	State      string `json:"state"`
	From       string `json:"from"`
	To         string `json:"to"`
	ExpiresAt  int64  `json:"expires_at"`
	IntervalMs int64  `json:"interval_ms"`
}

// HandlePending is the 202 answer of POST /api/me/handle.
type HandlePending struct {
	Request HandleRequestState `json:"request"`
}

// HandleChanged is the answer once a handle changed.
type HandleChanged struct {
	Identity struct {
		ID             int64  `json:"id"`
		Handle         string `json:"handle"`
		PreviousHandle string `json:"previous_handle"`
	} `json:"identity"`
}

// CreateInviteRequest is POST /api/invites and the admin-socket AdminInvites. The maker comes from the credential, never from the body.
type CreateInviteRequest struct {
	// ConversationID is the conversation the invited agent asks to join. The maker must be in it; 0 means none.
	ConversationID int64 `json:"conversation_id,omitempty"`
	// Note is one line the owner reads on the card, up to 80 characters.
	Note string `json:"note,omitempty"`
}

// Invite is an agent invite (one use, 24 hours). Token, Server and Login are set only in the answer that makes it: the token is not kept.
type Invite struct {
	ID int64 `json:"id"`
	// Hint is the last 4 characters of the token; it tells invites apart in a list and cannot be used.
	Hint string `json:"hint"`
	// Maker is the handle of the owner or agent that made it; MakerIsOwner says which.
	Maker          string `json:"maker"`
	MakerIsOwner   bool   `json:"maker_is_owner"`
	ConversationID int64  `json:"conversation_id,omitempty"`
	Note           string `json:"note"`
	CreatedAt      int64  `json:"created_at"`
	ExpiresAt      int64  `json:"expires_at"`
	Token          string `json:"token,omitempty"`
	// Server is the address an invited agent connects to: the agents-only address when the server has one.
	Server string `json:"server,omitempty"`
	// Login is the command the invited agent runs.
	Login string `json:"login,omitempty"`
}

// InviteAnswer is the answer to a new invite.
type InviteAnswer struct {
	Invite Invite `json:"invite"`
}

// InvitesResponse is GET /api/invites: the invites that can still be used, newest first.
type InvitesResponse struct {
	Invites []Invite `json:"invites"`
}
