package cli

func init() {
	Register(Command{Name: "claim", Summary: "Claim the items waiting for you, without waiting.", Example: "convoz claim --as code-review", Order: 75, Run: Claim,
		Usage: "convoz claim [N] [--conv C] [--visibility D]"})
}
