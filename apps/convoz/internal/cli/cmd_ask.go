package cli

func init() {
	Register(Command{Name: "ask", Order: 55, Run: Ask,
		Usage: "convoz ask [--question Q] [--recommend L --why W] [--alt L --alt-why W]... [--urgent] [--thread ROOT] [--app FILE] [--client-id C] <conv>\n       convoz ask withdraw <id>"})
}
