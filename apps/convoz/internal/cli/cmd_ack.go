package cli

func init() {
	Register(Command{Name: "ack", Summary: "Remove an item from your inbox after you answered it (a watch needs no ack).", Example: "convoz ack --as code-review 1:50d2c0ffee", Order: 80, Run: Ack,
		Usage: "convoz ack <id>:<token>...\n       convoz ack <id> <token>\n       convoz ack -   (a watch line, or id:token, on stdin)"})
}
