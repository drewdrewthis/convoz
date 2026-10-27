package wire

// RouteDeliveries is the owner's Deliveries page: every deliverable of every plan, in one read (delivery.feature).
const RouteDeliveries = "/api/deliveries"

// Delivery is one deliverable of one agent's plan in one conversation, with what the owner needs to judge it.
type Delivery struct {
	ConversationID int64  `json:"conversation_id"`
	Title          string `json:"title"`
	IdentityID     int64  `json:"identity_id"`
	Handle         string `json:"handle"`
	Text           string `json:"text"`
	Due            int64  `json:"due"`
	Since          int64  `json:"since"`
	// State is late, waiting (on the owner), at_risk (blocked, or no plan update for a day) or on_track.
	State string `json:"state"`
	// Stale says the plan has had no update for a day.
	Stale bool `json:"stale"`
	// Doing are the plan's Now items, each with its step and estimate.
	Doing   []PlanNow `json:"doing"`
	Waiting int       `json:"waiting"`
	Blocked string    `json:"blocked,omitempty"`
	// PlanUpdatedAt is when the agent last replaced the plan.
	PlanUpdatedAt int64 `json:"plan_updated_at"`
}

// ShippedDelivery is a deliverable an agent reported done in the last two days.
type ShippedDelivery struct {
	ConversationID int64  `json:"conversation_id"`
	Title          string `json:"title"`
	Handle         string `json:"handle"`
	Text           string `json:"text"`
	At             int64  `json:"at"`
}

// Deliveries is GET /api/deliveries: the late ones first, then by due date.
type Deliveries struct {
	Now        int64             `json:"now"`
	Deliveries []Delivery        `json:"deliveries"`
	Shipped    []ShippedDelivery `json:"shipped"`
	// NextChangeAt is when time alone changes a state next (a due date passes, a plan turns a day old); read again then.
	NextChangeAt int64 `json:"next_change_at,omitempty"`
}
