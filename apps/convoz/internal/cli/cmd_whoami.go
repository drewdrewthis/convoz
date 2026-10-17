package cli

func init() {
	Register(Command{Name: "whoami", Order: 30, Run: Whoami,
		Usage: "convoz whoami [--sid SID | --as HANDLE] [--json]"})
}
