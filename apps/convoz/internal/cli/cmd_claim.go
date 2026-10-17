package cli

func init() {
	Register(Command{Name: "claim", Order: 75, Run: Claim,
		Usage: "convoz claim [N] [--conv C] [--visibility D]"})
}
