//go:build !linux

package main

import "net"

// peerCredRequired is false here: there is no SO_PEERCRED to read.
const peerCredRequired = false

// peerUID is unknown off Linux; the 0600 socket and the owner-only parent directory are the gate there.
func peerUID(*net.UnixConn) (uint32, bool) { return 0, false }
