package cli

func init() {
	Register(Command{Name: "run", Summary: "Serve your inbox with one short-lived process per item (no terminal needed); default: claude -p with a normal agent's tools.", Example: "convoz run --as docs --workdir ~/docs", Order: 91, Run: Run,
		Usage: "convoz run --as HANDLE [--workdir D] [--allow RULE]... [--write] [--budget USD] [--fresh-after N] [--item-timeout D] [-- cmd args...]"})
}
