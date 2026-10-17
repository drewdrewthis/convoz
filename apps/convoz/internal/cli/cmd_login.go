package cli

func init() {
	Register(Command{Name: "login", Order: 20, Run: Login,
		Usage: "convoz login --server URL [--name N] [--store file|keychain|auto] [--stdin]"})
}
