package cli

import (
	"errors"
	"runtime"

	"github.com/zalando/go-keyring"
)

// keychainService is the service name the OS keychain files the key under.
const keychainService = "convoz"

// errNoKeychain means no OS keychain answers on this machine (headless Linux, CI).
var errNoKeychain = errors.New("no OS keychain is available")

// keychain stores one secret per server. The OS implementation is the default; a test can replace it.
type keychain interface {
	Set(server, secret string) error
	Get(server string) (string, error)
}

type osKeychain struct{ getenv func(string) string }

// available says whether a keychain can answer at all. Without a session bus, Linux has no Secret
// Service to ask, and asking anyway could try to start a bus.
func (k osKeychain) available() bool {
	return runtime.GOOS != "linux" || k.getenv("DBUS_SESSION_BUS_ADDRESS") != ""
}

func (k osKeychain) Set(server, secret string) error {
	if !k.available() {
		return errNoKeychain
	}
	return keyring.Set(keychainService, server, secret)
}

func (k osKeychain) Get(server string) (string, error) {
	if !k.available() {
		return "", errNoKeychain
	}
	return keyring.Get(keychainService, server)
}
