package wire

// RouteWaiting is GET /api/waiting: what waits on the owner, for an agent the owner let read every conversation.
const RouteWaiting = "/api/waiting"

// WaitingResponse is GET /api/waiting: what waits on the owner across every conversation a triage agent can read, for triage.
type WaitingResponse struct {
	Now        int64               `json:"now"`
	Asks       []WaitingAsk        `json:"asks"`
	Unanswered []WaitingUnanswered `json:"unanswered"`
	Plans      []NowWaiting        `json:"plans"`
	Unread     []WaitingUnread     `json:"unread"`
}

// WaitingAsk is an open ask that waits for the owner's answer.
type WaitingAsk struct {
	ID           int64           `json:"id"`
	Conversation AskConversation `json:"conversation"`
	Asker        Person          `json:"asker"`
	Question     string          `json:"question"`
	Urgent       bool            `json:"urgent"`
	Snoozed      bool            `json:"snoozed"`
	CreatedAt    int64           `json:"created_at"`
	AgeMS        int64           `json:"age_ms"`
}

// WaitingUnanswered is the owner's newest main-chat message that nobody answered for more than the reminder wait (10 minutes).
type WaitingUnanswered struct {
	Conversation AskConversation `json:"conversation"`
	MessageID    int64           `json:"message_id"`
	Excerpt      string          `json:"excerpt"`
	CreatedAt    int64           `json:"created_at"`
	AgeMS        int64           `json:"age_ms"`
}

// WaitingUnread is how many messages the owner has not read in one conversation.
type WaitingUnread struct {
	Conversation AskConversation `json:"conversation"`
	Unread       int64           `json:"unread"`
}
