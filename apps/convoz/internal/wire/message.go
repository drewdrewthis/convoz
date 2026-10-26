package wire

// System is a system line as a reader gets it: the subtype and the people it names, looked up when the page is built so a
// rename shows at once (M-4). The server stores only ids.
type System struct {
	T        string  `json:"t"`
	Identity *Person `json:"identity,omitempty"`
	By       *Person `json:"by,omitempty"`
	Via      string  `json:"via,omitempty"`
	History  string  `json:"history,omitempty"`
	Streak   int     `json:"streak,omitempty"`
	Title    string  `json:"title,omitempty"` // conversation.renamed: the title the line quotes
	// From and To are the handles of a member.renamed line (I-51).
	From string `json:"from,omitempty"`
	To   string `json:"to,omitempty"`
	// Done, Now and Waiting are the plan items a plan.changed line quotes; Liveness is not_responding or logged_out (agent.unresponsive).
	Done     string `json:"done,omitempty"`
	Now      string `json:"now,omitempty"`
	Next     string `json:"next,omitempty"`
	Waiting  string `json:"waiting,omitempty"`
	Liveness string `json:"liveness,omitempty"`
	Host     string `json:"host,omitempty"` // page.shared: the host of the shared tab
}

// EditRequest is PATCH /api/messages/:id. Only the text changes; any other field is refused (I-8).
type EditRequest struct {
	ClientID string `json:"client_id"`
	Body     string `json:"body"`
	Format   string `json:"format,omitempty"`
}

// EditResponse is the answer to an edit: the message as it reads now.
type EditResponse struct {
	Message Message `json:"message"`
}

// PastEdit is one earlier text of a message.
type PastEdit struct {
	Body     string `json:"body"`
	Format   string `json:"format"`
	EditedAt int64  `json:"edited_at"`
	By       Person `json:"by"`
}

// HistoryResponse is GET /api/messages/:id/edits, oldest first.
type HistoryResponse struct {
	Edits []PastEdit `json:"edits"`
}
