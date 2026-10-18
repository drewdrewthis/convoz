package wire

// RepliesResponse is GET /api/messages/:id/replies: the thread root and its replies, oldest first. Root is a stub (an empty body
// from nobody) when the reader joined after it (I-7).
type RepliesResponse struct {
	ConversationID int64     `json:"conversation_id"`
	Root           Message   `json:"root"`
	Messages       []Message `json:"messages"`
	AsOfSeq        int64     `json:"as_of_seq"`
	Seen           []Seen    `json:"seen,omitempty"` // agents that saw the newest message a person wrote in this thread
}
