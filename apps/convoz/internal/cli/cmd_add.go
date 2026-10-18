package cli

func init() {
	Register(Command{Name: "add", Summary: "Ask for an agent to join a conversation.", Example: "convoz add --as code-review 41 @docs", Order: 61, Run: Add,
		Usage: "convoz add <conv> @agent"})
}
