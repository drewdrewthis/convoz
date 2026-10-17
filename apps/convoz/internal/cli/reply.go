package cli

import "strconv"

// Reply runs `convoz reply [--broadcast] [--format F] [--app FILE] [--client-id C] <conv> <message> <text|->`: a post in the thread of
// a message. It takes the conversation too, because no route turns a message id into its conversation (design §13 has none).
// The message is the root of the thread (a main message). With --broadcast the reply also shows in the main thread. It prints the new message id, like post.
func Reply(args []string, io IO) int {
	f := newChatFlags("reply", io)
	opt := newPostFlags(f)
	broadcast := f.fs.Bool("broadcast", false, "also show the reply in the main thread")
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) != 3 {
		return usageError(io, "usage: convoz reply [--broadcast] [--format F] [--app FILE] [--client-id C] <conv> <message> <text|->")
	}
	conv, ok := convArg(io, pos[0])
	if !ok {
		return ExitUsage
	}
	root, err := strconv.ParseInt(pos[1], 10, 64)
	if err != nil || root <= 0 {
		return usageError(io, pos[1]+" is not a message id")
	}
	opt.broadcast = *broadcast
	return opt.send(f, io, conv, root, pos[2])
}
