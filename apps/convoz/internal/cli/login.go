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

// Version is the CLI version the machine reports about itself; the main package sets it at link time.
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
	if !parseNoArgs(fs, args, io) {
		return ExitUsage
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
	if *stdin {
		key, err := readKey(io)
		if err != nil {
			return usageError(io, err.Error())
		}
		return finishLogin(io, dir, kc, Credentials{Server: base, Machine: *name, Key: key}, *store)
	}
	return deviceFlow(io, dir, kc, newClient(base), base, *name, *store)
}

func usageError(io IO, msg string) int {
	fmt.Fprintf(io.Stderr, "convoz: %s\n", msg)
	return ExitUsage
}

// parseFlags parses args into fs. A bad flag is a usage error with the convoz: prefix: the flag package alone would print it bare.
func parseFlags(fs *flag.FlagSet, args []string, io IO) bool {
	fs.SetOutput(stdio.Discard)
	if err := fs.Parse(args); err != nil {
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

func finishLogin(io IO, dir string, kc keychain, c Credentials, store string) int {
	if err := saveCredentials(dir, kc, c, store); err != nil {
		return fail(io, err)
	}
	fmt.Fprintf(io.Stdout, "Logged in as machine %q.\n", c.Machine)
	return ExitOK
}

func deviceFlow(io IO, dir string, kc keychain, c *client, base, name, store string) int {
	host, _ := os.Hostname()
	var code wire.DeviceCodeResponse
	err := c.call(context.Background(), "POST", wire.RouteDeviceCode, "", wire.DeviceCodeRequest{
		Name: name, HostInfo: wire.HostInfo{Hostname: host, OS: runtime.GOOS, Arch: runtime.GOARCH, CLIVersion: Version},
	}, &code)
	if err != nil {
		return fail(io, err)
	}
	fmt.Fprintf(io.Stdout, "Approve %q in Convoz. Code: %s\n", name, code.UserCode)

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
			return finishLogin(io, dir, kc, Credentials{Server: base, Machine: tok.MachineName, Key: tok.MachineKey}, store)
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
			return expired(io)
		case status == 0 || status >= 500 || status == 429:
			// The server could not be reached, or the answer got lost: ask again with the same device code.
		default:
			return fail(io, err)
		}
	}
	return expired(io)
}

func expired(io IO) int {
	fmt.Fprintln(io.Stderr, "convoz: The code expired. Run convoz login again.")
	return ExitAuth
}
