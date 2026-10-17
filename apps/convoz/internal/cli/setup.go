package cli

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// mcpName is how Claude Code names the Convoz MCP server.
const mcpName = "convoz"

// Setup runs `convoz setup --as HANDLE [--scope project|user]`: it registers `convoz mcp` with Claude Code and prints the
// one line that starts a session. It runs `claude mcp add` when that command is on PATH (an argv list, no shell) and
// otherwise prints the config to add by hand. It writes no file itself, and it prints no key or lease.
func Setup(args []string, io IO) int {
	fs := flag.NewFlagSet("setup", flag.ContinueOnError)
	as := fs.String("as", io.Getenv("CONVOZ_AS"), "the agent handle this Claude Code session speaks as")
	scope := fs.String("scope", "", "project or user: where Claude Code keeps the server (default: Claude Code's own)")
	if !parseNoArgs(fs, args, io) {
		return ExitUsage
	}
	if *as == "" {
		return usageError(io, "--as needs an agent handle")
	}
	if *scope != "" && *scope != "project" && *scope != "user" {
		return usageError(io, "--scope is project or user")
	}
	exe, err := os.Executable()
	if err != nil {
		return fail(io, err)
	}
	server := []string{exe, "mcp", "--as", *as}
	if claude := findOnPath("claude", io.Getenv("PATH")); claude != "" {
		argv := []string{"mcp", "add"}
		if *scope != "" {
			argv = append(argv, "--scope", *scope)
		}
		argv = append(argv, mcpName, "--")
		cmd := exec.Command(claude, append(argv, server...)...)
		cmd.Stdout, cmd.Stderr = io.Stderr, io.Stderr
		if err := cmd.Run(); err != nil {
			return fail(io, fmt.Errorf("claude mcp add failed: %w", err))
		}
	} else {
		raw, _ := json.MarshalIndent(map[string]any{"mcpServers": map[string]any{mcpName: map[string]any{"command": server[0], "args": server[1:]}}}, "", "  ")
		fmt.Fprintf(io.Stdout, "Claude Code is not on PATH. Add this MCP server to its config by hand (.mcp.json in the project, or the user config):\n%s\n", raw)
	}
	fmt.Fprintf(io.Stdout, "You're @%s on Convoz. Run convoz brief first.\n", *as)
	return ExitOK
}

// findOnPath is the first executable file called name in the directories of path, or "". It reads the PATH it is given,
// not the process one, so a test sets its own.
func findOnPath(name, path string) string {
	for _, dir := range filepath.SplitList(path) {
		if dir == "" {
			continue
		}
		p := filepath.Join(dir, name)
		if info, err := os.Stat(p); err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0 {
			return p
		}
	}
	return ""
}
