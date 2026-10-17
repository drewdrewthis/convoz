package testroutes

// The test routes of the message module (testhooks build only; scripts/release_guard.py checks a release binary has none).
const (
	// SystemLine writes one system line, for a scenario whose action (adding a participant, a rename) is another module's.
	SystemLine = "/__test/system-line"
	// MessageBudget spends an agent's daily message budget, for a scenario that starts at "posted 20000 messages today".
	MessageBudget = "/__test/message-budget"
	// Project runs the Go plain-text projection over one fixture message, for the Go and web twins to be compared.
	Project = "/__test/project"
)

func init() { All = append(All, SystemLine, MessageBudget, Project) }
