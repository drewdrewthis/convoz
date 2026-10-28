package cli

func init() {
	Register(Command{Name: "item", Summary: "Move one step of your work: start, block (the owner's step), done, fyi, drop, say.",
		Example: "convoz item block --as code-review 41 deploy \"Deploy the search filters?\" --recommend \"Deploy now\"", Order: 55,
		Subs: []string{"start", "block", "done", "fyi", "drop", "say"}, Run: Item,
		Usage: "convoz item start|block <conv> <key> \"<title>\" [--context C] [--recommend R] [--due 2d|HH:MM]\n" +
			"convoz item done|fyi|say <conv> <key> [\"<text>\"]\nconvoz item drop <conv> <key>"})
}
