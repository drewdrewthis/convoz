package main

import (
	"flag"
	"fmt"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/cli"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/crypto"
)

const workspaceUsage = "convoz workspace destroy --data-dir D --kek-file F --yes"

func init() {
	cli.Register(cli.Command{Name: "workspace", Order: 73, Usage: workspaceUsage, Run: runWorkspace})
}

// runWorkspace is `convoz workspace destroy`: crypto-shred. It destroys the KEK file and the keyring, so the
// database and every blob become unreadable (design §14). It needs the KEK, which proves the caller holds it.
func runWorkspace(args []string, io cli.IO) int {
	if len(args) == 0 || args[0] != "destroy" {
		return usageFail(io, workspaceUsage)
	}
	var dataDir, kekFile string
	var yes bool
	_, ok := flags("workspace destroy", args[1:], io.Stderr, func(fs *flag.FlagSet) {
		fs.StringVar(&dataDir, "data-dir", "", "data directory")
		fs.StringVar(&kekFile, "kek-file", "", "KEK credential file")
		fs.BoolVar(&yes, "yes", false, "confirm: this cannot be undone")
	})
	if !ok || dataDir == "" {
		return usageFail(io, workspaceUsage)
	}
	if !yes {
		fmt.Fprintln(io.Stderr, "convoz: this destroys the KEK file and the keyring; the data can never be read again. Run it again with --yes.")
		return exitUsage
	}
	dir, err := absDir(dataDir)
	if err != nil {
		return failWith(io, err)
	}
	kekPath, err := crypto.ResolveKEKPath(kekFile, "")
	if err != nil {
		return failWith(io, err)
	}
	kek, code := loadKEK(kekFile)
	if kek == nil {
		return code
	}
	if _, err := crypto.LoadKeyring(dir, kek); err != nil {
		return failWith(io, err)
	}
	lock, err := lockDataDir(dir)
	if err != nil {
		return failWith(io, err)
	}
	defer lock.Close()
	if err := crypto.DestroyKeys(dir, kekPath); err != nil {
		return failWith(io, err)
	}
	fmt.Fprintln(io.Stdout, "destroyed the keyring and the KEK file; delete every other copy of the KEK, and the backups, to finish")
	return 0
}
