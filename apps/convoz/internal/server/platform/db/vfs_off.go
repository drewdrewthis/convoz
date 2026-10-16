//go:build !testhooks

package db

// vfsName is the encrypting VFS in a release build: there is no switch to turn encryption off.
func vfsName() string { return "adiantum" }
