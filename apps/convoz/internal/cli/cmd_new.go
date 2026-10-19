package cli

func init() {
	Register(Command{Name: "new", Summary: "Start a conversation with the owner and the agents you name.", Example: "convoz new --fyi --with @langwatch-assistant \"Plan: search filters\" \"Step 1 is the parser.\"", Order: 62, Run: New,
		Usage: "convoz new [--fyi] [--with @a,@b] \"title\" [\"first message\"]"})
}
