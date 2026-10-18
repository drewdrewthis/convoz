package cli

func init() {
	Register(Command{Name: "login", Order: 20, Run: Login,
		Usage: "convoz login --server URL [--name N] [--as HANDLE [--description TEXT] [--avatar FILE.svg] [--conversation ID]] [--store file|keychain|auto] [--stdin]"})
}
