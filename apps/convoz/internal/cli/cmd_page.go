package cli

func init() {
	Register(Command{Name: "page", Summary: "Read, or take a screenshot of, the tab the owner shares with your conversation.", Example: "convoz page read --as devtool", Subs: []string{"read", "shot", "status"}, Order: 67, Run: Page,
		Usage: "convoz page read [--conv N] [--json]\nconvoz page shot [--conv N] [--out PATH]\nconvoz page status [--json]"})
}
