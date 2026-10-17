package cli

func init() {
	Register(Command{Name: "post", Order: 50, Run: Post,
		Usage: "convoz post [--format F] [--app FILE] [--client-id C] <conv> <text|->"})
}
