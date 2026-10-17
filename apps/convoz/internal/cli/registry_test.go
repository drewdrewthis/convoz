package cli

import (
	"strings"
	"testing"
)

// Every client command of the binary is in the registry, and the usage lists them in order.
func TestRegistryHoldsTheClientCommands(t *testing.T) {
	for _, name := range []string{"admin", "login", "whoami", "session", "post", "read", "inbox", "ack", "watch"} {
		if _, ok := Lookup(name); !ok {
			t.Errorf("%s is not registered", name)
		}
	}
	all := strings.Join(Usages(), "\n")
	if strings.Index(all, "convoz login") > strings.Index(all, "convoz watch") {
		t.Fatal("usage lines are not in Order")
	}
}
