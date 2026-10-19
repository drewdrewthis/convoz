package cli

import "strconv"

func init() {
	Register(Command{Name: "reply", Summary: "Reply inside a thread (not a normal answer; use convoz post for that).", Example: "convoz reply --as code-review 812 \"Fixed in 3f2a\"", Order: 55, Run: Reply,
		Usage: "convoz reply [--broadcast] [--format F] [--app FILE] [--file PATH]... [--client-id C] <message> [text|-]"})
}

// Reply is for threads only; a normal answer is `convoz post`. It runs `convoz reply [--broadcast] [--format F] [--app FILE] [--file PATH]... [--client-id C] <message> [text|-]`: a reply in the thread of a
// message: a top-level one, or one inside a thread (the reply goes to the thread's root). --broadcast also shows it in the main list. It prints the reply's id. The conversation is found from the
// message, and a retry with the same client id stores the reply once, as for `convoz post`.
func Reply(args []string, io IO) int {
	f := newChatFlags("reply", io)
	f.textFrom = 1
	opt := newPostFlags(f)
	broadcast := f.fs.Bool("broadcast", false, "also show the reply in the main list")
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if !opt.argsOK(pos) {
		return usageError(io, "usage: convoz reply [--broadcast] [--format F] [--app FILE] [--file PATH]... [--client-id C] <message> [text|-]")
	}
	root, err := strconv.ParseInt(pos[0], 10, 64)
	if err != nil || root <= 0 {
		return usageError(io, pos[0]+" is not a message id")
	}
	opt.broadcast = *broadcast
	return opt.send(f, io, 0, root, opt.textOf(pos))
}
