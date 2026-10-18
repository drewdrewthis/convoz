package cli

func init() {
	Register(Command{Name: "rename", Order: 63, Run: Rename,
		Usage: "convoz rename <conv> <title|->"})
}
