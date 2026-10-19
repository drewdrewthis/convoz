package main

import (
	"context"
	"flag"
	"fmt"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/cli"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ops"
)

const backupUsage = "convoz backup --data-dir D --recipient F --sign-key F --out FILE [--kek-file F]\n       convoz backup keygen --dir D"

func init() {
	cli.Register(cli.Command{Name: "backup", Order: 70, Summary: "Make an encrypted, signed backup of the data folder.",
		Example: "convoz backup --data-dir /var/lib/convoz --recipient keys/recipient.key --sign-key keys/signing.key --out convoz.backup", Usage: backupUsage, Run: runBackup})
}

// runBackup is `convoz backup`: a signed, encrypted backup of a data dir. It may run beside a live server.
func runBackup(args []string, io cli.IO) int {
	if len(args) > 0 && args[0] == "keygen" {
		return runKeygen(args[1:], io)
	}
	var dataDir, kekFile, recipient, signKey, out string
	_, ok := flags("backup", args, io.Stderr, func(fs *flag.FlagSet) {
		fs.StringVar(&dataDir, "data-dir", "", "data directory")
		fs.StringVar(&kekFile, "kek-file", "", "KEK credential file")
		fs.StringVar(&recipient, "recipient", "", "the age-style recipient (public) key file")
		fs.StringVar(&signKey, "sign-key", "", "the ed25519 signing key file")
		fs.StringVar(&out, "out", "", "the backup file to create")
	})
	if !ok || dataDir == "" || recipient == "" || signKey == "" || out == "" {
		return usageFail(io, backupUsage)
	}
	dir, err := absDir(dataDir)
	if err != nil {
		return failWith(io, err)
	}
	kek, code := loadKEK(kekFile)
	if kek == nil {
		return code
	}
	err = ops.Backup(context.Background(), ops.BackupParams{DataDir: dir, KEK: kek, Recipient: recipient, SigningKey: signKey, Out: out})
	if err != nil {
		return failWith(io, fmt.Errorf("backup failed: %w", err))
	}
	fmt.Fprintln(io.Stdout, out)
	return 0
}

// runKeygen is `convoz backup keygen`: the recipient, identity, signing and verify keys of the backup (design §6.2).
func runKeygen(args []string, io cli.IO) int {
	var dir string
	_, ok := flags("backup keygen", args, io.Stderr, func(fs *flag.FlagSet) { fs.StringVar(&dir, "dir", "", "directory for the four key files") })
	if !ok || dir == "" {
		return usageFail(io, backupUsage)
	}
	if err := ops.GenerateBackupKeys(dir); err != nil {
		return failWith(io, err)
	}
	fmt.Fprintf(io.Stdout, "%s %s %s %s\n", ops.RecipientFile, ops.SigningFile, ops.IdentityFile, ops.VerifyFile)
	return 0
}
