package cli

func init() {
	Register(Command{Name: "admin", Summary: "Run an admin task on this server.", Example: "convoz admin bootstrap-link", Subs: []string{"bootstrap-link"}, Order: 10, Run: func(args []string, io IO) int { return Admin(args, io.Stdout, io.Stderr) },
		Usage: "convoz admin bootstrap-link [--admin-socket P]"})
}
