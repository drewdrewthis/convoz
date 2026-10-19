package cli

func init() {
	Register(Command{Name: "plan", Summary: "Say what you do now, next, and what waits on the owner, in one conversation.",
		Example: "convoz plan --as code-review 41 --doing \"Building invites\" --eta 30m --next \"Reply chip\" --waiting \"Approve the card\"", Order: 54, Run: Plan,
		Usage: "convoz plan <conv> [--doing D] [--step N/M] [--eta 30m|HH:MM] [--blocked B] [--next N]... [--waiting W]... [--done D]... [--client-id C]"})
}
