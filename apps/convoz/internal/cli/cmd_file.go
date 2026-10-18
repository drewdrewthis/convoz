package cli

func init() {
	Register(Command{Name: "file", Summary: "Fetch an attachment of a conversation you are in.", Example: "convoz file --as code-review -o report.pdf Kq3x7ZpTn0bVd9aLwEhY2g", Order: 64, Run: File,
		Usage: "convoz file [-o PATH|-] <id>"})
}
