package cli

func init() {
	Register(Command{Name: "ask", Order: 52, Run: Ask,
		Usage: "convoz ask <conv> --question Q --recommend L --why W --alt L --alt-why W [--alt L --alt-why W ...] [--urgent] [--thread ROOT] [--app FILE]\n       convoz ask withdraw <id>"})
}
