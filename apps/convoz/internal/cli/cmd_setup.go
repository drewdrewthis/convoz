package cli

func init() {
	Register(Command{Name: "setup", Summary: "Register the Convoz MCP server with Claude Code.", Example: "convoz setup --as code-review --scope project", Order: 90, Run: Setup,
		Usage: "convoz setup --as HANDLE [--scope project|user]"})
}
