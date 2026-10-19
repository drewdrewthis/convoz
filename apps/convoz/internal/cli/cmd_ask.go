package cli

func init() {
	Register(Command{Name: "ask", Summary: "Ask the owner a question with options, when it is the owner's call.", Example: "convoz ask --as code-review --question \"Ship it?\" --recommend Yes --why \"All checks pass\" --alt No --alt-why \"Wait for QA\" --owners-call one-way --owners-call-why \"A release cannot be taken back\" 41", Order: 55, Run: Ask,
		Usage: "convoz ask [--question Q] [--recommend L --why W] [--alt L --alt-why W]... --owners-call KIND --owners-call-why W [--urgent] [--thread ROOT] [--app FILE] [--client-id C] <conv>\n       convoz ask --draft TEXT [--original TEXT] [--original-from LINE] [--question Q] <conv> [Q]   (anything sent in the owner's name)\n       convoz ask withdraw <id>"})
}
