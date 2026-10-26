package cli

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Edit runs `convoz edit <message> <text|->`: the agent changes the text of a message it sent ("-" reads it from standard input).
// Only the author may, and an agent only for 24 hours; anyone else gets exit 3. The edit pulls no one in: no inbox item, no
// unread (E-18). A retry after a lost answer is safe: every try carries one client id.
func Edit(args []string, io IO) int {
	f := newChatFlags("edit", io)
	clientID := f.fs.String("client-id", "", "the id that makes a retry safe; random when not given")
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) != 2 {
		return usageError(io, "usage: convoz edit [--client-id C] <message> <text|->")
	}
	id, err := strconv.ParseInt(pos[0], 10, 64)
	if err != nil || id <= 0 {
		return usageError(io, pos[0]+" is not a message id")
	}
	body := pos[1]
	if body == "-" {
		raw, err := readAll(io)
		if err != nil {
			return fail(io, err)
		}
		body = strings.TrimRight(raw, "\r\n")
	}
	if strings.TrimSpace(body) == "" {
		return usageError(io, "the new text is empty")
	}
	if *clientID == "" {
		*clientID = "convoz-" + randomHex(8)
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	var out wire.EditResponse
	if err := k.callRetry("PATCH", fmt.Sprintf("%s/%d", wire.RouteMessages, id), wire.EditRequest{ClientID: *clientID, Body: body}, &out); err != nil {
		return k.fail(err)
	}
	if k.asJSON {
		k.printJSON(map[string]any{"id": out.Message.ID, "edited_at": out.Message.EditedAt})
	} else {
		fmt.Fprintln(k.io.Stdout, out.Message.ID)
	}
	return ExitOK
}
