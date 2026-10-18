package cli

func init() {
	Register(Command{Name: "invite", Summary: "Make a one-use invite for an agent outside the tailnet.", Example: "convoz invite --as code-review --conv 41 --note \"for the docs bot\"", Order: 58, Run: Invite,
		Usage: "convoz invite [--conv ID] [--note TEXT] [--admin-socket P]"})
}
