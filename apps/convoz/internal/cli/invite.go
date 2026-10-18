package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

const inviteUsage = "usage: convoz invite [--conv ID] [--note TEXT] [--admin-socket P]"

// Invite runs `convoz invite [--conv ID] [--note TEXT]`: it makes an invite that lets one agent outside the tailnet ask for access
// (owner ruling, 2026-10-18: invites are always one use). It works for 24 hours. It prints the token, or with --json the invite with the
// command to run. The token is shown once: the server keeps only its hash.
//
// With a session (--sid, --as or their environment variables) the invite is the agent's: it may name only a conversation the agent is in.
// With none, the command talks to the admin socket of the server on this box, and the invite is the owner's.
func Invite(args []string, io IO) int {
	f := newChatFlags("invite", io)
	conv := f.fs.Int64("conv", 0, "the conversation the invited agent asks to join; you must be in it")
	note := f.fs.String("note", "", "one line the owner reads on the approval card, up to 80 characters")
	socket := f.fs.String("admin-socket", DefaultAdminSocket, "without a session: the admin socket of the server on this machine")
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) != 0 || *conv < 0 {
		return usageError(io, inviteUsage)
	}
	req := wire.CreateInviteRequest{ConversationID: *conv, Note: *note}
	var out wire.InviteAnswer
	if *f.sid != "" || *f.as != "" {
		k, code := f.open(io)
		if k == nil {
			return code
		}
		ctx, cancel := context.WithTimeout(context.Background(), k.timeout)
		defer cancel()
		if err := k.call(ctx, "POST", wire.RouteInvites, req, &out); err != nil {
			return k.fail(err)
		}
		return printInvite(io, out.Invite, *f.asJSON)
	}
	ctx, cancel := context.WithTimeout(context.Background(), *f.timeout)
	defer cancel()
	if err := adminCall(ctx, *socket, wire.AdminInvites, req, &out); err != nil {
		return fail(io, err)
	}
	return printInvite(io, out.Invite, *f.asJSON)
}

func printInvite(io IO, inv wire.Invite, asJSON bool) int {
	if asJSON {
		raw, _ := json.Marshal(inv)
		fmt.Fprintln(io.Stdout, string(raw))
	} else {
		fmt.Fprintln(io.Stdout, inv.Token)
		fmt.Fprintf(io.Stderr, "convoz: Works once, until %s. The agent runs: %s\n", time.UnixMilli(inv.ExpiresAt).UTC().Format(time.RFC3339), inv.Login)
	}
	return ExitOK
}

// adminCall posts a JSON body to the admin socket of the server on this machine and reads the JSON answer. The socket decides who may
// ask (mode 0600), so there is no credential.
func adminCall(ctx context.Context, socket, route string, in, out any) error {
	raw, err := json.Marshal(in)
	if err != nil {
		return err
	}
	client := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		},
	}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://localhost"+route, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("%w: cannot reach the admin socket %s: %v (without a session this command asks the server on this machine; with one, pass --as)", errUnreachable, socket, err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<16))
	if res.StatusCode/100 != 2 {
		var e wire.Error
		if json.Unmarshal(body, &e) == nil && e.Error.Message != "" {
			return &statusError{status: res.StatusCode, code: e.Error.Code, msg: "server refused: " + e.Error.Message}
		}
		return &statusError{status: res.StatusCode, msg: fmt.Sprintf("server answered %d", res.StatusCode)}
	}
	if err := json.Unmarshal(body, out); err != nil {
		return errors.New("server answered with an unreadable invite")
	}
	return nil
}
