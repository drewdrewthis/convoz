package cli

import (
	"bytes"
	"regexp"
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

// Every command answers --help and -h with its usage on stdout and exit 0: the synopsis, every flag its usage names, and an example.
// A new command with no summary, example or flag help fails here.
func TestEveryCommandHasHelp(t *testing.T) {
	flagsNamed := regexp.MustCompile(`--([a-z][a-z-]*)`)
	overview := strings.Join(Overview(), "\n")
	for name, c := range commands {
		if c.Summary == "" || c.Example == "" || c.Usage == "" {
			t.Errorf("%s: Summary, Example and Usage must all be set", name)
		}
		if !strings.Contains(overview, name+" ") {
			t.Errorf("%s is missing from the overview", name)
		}
		for _, flag := range []string{"--help", "-h"} {
			var out, errOut bytes.Buffer
			code := c.Run([]string{flag}, IO{Stdin: strings.NewReader(""), Stdout: &out, Stderr: &errOut, Getenv: func(string) string { return "" }})
			got := out.String()
			if code != 0 || errOut.Len() != 0 {
				t.Errorf("%s %s: exit %d, stderr %q", name, flag, code, errOut.String())
			}
			for _, want := range []string{"convoz " + name, "Usage:", "Example:", c.Example} {
				if !strings.Contains(got, want) {
					t.Errorf("%s %s: stdout lacks %q:\n%s", name, flag, want, got)
				}
			}
			for _, m := range flagsNamed.FindAllStringSubmatch(c.Usage, -1) {
				if !strings.Contains(got, "\n  -"+m[1]) {
					t.Errorf("%s %s: flag --%s has no help line:\n%s", name, flag, m[1], got)
				}
			}
		}
	}
}

// The man page has one section for every registered command, built from the same summaries as `convoz --help`, and a line
// that starts with a dot or a quote cannot be taken for a roff request.
func TestManPageHoldsEveryCommand(t *testing.T) {
	page := ManPage()
	for name, c := range commands {
		if !strings.Contains(page, "\n.SS "+name+"\n") || !strings.Contains(page, roff(c.Summary)) {
			t.Errorf("%s is missing from the man page", name)
		}
	}
	if got := roff(`.x 'y' a\b-c`); got != `\&.x 'y' a\eb\-c` {
		t.Errorf("roff: %q", got)
	}
}
