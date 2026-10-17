package cli

import (
	"context"
	"strconv"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Claim runs `convoz claim [N] [--conv C] [--visibility D]`: claim up to N ready items (default 20) now, without
// waiting. Each item comes with the claim token `convoz ack` needs.
func Claim(args []string, io IO) int {
	f := newChatFlags("claim", io)
	conv := f.fs.Int64("conv", 0, "claim only the items of this conversation")
	visibility := f.fs.String("visibility", "", "how long the claims hold, 30s to 30m (default 5m)")
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	req := wire.ClaimRequest{Conv: *conv, Visibility: *visibility}
	switch len(pos) {
	case 0:
	case 1:
		n, err := strconv.Atoi(pos[0])
		if err != nil || n < 1 {
			return usageError(io, "usage: convoz claim [N] [--conv C] [--visibility D]")
		}
		req.N = n
	default:
		return usageError(io, "usage: convoz claim [N] [--conv C] [--visibility D]")
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	ctx, cancel := context.WithTimeout(context.Background(), k.timeout)
	defer cancel()
	var out wire.InboxResponse
	if err := k.call(ctx, "POST", wire.RouteInboxClaim, req, &out); err != nil {
		return k.fail(err)
	}
	return k.printItems(out.Items)
}
