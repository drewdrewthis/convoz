package cli

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// sessionsDir is the directory of session files inside the config directory.
const sessionsDir = "sessions"

// sidRE is a local session id: lowercase hex, 6 or more. It is also the file name, so nothing else may pass.
var sidRE = regexp.MustCompile(`^[0-9a-f]{6,32}$`)

// sessionFile is what a started session leaves on disk (mode 0600). The lease is the only secret in it.
//
// `convoz session end` does not remove the file: it drops the lease and keeps Ended, the reason in words. A command
// that got the sid before the end but opens the file after it (a watch started a moment earlier) then says the
// session ended, as it would had it reached the server first, instead of claiming there never was a session.
//
// An agent's handle can change (I-51), so the file keys on IdentityID and keeps As, the handle the caller started it with: `--as old`
// still finds it, and Identity is rewritten to the handle the server says the agent has now.
type sessionFile struct {
	Lease      string `json:"lease,omitempty"`
	Identity   string `json:"identity"`
	IdentityID int64  `json:"identity_id,omitempty"`
	As         string `json:"as,omitempty"`
	Machine    string `json:"machine"`
	ClientID   string `json:"client_id"`
	Ended      string `json:"ended,omitempty"`
}

// names reports whether the session is the one a caller means by --as: the handle it has, or the one it was started with.
func (s sessionFile) names(as string) bool { return s.Identity == as || s.As != "" && s.As == as }

// sameAgent reports whether two session files are of one agent: by id when both know it, else by handle.
func (s sessionFile) sameAgent(o sessionFile) bool {
	if s.IdentityID != 0 && o.IdentityID != 0 {
		return s.IdentityID == o.IdentityID
	}
	return s.Identity == o.Identity
}

// endedHere is the reason kept when `convoz session end` itself ended the lease (the server's words for a logout).
const endedHere = "The session was ended."

func randomHex(nBytes int) string {
	b := make([]byte, nBytes)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// sessionPath is the file of a local session id; ok is false for an id that is not one.
func sessionPath(dir, sid string) (string, bool) {
	if !sidRE.MatchString(sid) {
		return "", false
	}
	return filepath.Join(dir, sessionsDir, sid), true
}

func loadSession(dir, sid string) (sessionFile, error) {
	path, ok := sessionPath(dir, sid)
	if !ok {
		return sessionFile{}, fmt.Errorf("%q is not a session id", sid)
	}
	raw, err := readPrivate(filepath.Join(dir, sessionsDir), path)
	if os.IsNotExist(err) {
		return sessionFile{}, &unknownSessionError{sid}
	}
	if err != nil {
		return sessionFile{}, err
	}
	var s sessionFile
	if err := json.Unmarshal(raw, &s); err != nil || (s.Lease == "") == (s.Ended == "") {
		return sessionFile{}, fmt.Errorf("%s is not a session file", path)
	}
	if s.Ended != "" {
		return s, endedSessionError(s.Ended)
	}
	return s, nil
}

// endedSessionError is the answer the server gives an ended lease, so sessionEnded prints it the same way.
func endedSessionError(reason string) error {
	return &statusError{status: http.StatusUnauthorized, code: wire.CodeSessionEnded, msg: reason}
}

// isEnded reports whether err is a lease that no longer works, from the server or from the local marker.
func isEnded(err error) bool {
	_, code := statusCode(err)
	return code == wire.CodeSessionEnded
}

// markSessionEnded replaces the session file with one that keeps who it was for and why it ended, but not the lease.
func markSessionEnded(dir, sid, reason string) error {
	path, ok := sessionPath(dir, sid)
	if !ok {
		return fmt.Errorf("%q is not a session id", sid)
	}
	s, err := loadSession(dir, sid)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(sessionFile{Identity: s.Identity, IdentityID: s.IdentityID, As: s.As, Machine: s.Machine, ClientID: s.ClientID, Ended: reason})
	if err != nil {
		return err
	}
	return writePrivate(path, raw)
}

// unknownSessionError is a --sid with no session file; it is an auth failure (exit 3): there is no lease to use.
type unknownSessionError struct{ sid string }

func (e *unknownSessionError) Error() string {
	return fmt.Sprintf("there is no session %s on this machine: run convoz session start", e.sid)
}

func saveSession(dir string, s sessionFile) (string, error) {
	if err := privateDir(filepath.Join(dir, sessionsDir)); err != nil {
		return "", err
	}
	raw, err := json.Marshal(s)
	if err != nil {
		return "", err
	}
	for {
		sid := randomHex(4)
		path, _ := sessionPath(dir, sid)
		if _, err := os.Stat(path); err == nil {
			continue
		}
		return sid, writePrivate(path, raw)
	}
}

// forgetSessions removes the session files of one client id and agent: a re-mint replaced their leases.
func forgetSessions(dir string, agent sessionFile, clientID string) {
	entries, err := os.ReadDir(filepath.Join(dir, sessionsDir))
	if err != nil {
		return
	}
	for _, e := range entries {
		if s, err := loadSession(dir, e.Name()); (err == nil || isEnded(err)) && s.sameAgent(agent) && s.ClientID == clientID {
			path, _ := sessionPath(dir, e.Name())
			_ = os.Remove(path)
		}
	}
}

// sessionEnded is the one message for a lease the server no longer honours; any other error is printed as it is.
func sessionEnded(io IO, err error) int {
	var se *statusError
	if errors.As(err, &se) && se.code == wire.CodeSessionEnded {
		fmt.Fprintf(io.Stderr, "convoz: The session ended. %s Run convoz session start again.\n", se.msg)
		return ExitAuth
	}
	return fail(io, err)
}

// SessionStart runs `convoz session start`: it mints a lease with the machine key, keeps it in a private
// file and prints only the local session id.
func SessionStart(args []string, io IO) int {
	fs := flag.NewFlagSet("session start", flag.ContinueOnError)
	fs.SetOutput(io.Stderr)
	as := fs.String("as", io.Getenv("CONVOZ_AS"), "the agent handle to act as")
	create := fs.Bool("create", false, "make the identity if it does not exist: at once with the create_identity scope, else the owner approves a request")
	display := fs.String("name", "", "the display name for --create (default: the handle)")
	more := addIntroFlags(fs)
	label := fs.String("label", "convoz cli", "what the owner sees next to the session")
	clientID := fs.String("client-id", io.Getenv("CLAUDE_CODE_SESSION_ID"), "the client id; the same one replaces the older lease")
	if !parseNoArgs(fs, args, io) {
		return ExitUsage
	}
	if *as == "" {
		return usageError(io, "--as needs an agent handle")
	}
	if !*create && (*display != "" || more.given()) {
		return usageError(io, "--name, --description, --avatar and --conversation need --create")
	}
	var intro *wire.IdentityIntro
	if *create {
		var err error
		if intro, err = more.intro(*as, *display); err != nil {
			return usageError(io, err.Error())
		}
	}
	if *clientID == "" {
		*clientID = "convoz-" + randomHex(8)
	}
	dir, err := configDir(io.Getenv)
	if err != nil {
		return fail(io, err)
	}
	kc := osKeychain{io.Getenv}
	creds, err := loadCredentials(dir, kc)
	if err != nil {
		return fail(io, err)
	}
	sid, err := startSession(io, dir, newClient(creds.Server), creds, strings.ToLower(*as), *clientID, *label, intro)
	if err != nil {
		return fail(io, err)
	}
	fmt.Fprintf(io.Stdout, "CONVOZ_SID=%s\n", sid)
	return ExitOK
}

// waitForOwner is how long `session start --create` waits for the owner before it gives up. The request itself stays for a day:
// the same command, run again, picks it up.
const waitForOwner = 10 * time.Minute

// startSession mints a lease for (as, clientID) and returns the local session id of its file. With an intro the identity is
// created when missing; when the owner has to approve it first, startSession files the request and asks again until the owner decides.
func startSession(io IO, dir string, c *client, creds Credentials, as, clientID, label string, intro *wire.IdentityIntro) (string, error) {
	req := wire.MintRequest{As: as, ClientID: clientID, Label: label}
	if intro != nil {
		req.Create = &wire.CreateIdentity{DisplayName: intro.DisplayName, Description: intro.Description, AvatarSVG: intro.AvatarSVG, ConversationID: intro.ConversationID}
	}
	deadline := time.Now().Add(waitForOwner)
	for announced := false; ; announced = true {
		var out struct {
			wire.MintResponse
			Request *wire.IdentityRequestState `json:"request"`
		}
		if err := c.call(context.Background(), "POST", wire.RouteSessions, creds.Key, req, &out); err != nil {
			return "", describeIdentityRefusal(err, as)
		}
		if out.Request == nil {
			if out.Renamed != nil {
				warnRenamed(io, *out.Renamed)
			}
			file := sessionFile{Lease: out.Lease, Identity: out.Session.Identity, IdentityID: out.Session.IdentityID, As: as, Machine: out.Session.Machine, ClientID: clientID}
			forgetSessions(dir, file, clientID)
			return saveSession(dir, file)
		}
		req.Create.Request = out.Request.Ref
		if !announced {
			fmt.Fprintf(io.Stderr, "convoz: Waiting for the owner to approve @%s on this machine. Open Convoz, Now.\n", as)
		}
		if !time.Now().Before(deadline) {
			return "", fmt.Errorf("the owner has not decided yet: run the same command again to keep waiting: %w", errAwaitingOwner)
		}
		wait := time.Duration(out.Request.IntervalMs) * time.Millisecond
		if wait <= 0 {
			wait = defaultInterval
		}
		time.Sleep(wait)
	}
}

// warnRenamed tells a caller that used an old handle what the agent is called now, and until when the old one works (I-51).
func warnRenamed(io IO, r wire.Renamed) {
	if io.Stderr == nil {
		return
	}
	fmt.Fprintf(io.Stderr, "convoz: @%s is now @%s. Use --as %s: @%s stops working on %s.\n", r.From, r.To, r.To, r.From, time.UnixMilli(r.Until).UTC().Format("2006-01-02"))
}

// renamedError refuses an old handle after its grace, the way the server does (403 handle_renamed): the words name the new one.
func renamedError(from, to string) error {
	return &statusError{status: http.StatusForbidden, code: wire.CodeHandleRenamed, msg: fmt.Sprintf("@%s is now @%s. Use --as %s.", from, to, to)}
}

// errAwaitingOwner marks the wait that ran out; it exits like an auth failure (3): nothing is wrong, but nothing may go on.
var errAwaitingOwner = errors.New("awaiting the owner")

// describeIdentityRefusal gives the refusals of a created identity their own words.
func describeIdentityRefusal(err error, as string) error {
	status, code := statusCode(err)
	switch {
	case code == wire.CodeHandleTaken:
		return fmt.Errorf("@%s is taken or was used before. Ask the owner to allow it on this machine, or pick another handle: %w", as, err)
	case code == wire.CodeRequestDenied:
		return fmt.Errorf("the owner denied the request for @%s: %w", as, err)
	case status == http.StatusGone:
		return fmt.Errorf("the request for @%s expired: run the command again: %w", as, err)
	}
	return err
}

// SessionEnd runs `convoz session end`: it ends the lease and removes the file. A lease that already ended
// counts as ended.
func SessionEnd(args []string, io IO) int {
	fs := flag.NewFlagSet("session end", flag.ContinueOnError)
	fs.SetOutput(io.Stderr)
	sid := fs.String("sid", io.Getenv("CONVOZ_SID"), "the local session id")
	if !parseNoArgs(fs, args, io) {
		return ExitUsage
	}
	dir, err := configDir(io.Getenv)
	if err != nil {
		return fail(io, err)
	}
	creds, err := loadCredentials(dir, osKeychain{io.Getenv})
	if err != nil {
		return fail(io, err)
	}
	s, err := loadSession(dir, *sid)
	if isEnded(err) {
		return ExitOK
	}
	if err != nil {
		return fail(io, err)
	}
	reason := endedHere
	err = newClient(creds.Server).call(context.Background(), "DELETE", wire.RouteSessionsMe, s.Lease, nil, nil)
	if err != nil {
		if !isEnded(err) {
			return fail(io, err)
		}
		reason = err.Error()
	}
	if err := markSessionEnded(dir, *sid, reason); err != nil {
		return fail(io, err)
	}
	return ExitOK
}
