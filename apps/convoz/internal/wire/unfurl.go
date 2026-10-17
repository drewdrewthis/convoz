package wire

// UnfurlCard is GET /api/messages/:id/unfurl: the preview of the first link of a message. While Status is pending the rest is absent.
type UnfurlCard struct {
	Status      string         `json:"status"`
	URL         string         `json:"url"`
	Kind        string         `json:"kind,omitempty"`
	Site        string         `json:"site,omitempty"`
	Title       string         `json:"title,omitempty"`
	Description string         `json:"description,omitempty"`
	Meta        map[string]any `json:"meta,omitempty"`
}
