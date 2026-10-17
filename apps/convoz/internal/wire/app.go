package wire

import "encoding/json"

// AppInlineBytes is how large an app may be to ride inside a page of messages; a larger one is a stub (E-22).
const AppInlineBytes = 4096

// AppStub stands in for an app over AppInlineBytes in a page of messages.
type AppStub struct {
	Stub     bool   `json:"stub"`
	V        int    `json:"v"`
	Type     string `json:"type"`
	Title    string `json:"title,omitempty"`
	Fallback string `json:"fallback"`
	Bytes    int    `json:"bytes"`
}

// ViaApp is the mark of a message sent through an app: the app message, the agent that wrote it and the result.
type ViaApp struct {
	MessageID int64           `json:"message_id"`
	Agent     Person          `json:"agent"`
	Result    json.RawMessage `json:"result"`
}

// ViaAppRequest is the via_app field of a post: the app message the result comes from and the result (app-result.v1).
type ViaAppRequest struct {
	MessageID int64           `json:"message_id"`
	Result    json.RawMessage `json:"result"`
}

// OneApp is the answer of GET /api/messages/:id/app.
type OneApp struct {
	App json.RawMessage `json:"app"`
}

// AppChecked is the answer of POST /api/apps/validate.
type AppChecked struct {
	OK    bool   `json:"ok"`
	Type  string `json:"type"`
	Bytes int    `json:"bytes"`
}

// AppBundle is the wire form of a stored Tier-2 bundle (props.bundle): its upload is a kind `app` upload (POST /api/uploads).
type AppBundle struct {
	Upload string `json:"upload"`
	SHA256 string `json:"sha256"`
	Size   int    `json:"size"`
}

// Codes of an app that is refused.
const (
	CodeAppInvalid      = "app_invalid"
	CodeAppTooLarge     = "app_too_large"
	CodeAppNotOnAsk     = "app_type_not_allowed_on_ask"
	CodeAppResultBad    = "app_result_invalid"
	CodeAppResultDenied = "app_result_not_allowed"
)
