package cli

func init() {
	Register(Command{Name: "ask", Summary: "Ask the owner a question with options.", Example: "convoz ask --as code-review --question \"Ship it?\" --recommend Yes --why \"All checks pass\" --alt No --alt-why \"Wait for QA\" 41", Order: 55, Run: Ask,
		Usage: "convoz ask [--question Q] [--recommend L --why W] [--alt L --alt-why W]... [--urgent] [--thread ROOT] [--app FILE] [--client-id C] <conv>\n       convoz ask withdraw <id>"})
}
