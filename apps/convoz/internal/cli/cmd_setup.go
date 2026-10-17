package cli

func init() {
	Register(Command{Name: "setup", Order: 90, Run: Setup,
		Usage: "convoz setup --as HANDLE [--scope project|user]"})
}
