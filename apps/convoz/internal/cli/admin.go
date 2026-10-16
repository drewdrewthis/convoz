// Package cli is the convoz command-line client. It imports internal/wire and nothing under internal/server.
package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Exit codes (design §13.2).
const (
	ExitOK      = 0
	ExitUsage   = 2
	ExitAuth    = 3
	ExitNetwork = 6
)

// DefaultAdminSocket is where the service creates its admin socket.
const DefaultAdminSocket = "/run/convoz/admin.sock"

// Admin runs `convoz admin <command>`. It returns the process exit code.
func Admin(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] != "bootstrap-link" {
		fmt.Fprintln(stderr, "usage: convoz admin bootstrap-link [--admin-socket PATH]")
		return ExitUsage
	}
	fs := flag.NewFlagSet("admin bootstrap-link", flag.ContinueOnError)
	fs.SetOutput(stderr)
	socket := fs.String("admin-socket", DefaultAdminSocket, "admin socket of the running server")
	if err := fs.Parse(args[1:]); err != nil {
		return ExitUsage
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	link, err := BootstrapLink(ctx, *socket)
	if err != nil {
		fmt.Fprintf(stderr, "convoz: %s\n", err)
		var netErr *net.OpError
		if errors.As(err, &netErr) {
			return ExitNetwork
		}
		return 1
	}
	fmt.Fprintln(stdout, link.URL)
	return ExitOK
}

// BootstrapLink asks the server over its admin socket for a one-time bootstrap link.
func BootstrapLink(ctx context.Context, socket string) (wire.BootstrapLink, error) {
	client := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		},
	}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://localhost"+wire.AdminBootstrapLink, bytes.NewReader([]byte("{}")))
	if err != nil {
		return wire.BootstrapLink{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return wire.BootstrapLink{}, fmt.Errorf("cannot reach the admin socket %s: %w", socket, err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<16))
	if res.StatusCode != http.StatusOK {
		var e wire.Error
		if json.Unmarshal(body, &e) == nil && e.Error.Message != "" {
			return wire.BootstrapLink{}, fmt.Errorf("server refused: %s", e.Error.Message)
		}
		return wire.BootstrapLink{}, fmt.Errorf("server answered %d", res.StatusCode)
	}
	var link wire.BootstrapLink
	if err := json.Unmarshal(body, &link); err != nil || link.URL == "" {
		return wire.BootstrapLink{}, errors.New("server answered with an unreadable link")
	}
	return link, nil
}
