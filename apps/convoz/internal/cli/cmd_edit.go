package cli

func init() {
	Register(Command{Name: "edit", Summary: "Change the text of a message you sent.", Example: "echo \"Build is green\" | convoz edit --as devtool 5755 -", Order: 61, Run: Edit,
		Usage: "convoz edit [--client-id C] <message> <text|->"})
}
