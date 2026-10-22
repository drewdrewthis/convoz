package cli

func init() {
	Register(Command{Name: "stale", Summary: "Mark a conversation stale: it folds into Older until the next message.", Example: "convoz stale --as code-review 41 --reason \"Shipped; nothing left to do\"", Order: 63, Run: Stale,
		Usage: "convoz stale <conv> [--reason <text>]"})
}
