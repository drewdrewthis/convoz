package platform_test

import (
	"syscall"
	"time"
)

// threadCPU is the CPU time this OS thread has used. The database runs on the calling
// goroutine, so the delta around a query is the engine's own work, without the time the
// kernel spent running other processes while this thread waited for a core.
func threadCPU() (time.Duration, bool) {
	const rusageThread = 1 // RUSAGE_THREAD
	var ru syscall.Rusage
	if syscall.Getrusage(rusageThread, &ru) != nil {
		return 0, false
	}
	return time.Duration(ru.Utime.Nano() + ru.Stime.Nano()), true
}
