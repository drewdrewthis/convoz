// Package clidist holds the CLI binaries the server hands out at /cli, one per platform, embedded at build time from the same
// tree as the server (`make cli-dist` writes cli/; `make release` and `make testhooks` run it first). A server therefore
// serves exactly its own version of the CLI. cli/placeholder.txt alone keeps the package compiling before the first build;
// then the server has no CLI to give.
package clidist

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"sort"
	"strings"
	"sync"
)

//go:embed all:cli
var dist embed.FS

// prefix starts the name of every CLI binary: convoz-<os>-<arch>.
const prefix = "convoz-"

// File is one binary and its digest.
type File struct {
	Body []byte
	// SHA256 is the lowercase hex digest of Body.
	SHA256 string
}

type index struct {
	files map[string]File
	sums  []byte
}

// load reads and hashes the binaries once: the digests are computed here, not at build time, so SHA256SUMS cannot differ from
// the bytes served and the build needs no checksum tool (macOS lacks sha256sum).
var load = sync.OnceValue(func() index {
	ix := index{files: map[string]File{}}
	entries, _ := fs.ReadDir(dist, "cli")
	var names []string
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), prefix) {
			continue
		}
		body, err := dist.ReadFile("cli/" + e.Name())
		if err != nil {
			continue
		}
		sum := sha256.Sum256(body)
		ix.files[e.Name()] = File{Body: body, SHA256: hex.EncodeToString(sum[:])}
		names = append(names, e.Name())
	}
	sort.Strings(names)
	var sb strings.Builder
	for _, n := range names {
		fmt.Fprintf(&sb, "%s  %s\n", ix.files[n].SHA256, n) // the format of sha256sum
	}
	ix.sums = []byte(sb.String())
	return ix
})

// Lookup returns the binary called name (convoz-linux-amd64 ...).
func Lookup(name string) (File, bool) {
	f, ok := load().files[name]
	return f, ok
}

// Sums is the SHA256SUMS file: one `<sha256>  <name>` line per binary, in name order. Empty when the build carries no CLI.
func Sums() []byte { return load().sums }

// Built reports whether the binary carries the CLI binaries.
func Built() bool { return len(load().files) > 0 }
