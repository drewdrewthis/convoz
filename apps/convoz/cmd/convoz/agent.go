package main

import (
	"errors"
	"fmt"
)

// agentSpec is the parsed pair of --agent-listen and --agent-host.
type agentSpec struct {
	on         bool
	listen     string
	name       string
	publicPort int
}

// parseAgent accepts both flags or neither. The listener is TCP on loopback only (like --listen): the Funnel proxy
// is local, and the server never binds a public address. The host is what agents are told, so it is required.
func parseAgent(listen, host string) (agentSpec, error) {
	if listen == "" && host == "" {
		return agentSpec{}, nil
	}
	if listen == "" || host == "" {
		return agentSpec{}, errors.New("--agent-listen and --agent-host go together")
	}
	spec, err := parseListen(listen)
	if err != nil {
		return agentSpec{}, fmt.Errorf("--agent-listen: %w", err)
	}
	if spec.unix {
		return agentSpec{}, errors.New("--agent-listen takes a loopback IP with a port, not a socket")
	}
	name, port, err := parseHost(host)
	if err != nil {
		return agentSpec{}, fmt.Errorf("--agent-host: %w", err)
	}
	return agentSpec{on: true, listen: spec.addr, name: name, publicPort: port}, nil
}
