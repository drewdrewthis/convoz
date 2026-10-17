package cli

func init() {
	Register(Command{Name: "admin", Order: 10, Run: func(args []string, io IO) int { return Admin(args, io.Stdout, io.Stderr) },
		Usage: "convoz admin bootstrap-link [--admin-socket P]"})
}
