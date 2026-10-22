package wire

// VoiceState is GET /api/voice: whether the web app shows Call, and when not, why.
type VoiceState struct {
	On  bool   `json:"on"`
	Why string `json:"why,omitempty"`
}

// VoiceTokenRequest is POST /api/voice/token: the conversation the call is in; without one (or with the scope "now") it is the
// triage call, the default.
type VoiceTokenRequest struct {
	ConversationID int64  `json:"conversation_id,omitempty"`
	Scope          string `json:"scope,omitempty"`
}

// VoiceToken is what the browser needs to open its one live session with Google: the one-use token (Google's name for it), the
// model, the socket address, when the token dies (epoch ms) and the live config the token locks, in the SDK's own shape.
type VoiceToken struct {
	Token     string         `json:"token"`
	Model     string         `json:"model"`
	WSURL     string         `json:"ws_url"`
	ExpiresAt int64          `json:"expires_at"`
	Config    map[string]any `json:"config"`
}
