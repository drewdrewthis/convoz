package cli

func init() {
	Register(Command{Name: "post", Summary: "Post a message in a conversation.", Example: "convoz post --fyi --as code-review 41 \"Build is green\"", Order: 50, Run: Post,
		Usage: "convoz post [--fyi] [--format F] [--app FILE] [--file PATH]... [--client-id C] <conv> [text|-]"})
}
