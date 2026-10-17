//go:build !linux

package platform_test

import "time"

// threadCPU has no per-thread clock here, so the benchmark falls back to wall-clock time.
func threadCPU() (time.Duration, bool) { return 0, false }
