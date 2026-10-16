package main

import (
	"errors"
	"testing"
)

func TestSecondLockOnSameDataDirIsRefusedUntilReleased(t *testing.T) {
	dir := t.TempDir()
	first, err := lockDataDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := lockDataDir(dir); !errors.Is(err, errInUse) {
		t.Fatalf("second lock: got %v, want errInUse", err)
	}
	first.Close()
	again, err := lockDataDir(dir)
	if err != nil {
		t.Fatalf("after release: %v", err)
	}
	again.Close()
}
