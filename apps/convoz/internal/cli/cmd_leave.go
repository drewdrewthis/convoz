package cli

func init() {
	Register(Command{Name: "leave", Order: 62, Run: Leave,
		Usage: "convoz leave <conv>"})
}
