//go:build linux

package main

import (
	"net"

	"golang.org/x/sys/unix"
)

// peerCredRequired: on Linux SO_PEERCRED exists, so a connection whose peer cannot be read is refused.
const peerCredRequired = true

// peerUID reads the uid of the process on the other end of a unix connection.
func peerUID(c *net.UnixConn) (uint32, bool) {
	raw, err := c.SyscallConn()
	if err != nil {
		return 0, false
	}
	var uid uint32
	var ok bool
	_ = raw.Control(func(fd uintptr) {
		cred, err := unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
		if err == nil {
			uid, ok = cred.Uid, true
		}
	})
	return uid, ok
}
