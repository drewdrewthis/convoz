package cli

// What the MCP server (internal/mcp) needs from the CLI: the same session rules, so a Bash call and an MCP call of one Claude
// session share one lease.

// OpenAgentSession finds the live session of agent `as` for the client id in CLAUDE_CODE_SESSION_ID, or starts one. A restart
// of the caller therefore finds the session it left (M5), and the claims that session holds.
func OpenAgentSession(io IO, as string) error {
	dir, err := configDir(io.Getenv)
	if err != nil {
		return err
	}
	creds, err := loadCredentials(dir, osKeychain{io.Getenv})
	if err != nil {
		return err
	}
	_, err = sessionForAgent(dir, newClient(creds.Server), creds, as, io.Getenv("CLAUDE_CODE_SESSION_ID"))
	return err
}

// CloseAgentSession ends the lease of the session of agent `as` for the client id in CLAUDE_CODE_SESSION_ID, if there is one.
// A session that is gone or ended already counts as ended.
func CloseAgentSession(io IO, as string) int {
	dir, err := configDir(io.Getenv)
	if err != nil {
		return fail(io, err)
	}
	sid := findSession(dir, as, io.Getenv("CLAUDE_CODE_SESSION_ID"))
	if sid == "" {
		return ExitOK
	}
	return SessionEnd([]string{"--sid", sid}, io)
}

// Fail prints err the way every command does and returns its exit code.
func Fail(io IO, err error) int { return sessionEnded(io, err) }
