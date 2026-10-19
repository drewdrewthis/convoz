package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Watch backoff after a network error or a 5xx: 1 s, doubling, at most 30 s.
const (
	watchBackoffFirst = time.Second
	watchBackoffMax   = 30 * time.Second
	// printedMemory bounds the set of claims already printed; past it the set starts over.
	printedMemory = 1000
)

// Watch runs `convoz watch [--json]`: it long-polls the inbox and prints one line per item as soon as it is claimed,
// then leaves the item in the inbox. Every claim of the session reaches it, even one made by a poll whose answer was lost. The agent acks it with `convoz ack` after it has answered; if it never does,
// the claim runs out and the item comes back with a new token, and prints again.
//
// It exits 3 when the session ends and otherwise runs until it is stopped, riding out network errors.
func Watch(args []string, io IO) int {
	f := newChatFlags("watch", io)
	if pos, ok := f.parse(args, io); !ok {
		return ExitUsage
	} else if len(pos) != 0 {
		return usageError(io, "usage: convoz watch [--json]")
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	poll := k.c.withTimeout((wire.MaxHoldSeconds + 15) * time.Second)
	printed := map[string]bool{}
	// after is the cursor of the last answer: the server sends every claim of this session made since, also one whose answer
	// was lost on the way (a silent retry of the transport hides that loss) and one another loop of the session made.
	var after int64
	held := true // for a server without after=: the first poll, and the first after an error, also return the held claims
	backoff := watchBackoffFirst
	for {
		q := url.Values{"wait": {strconv.Itoa(wire.MaxHoldSeconds)}, "after": {strconv.FormatInt(after, 10)}}
		if !held {
			q.Set("held", "0")
		}
		var out wire.InboxResponse
		err := poll.call(context.Background(), "GET", wire.RouteInbox+"?"+q.Encode(), k.lease, nil, &out)
		if err != nil {
			if !retryable(err) {
				return k.fail(err)
			}
			fmt.Fprintf(io.Stderr, "convoz: %s; trying again in %s\n", err, backoff)
			time.Sleep(backoff)
			backoff = min(backoff*2, watchBackoffMax)
			held = true
			continue
		}
		backoff, held = watchBackoffFirst, false
		after = max(after, out.Cursor)
		if len(printed) > printedMemory {
			printed = map[string]bool{}
		}
		for _, it := range out.Items {
			key := strconv.FormatInt(it.ID, 10) + ":" + it.ClaimToken
			if printed[key] {
				continue
			}
			printed[key] = true
			if err := k.writeWatchLine(it); err != nil {
				return fail(io, err)
			}
		}
	}
}

// retryable is true for a lost connection, a rate limit or a server fault: things that pass.
func retryable(err error) bool {
	if errors.Is(err, errUnreachable) {
		return true
	}
	status, _ := statusCode(err)
	return status == 429 || status >= 500
}

func (k *chatCmd) writeWatchLine(it wire.InboxItem) error {
	if !k.asJSON {
		_, err := fmt.Fprintf(k.io.Stdout, "%s (ack: convoz ack %s)\n", itemLine(it), ackArg(it))
		return err
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf) // one line: the encoder escapes newlines inside strings
	enc.SetEscapeHTML(false)
	err := enc.Encode(wire.WatchLine{
		ItemID: it.ID, ClaimToken: it.ClaimToken, Ack: ackArg(it), Reason: it.Reason, ConversationID: it.Conversation.ID, ConversationTitle: it.Conversation.Title,
		Count: it.Count, MessageID: it.Message.ID, ThreadRootID: it.Message.ThreadRootID, Author: it.Message.Author.Handle, Body: it.Message.Body, Text: wordsOf(it.Message),
		CreatedAt: time.UnixMilli(it.Message.CreatedAt).UTC().Format(time.RFC3339),
	})
	if err != nil {
		return err
	}
	_, err = k.io.Stdout.Write(buf.Bytes())
	return err
}

// ackArg is the word that acks an item: "<id>:<token>".
func ackArg(it wire.InboxItem) string { return strconv.FormatInt(it.ID, 10) + ":" + it.ClaimToken }
