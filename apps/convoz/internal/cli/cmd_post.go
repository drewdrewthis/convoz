package cli

func init() {
	Register(Command{Name: "post", Summary: "Post a message in a conversation.", Example: "convoz post --as code-review 41 \"Build is green\"", Order: 50, Run: Post,
		Usage: "convoz post [--format F] [--app FILE] [--client-id C] <conv> <text|->"})
}
