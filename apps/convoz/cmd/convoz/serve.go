package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/crypto"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/httpapi"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform"
)

// serve runs the server and returns the process exit code.
func serve(args []string) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	dataDir := fs.String("data-dir", "", "data directory")
	kekFile := fs.String("kek-file", "", "KEK credential file")
	listen := fs.String("listen", "127.0.0.1:0", "listen address")
	readyFile := fs.String("ready-file", "", "write {listen,pid} here once listening")
	if err := fs.Parse(args); err != nil || *dataDir == "" {
		usage()
	}

	db, code := openStore(*dataDir, *kekFile)
	if db == nil {
		return code
	}
	defer db.Close()

	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		return fail(1, err)
	}
	srv := &http.Server{Handler: httpapi.NewMux(db), ReadHeaderTimeout: 10 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()

	if *readyFile != "" {
		if err := writeReady(*readyFile, ln.Addr().String()); err != nil {
			return fail(1, err)
		}
	}
	if err := srv.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
		return fail(1, err)
	}
	return 0
}

// openStore unlocks the key hierarchy, opens the database and migrates it.
// It returns a nil DB and the exit code on failure.
func openStore(dataDir, kekFlag string) (*platform.DB, int) {
	kekPath, err := crypto.ResolveKEKPath(kekFlag, os.Getenv("CREDENTIALS_DIRECTORY"))
	if err != nil {
		return nil, fail(exitKey, err)
	}
	kek, err := crypto.LoadKEK(kekPath)
	if err != nil {
		return nil, fail(exitKey, err)
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fail(1, err)
	}
	ring, err := crypto.OpenKeyring(dataDir, kek)
	if err != nil {
		return nil, fail(exitKey, err)
	}
	dek, _ := ring.DEK(crypto.PurposeDB)
	db, err := platform.Open(filepath.Join(dataDir, "convoz.db"), dek)
	if err != nil {
		return nil, fail(1, err)
	}
	err = db.Migrate(platform.MigrateOptions{DataDir: dataDir, Clock: platform.SystemClock{}, MaxVersion: httpapi.TestMaxMigration()})
	var newer *platform.NewerSchemaError
	switch {
	case errors.As(err, &newer):
		db.Close()
		return nil, fail(exitSchema, err)
	case err != nil:
		db.Close()
		return nil, fail(1, err)
	}
	return db, 0
}

// writeReady publishes the address atomically so a watcher never reads half a file.
func writeReady(path, addr string) error {
	doc, _ := json.Marshal(map[string]any{"listen": "tcp://" + addr, "pid": os.Getpid()})
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, doc, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func fail(code int, err error) int {
	fmt.Fprintf(os.Stderr, "convoz: %s\n", trimPrefix(err))
	return code
}

// trimPrefix drops the internal "key: " marker so messages read as one sentence.
func trimPrefix(err error) string {
	msg := err.Error()
	if errors.Is(err, crypto.ErrKey) {
		msg = msg[len(crypto.ErrKey.Error())+2:]
	}
	return msg
}
