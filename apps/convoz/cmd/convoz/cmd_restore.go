package main

import (
	"flag"
	"fmt"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/cli"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ops"
)

const restoreUsage = "convoz restore --backup FILE --into DIR --identity F --verify-key F [--kek-file F]"

func init() {
	cli.Register(cli.Command{Name: "restore", Order: 71, Summary: "Check a backup and restore it into a new data folder.",
		Example: "convoz restore --backup convoz.backup --into /var/lib/convoz-new --identity keys/identity.key --verify-key keys/verify.key", Usage: restoreUsage, Run: runRestore})
}

// runRestore is `convoz restore`: it checks the signature first and writes the data dir only when everything opens.
func runRestore(args []string, io cli.IO) int {
	var p ops.RestoreParams
	var kekFile, into string
	_, ok := flags("restore", args, io.Stderr, func(fs *flag.FlagSet) {
		fs.StringVar(&p.Backup, "backup", "", "the backup file")
		fs.StringVar(&into, "into", "", "the new data directory")
		fs.StringVar(&p.Identity, "identity", "", "the age-style identity (private) key file")
		fs.StringVar(&p.VerifyKey, "verify-key", "", "the ed25519 verify key file")
		fs.StringVar(&kekFile, "kek-file", "", "the KEK that wrapped the backup's keyring")
	})
	if !ok || p.Backup == "" || into == "" || p.Identity == "" || p.VerifyKey == "" {
		return usageFail(io, restoreUsage)
	}
	var err error
	if p.Into, err = absDir(into); err != nil {
		return failWith(io, err)
	}
	kek, code := loadKEK(kekFile)
	if kek == nil {
		return code
	}
	p.KEK = kek
	if err := ops.Restore(p); err != nil {
		return failWith(io, fmt.Errorf("restore stopped: %w", err))
	}
	fmt.Fprintln(io.Stdout, p.Into)
	return 0
}
