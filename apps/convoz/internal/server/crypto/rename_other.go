//go:build !linux

package crypto

import "syscall"

// renameNoReplace has no portable form off Linux; the caller falls back to an O_EXCL create.
func renameNoReplace(string, string) error { return syscall.ENOSYS }
