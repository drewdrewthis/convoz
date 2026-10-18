package cli

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	stdio "io"
	"os"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Version is the CLI version the machine reports about itself; SetBuild sets it.
var Version = "dev"

const (
	slowDownStep    = 5 * time.Second
	expirySlack     = 5 * time.Second // after expires_in, the local wait gives up
	defaultInterval = 5 * time.Second
)

var nameRE = regexp.MustCompile(`^[a-z0-9.-]{1,60}$`)

// defaultMachineName is the host name made into a valid machine name.
func defaultMachineName() string {
	host, _ := os.Hostname()
	name := strings.Trim(regexp.MustCompile(`[^a-z0-9.-]+`).ReplaceAllString(strings.ToLower(host), "-"), "-.")
	if len(name) > 60 {
		name = name[:60]
	}
	return name
}

// Login runs `convoz login`: the device flow, or with --stdin the storing of a key the owner revealed.
// It never prints a key or a device code.
func Login(args []string, io IO) int {
	fs := flag.NewFlagSet("login", flag.ContinueOnError)
	fs.SetOutput(io.Stderr)
	server := fs.String("server", "", "the Convoz server, e.g. https://convoz.example.ts.net")
	name := fs.String("name", defaultMachineName(), "the name of this machine")
	stdin := fs.Bool("stdin", false, "store the key given on standard input instead of asking the owner")
	store := fs.String("store", storeAuto, "where the key lives: file, keychain or auto")
	as := fs.String("as", "", "the handle of the agent that asks to connect; the owner's one Approve makes the machine and this agent")
	invite := fs.String("invite", io.Getenv("CONVOZ_INVITE"), "the one-use invite that lets an agent outside the tailnet ask to connect (CONVOZ_INVITE also sets it); a server on the tailnet needs none")
	more := addIntroFlags(fs)
	if !parseNoArgs(fs, args, io) {
		return ExitUsage
	}
	var intro *wire.IdentityIntro
	switch {
	case *as != "":
		var err error
		if intro, err = more.intro(*as, ""); err != nil {
			return usageError(io, err.Error())
		}
	case more.given():
		return usageError(io, "--description, --avatar and --conversation need --as")
	}
	if !nameRE.MatchString(*name) {
		return usageError(io, "--name needs 1 to 60 characters from a-z, 0-9, . and -")
	}
	if *store != storeFile && *store != storeKeychain && *store != storeAuto {
		return usageError(io, "--store is file, keychain or auto")
	}
	base, err := validServer(*server)
	if err != nil {
		return usageError(io, err.Error())
	}
	dir, err := configDir(io.Getenv)
	if err != nil {
		return fail(io, err)
	}
	kc := osKeychain{io.Getenv}
	// Only the file store needs the folder; auto uses it when no keychain answers. A keychain that fails later is caught by finishLogin.
	if *store == storeFile || (*store == storeAuto && !kc.available()) {
		if err := checkWritable(dir); err != nil {
			return failConfig(io, dir, err)
		}
	}
	if *stdin { // storing a key contacts no server, so there is no version to compare
		key, err := readKey(io)
		if err != nil {
			return usageError(io, err.Error())
		}
		return finishLogin(io, dir, kc, Credentials{Server: base, Machine: *name, Key: key}, *store, false)
	}
	WarnIfStale(io, newClient(base))
	return deviceFlow(io, dir, kc, newClient(base), base, *name, *store, intro, strings.TrimSpace(*invite))
}

func usageError(io IO, msg string) int {
	fmt.Fprintf(io.Stderr, "convoz: %s\n", msg)
	return ExitUsage
}

// parseFlags parses args into fs. A bad flag is a usage error with the convoz: prefix: the flag package alone would print it bare.
func parseFlags(fs *flag.FlagSet, args []string, io IO) bool {
	fs.SetOutput(stdio.Discard)
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			fs.SetOutput(io.Stdout) // the flags, for `convoz <cmd> --help`
			fs.PrintDefaults()
			return false
		}
		usageError(io, err.Error())
		return false
	}
	return true
}

// parseNoArgs is parseFlags for a command that takes no positional argument.
func parseNoArgs(fs *flag.FlagSet, args []string, io IO) bool {
	if !parseFlags(fs, args, io) {
		return false
	}
	if fs.NArg() != 0 {
		usageError(io, fmt.Sprintf("%s takes no arguments, got %q", fs.Name(), fs.Arg(0)))
		return false
	}
	return true
}

// fail prints err and returns its exit code. A permission error is an auth failure (exit 3).
func fail(io IO, err error) int {
	fmt.Fprintf(io.Stderr, "convoz: %s\n", err)
	var perm *permError
	var unknown *unknownSessionError
	switch {
	case errors.As(err, &perm), errors.As(err, &unknown), errors.Is(err, errNotLoggedIn):
		return ExitAuth
	}
	return exitCode(err)
}

func readKey(io IO) (string, error) {
	line, err := bufio.NewReader(io.Stdin).ReadString('\n')
	key := strings.TrimSpace(line)
	if key == "" && err != nil {
		return "", errors.New("no key on standard input")
	}
	if !machineKeyRE.MatchString(key) {
		return "", errors.New("that is not a machine key")
	}
	return key, nil
}

// failConfig reports a config folder that cannot be written. It names the path and the fix, and exits as for any permission error.
func failConfig(io IO, dir string, err error) int {
	var pe *os.PathError
	if errors.As(err, &pe) {
		err = pe.Err // the path is already named once
	}
	fmt.Fprintf(io.Stderr, "convoz: cannot write %s: %s. Set XDG_CONFIG_HOME to a writable folder, or use --store keychain\n", dir, err)
	return ExitAuth
}

// finishLogin stores the key. fromDevice says the owner already approved a card for it: the device code is not kept, so a failed save
// cannot be resumed and the message says how to start over.
func finishLogin(io IO, dir string, kc keychain, c Credentials, store string, fromDevice bool) int {
	if err := saveCredentials(dir, kc, c, store); err != nil {
		code := fail(io, err)
		if fromDevice {
			fmt.Fprintf(io.Stderr, "convoz: the key could not be saved. Fix the folder %s, then run the same convoz login command again within 10 minutes. "+
				"The old card for %q is stale: the owner can deny or revoke it in Convoz.\n", dir, c.Machine)
		}
		return code
	}
	fmt.Fprintf(io.Stdout, "Logged in as machine %q.\n", c.Machine)
	fmt.Fprintln(io.Stdout, watchNext)
	return ExitOK
}

func deviceFlow(io IO, dir string, kc keychain, c *client, base, name, store string, intro *wire.IdentityIntro, invite string) int {
	host, _ := os.Hostname()
	var code wire.DeviceCodeResponse
	err := c.call(context.Background(), "POST", wire.RouteDeviceCode, "", wire.DeviceCodeRequest{
		Name: name, HostInfo: wire.HostInfo{Hostname: host, OS: runtime.GOOS, Arch: runtime.GOARCH, CLIVersion: Version}, Identity: intro, Invite: invite,
	}, &code)
	if err != nil {
		return fail(io, err)
	}
	if intro != nil {
		fmt.Fprintf(io.Stdout, "Approve %q as @%s in Convoz. Code: %s\n", name, intro.Handle, code.UserCode)
	} else {
		fmt.Fprintf(io.Stdout, "Approve %q in Convoz. Code: %s\n", name, code.UserCode)
	}

	interval := time.Duration(code.IntervalMs) * time.Millisecond
	if interval <= 0 {
		interval = time.Duration(code.Interval) * time.Second
	}
	if interval <= 0 {
		interval = defaultInterval
	}
	deadline := time.Now().Add(time.Duration(code.ExpiresIn)*time.Second + expirySlack)
	for time.Now().Before(deadline) {
		time.Sleep(interval)
		var tok wire.DeviceTokenResponse
		err := c.call(context.Background(), "POST", wire.RouteDeviceToken, "", wire.DeviceTokenRequest{DeviceCode: code.DeviceCode}, &tok)
		if err == nil {
			return finishLogin(io, dir, kc, Credentials{Server: base, Machine: tok.MachineName, Key: tok.MachineKey}, store, true)
		}
		status, errCode := statusCode(err)
		switch {
		case errCode == wire.CodeAuthorizationPending:
		case errCode == wire.CodeSlowDown:
			interval += slowDownStep
		case errCode == wire.CodeAccessDenied:
			fmt.Fprintln(io.Stderr, "convoz: The owner denied the request.")
			return ExitAuth
		case errCode == wire.CodeExpiredToken:
			return expired(io, invite != "")
		case status == 0 || status >= 500 || status == 429:
			// The server could not be reached, or the answer got lost: ask again with the same device code.
		default:
			return fail(io, err)
		}
	}
	return expired(io, invite != "")
}

// expired ends a login whose code is of no use. A server over the internet answers a start it will not honour (an invite that is
// used, revoked, out of date or wrong) like an accepted one and lets the code die, so with an invite the message names that cause too.
func expired(io IO, withInvite bool) int {
	fmt.Fprintln(io.Stderr, "convoz: The code expired. Run convoz login again.")
	if withInvite {
		fmt.Fprintln(io.Stderr, "convoz: If the invite was already used, revoked or older than 24 hours, ask for a new one.")
	}
	return ExitAuth
}
