package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/cli"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/crypto"
)

const keysUsage = "convoz keys rotate-kek --data-dir D --kek-file OLD --new-kek-file NEW"

func init() {
	cli.Register(cli.Command{Name: "keys", Order: 72, Usage: keysUsage, Run: runKeys})
}

// runKeys is `convoz keys rotate-kek` (design §6.2). rotate-db is a later slice.
func runKeys(args []string, io cli.IO) int {
	if len(args) == 0 || args[0] != "rotate-kek" {
		return usageFail(io, keysUsage)
	}
	var dataDir, oldFile, newFile string
	_, ok := flags("keys rotate-kek", args[1:], io.Stderr, func(fs *flag.FlagSet) {
		fs.StringVar(&dataDir, "data-dir", "", "data directory")
		fs.StringVar(&oldFile, "kek-file", "", "the current KEK file")
		fs.StringVar(&newFile, "new-kek-file", "", "the new KEK file (created when it does not exist)")
	})
	if !ok || dataDir == "" || newFile == "" {
		return usageFail(io, keysUsage)
	}
	dir, err := absDir(dataDir)
	if err != nil {
		return failWith(io, err)
	}
	oldKEK, code := loadKEK(oldFile)
	if oldKEK == nil {
		return code
	}
	lock, err := lockDataDir(dir) // a running server holds it; the keyring must not change under one
	if err != nil {
		return failWith(io, err)
	}
	defer lock.Close()
	newKEK, err := newOrExistingKEK(newFile)
	if err != nil {
		return failWith(io, err)
	}
	if err := crypto.RotateKEK(dir, oldKEK, newKEK); err != nil {
		return failWith(io, err)
	}
	fmt.Fprintf(io.Stdout, "keyring rewrapped under %s; keep %s until the last backup made with it expires (35 days)\n", newFile, oldFile)
	return 0
}

func newOrExistingKEK(path string) ([]byte, error) {
	if _, err := os.Stat(filepath.Clean(path)); errors.Is(err, os.ErrNotExist) {
		return crypto.NewKEKFile(path)
	}
	return crypto.LoadKEK(path)
}
