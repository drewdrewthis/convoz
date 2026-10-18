//go:build !testhooks

package httpapi

// agentPeerTrusted is false in a release build: the agent listener knows a client only by what the Funnel proxy says.
func agentPeerTrusted() bool { return false }
