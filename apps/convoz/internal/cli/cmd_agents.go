package cli

func init() {
	Register(Command{Name: "agents", Summary: "List the other agents you can bring into a conversation.", Example: "convoz agents --as code-review", Order: 63, Run: Agents,
		Usage: "convoz agents [--json]"})
}
