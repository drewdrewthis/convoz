//go:build testhooks

package db

import "os"

// vfsName is the encrypting VFS, unless the test build is switched on and asks for a plain file. The e2e
// scenarios scan the data file for credentials, and a scan of ciphertext would pass for the wrong reason.
func vfsName() string {
	if os.Getenv("CONVOZ_TEST_ADMIN") == "1" && os.Getenv("CONVOZ_TEST_PLAINTEXT") == "1" {
		return "" // SQLite default file VFS
	}
	return "adiantum"
}
