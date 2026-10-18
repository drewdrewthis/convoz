package cli

func init() {
	Register(Command{Name: "login", Summary: "Connect this machine, and optionally an agent, to a server.", Example: "convoz login --server https://convoz.example --as code-review", Order: 20, Run: Login,
		Usage: "convoz login --server URL [--name N] [--as HANDLE [--description TEXT] [--avatar FILE.svg] [--conversation ID]] [--store file|keychain|auto] [--stdin]"})
}
