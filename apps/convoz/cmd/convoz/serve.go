package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"syscall"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/crypto"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/httpapi"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/tailnet"
)

var hostRE = regexp.MustCompile(`^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$`)

// serve runs the server and returns the process exit code.
func serve(args []string) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	dataDir := fs.String("data-dir", "", "data directory")
	kekFile := fs.String("kek-file", "", "KEK credential file")
	listen := fs.String("listen", "127.0.0.1:0", "listen address: a loopback IP with a port, or unix:///path.sock (the socket behind `tailscale serve`)")
	host := fs.String("host", "", "the name clients reach this server by, NAME or NAME:PORT when `tailscale serve` listens on a non-443 HTTPS port, e.g. convoz.<tailnet>.ts.net:8473 (required)")
	adminSocket := fs.String("admin-socket", "", "unix socket for break-glass admin commands (mode 0600)")
	tailscaleBin := fs.String("tailscale-bin", "tailscale", "the tailscale command")
	tailscaleMode := fs.String("tailscale", "check", "check: read tailscale status at start and refuse if funnel is on; off: skip (development)")
	readyFile := fs.String("ready-file", "", "write {listen,admin,pid} here once listening")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		usage()
	}
	if *dataDir == "" || (*tailscaleMode != "check" && *tailscaleMode != "off") {
		usage()
	}

	// The wall comes first: a server that would be open never touches the data dir.
	spec, err := parseListen(*listen)
	switch {
	case errors.Is(err, errNotLoopback):
		return fail(exitWall, err)
	case err != nil:
		return fail(exitUsage, err)
	}
	if *host == "" {
		return fail(exitWall, errors.New("--host is required: the name clients reach this server by (convoz.<tailnet>.ts.net)"))
	}
	name, publicPort, err := parseHost(*host)
	if err != nil {
		return fail(exitUsage, err)
	}
	if *adminSocket != "" && len(*adminSocket) > maxUnixPath {
		return fail(exitUsage, errUnixPathLength)
	}

	// SQLite creates -wal and -shm with the umask, not the mode of the main file.
	syscall.Umask(0o077)
	dir, err := filepath.Abs(*dataDir) // the SQLite URI needs an absolute path
	if err != nil {
		return fail(1, err)
	}
	clock := platform.NewClock()
	kek, code := loadKEK(*kekFile)
	if kek == nil {
		return code
	}
	lock, err := lockDataDir(dir)
	if errors.Is(err, errInUse) {
		return fail(exitInUse, err)
	}
	if err != nil {
		return fail(1, err)
	}
	defer lock.Close()
	store, keys, code := openStore(dir, kek, clock)
	if store == nil {
		return code
	}
	defer store.Close()

	pub, code := bindPublic(spec)
	if pub == nil {
		return code
	}
	defer pub.Close()
	var admin net.Listener
	if *adminSocket != "" {
		if admin, err = bindAdmin(*adminSocket); err != nil {
			return fail(adminExit(err), err)
		}
		defer admin.Close()
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	if *tailscaleMode == "check" {
		if err := tailnet.CheckFunnel(ctx, *tailscaleBin, spec.target(pub)); err != nil {
			return fail(exitWall, err)
		}
	}

	cfg := httpapi.Config{Host: name, Unix: spec.unix, PublicPort: publicPort, Version: version, TailscaleBin: *tailscaleBin, TailscaleOn: *tailscaleMode == "check"}
	if !spec.unix {
		cfg.Port = pub.Addr().(*net.TCPAddr).Port
	}
	cfg.Origin = originFor(name, publicPort, cfg)
	wa, err := auth.NewRelyingParty(name, cfg.Origin)
	if err != nil {
		return fail(1, err)
	}
	logger := log.New(os.Stderr, "convoz: ", log.LstdFlags)
	servers := []*http.Server{{
		Handler:           httpapi.NewServer(store, clock, wa, keys, cfg, logger).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		MaxHeaderBytes:    1 << 16,
		ErrorLog:          logger,
	}}
	listeners := []net.Listener{pub}
	if admin != nil {
		servers = append(servers, &http.Server{
			Handler:           httpapi.NewAdminHandler(store, clock, cfg.Origin, logger),
			ReadHeaderTimeout: 10 * time.Second,
			ErrorLog:          logger,
		})
		listeners = append(listeners, admin)
	}

	if *readyFile != "" {
		if err := writeReady(*readyFile, spec, pub, *adminSocket); err != nil {
			return fail(1, err)
		}
	}
	return run(ctx, servers, listeners)
}

// adminExit maps a bindAdmin failure to its exit code: 14 when the socket cannot be secured, 2 for a usage error.
func adminExit(err error) int {
	if errors.Is(err, errUnixPathLength) {
		return exitUsage
	}
	return exitAdmin
}

// run serves every listener until the context ends or one fails, then shuts all of them down.
func run(ctx context.Context, servers []*http.Server, listeners []net.Listener) int {
	errs := make(chan error, len(servers))
	for i, s := range servers {
		go func() { errs <- s.Serve(listeners[i]) }()
	}
	code := 0
	select {
	case <-ctx.Done():
	case err := <-errs:
		if !errors.Is(err, http.ErrServerClosed) {
			code = fail(1, err)
		}
	}
	sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, s := range servers {
		_ = s.Shutdown(sctx)
	}
	return code
}

// bindPublic opens the public listener. It returns nil and the exit code on failure.
func bindPublic(spec listenSpec) (net.Listener, int) {
	if spec.unix {
		if err := checkSocketDir(spec.addr); err != nil {
			return nil, fail(exitWall, err)
		}
		ln, err := bindUnix(spec.addr)
		switch {
		case errors.Is(err, errSocketLive):
			return nil, fail(exitInUse, err)
		case errors.Is(err, errUnixPathLength):
			return nil, fail(exitUsage, err)
		case err != nil:
			return nil, fail(1, err)
		}
		return ln, 0
	}
	ln, err := net.Listen("tcp", spec.addr)
	if err != nil {
		return nil, fail(1, err)
	}
	return ln, 0
}

// target is what `tailscale serve` would proxy to: the TCP address or the socket path.
func (s listenSpec) target(ln net.Listener) string {
	if s.unix {
		return s.addr
	}
	return ln.Addr().String()
}

// originFor is the exact Origin a browser sends: https://NAME[:PORT], or plain http for a local NAME.
// publicPort is the port clients type (0 for 443); the WebAuthn RP ID stays the bare name.
func originFor(name string, publicPort int, cfg httpapi.Config) string {
	if name != "localhost" {
		if publicPort != 0 {
			return "https://" + net.JoinHostPort(name, strconv.Itoa(publicPort))
		}
		return "https://" + name
	}
	if cfg.Unix {
		return "http://localhost"
	}
	return "http://localhost:" + strconv.Itoa(cfg.Port)
}

// loadKEK reads the key-encryption key. It returns nil and the exit code on failure.
func loadKEK(kekFlag string) ([]byte, int) {
	kekPath, err := crypto.ResolveKEKPath(kekFlag, os.Getenv("CREDENTIALS_DIRECTORY"))
	if err != nil {
		return nil, fail(exitKey, err)
	}
	kek, err := crypto.LoadKEK(kekPath)
	if err != nil {
		return nil, fail(exitKey, err)
	}
	return kek, 0
}

// openStore unlocks the key hierarchy, opens the database and migrates it. It returns the box that seals the
// stored copy of machine keys. On failure it returns a nil store and the exit code.
func openStore(dataDir string, kek []byte, clock platform.Clock) (*db.Store, *auth.KeyBox, int) {
	dbPath := filepath.Join(dataDir, "convoz.db")
	ring, err := crypto.OpenKeyring(dataDir, kek, dbPath, clock.Now())
	if err != nil {
		return nil, nil, fail(exitKey, err)
	}
	dek, ok := ring.DEK(crypto.PurposeDB)
	if !ok {
		return nil, nil, fail(exitKey, errors.New("keyring has no database key"))
	}
	machineDEK, ok := ring.DEK(crypto.PurposeMachineKey)
	if !ok {
		return nil, nil, fail(exitKey, errors.New("keyring has no machine key key"))
	}
	keys, err := auth.NewKeyBox(machineDEK)
	if err != nil {
		return nil, nil, fail(exitKey, err)
	}
	store, err := db.Open(dbPath, dek)
	if errors.Is(err, db.ErrWrongKey) {
		return nil, nil, fail(exitKey, err)
	}
	if err != nil {
		return nil, nil, fail(1, err)
	}
	err = platform.Migrate(context.Background(), store, platform.MigrateOptions{DataDir: dataDir, Clock: clock, MaxVersion: platform.MaxMigrationCap()})
	var newer *platform.NewerSchemaError
	switch {
	case errors.As(err, &newer):
		store.Close()
		return nil, nil, fail(exitSchema, err)
	case err != nil:
		store.Close()
		return nil, nil, fail(1, err)
	}
	return store, keys, 0
}

// writeReady publishes the addresses atomically so a watcher never reads half a file.
func writeReady(path string, spec listenSpec, pub net.Listener, adminPath string) error {
	listen := "tcp://" + pub.Addr().String()
	if spec.unix {
		listen = "unix://" + spec.addr
	}
	doc := map[string]any{"listen": listen, "pid": os.Getpid()}
	if adminPath != "" {
		doc["admin"] = "unix://" + adminPath
	}
	raw, _ := json.Marshal(doc)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func fail(code int, err error) int {
	fmt.Fprintf(os.Stderr, "convoz: %s\n", err)
	return code
}
