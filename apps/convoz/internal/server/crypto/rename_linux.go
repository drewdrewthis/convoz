//go:build linux

package crypto

import "golang.org/x/sys/unix"

// renameNoReplace moves oldPath to newPath and fails with EEXIST if newPath exists (renameat2 RENAME_NOREPLACE).
func renameNoReplace(oldPath, newPath string) error {
	return unix.Renameat2(unix.AT_FDCWD, oldPath, unix.AT_FDCWD, newPath, unix.RENAME_NOREPLACE)
}
