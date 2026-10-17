// Package testroutes is the one list of routes the testhooks build registers.
// Only testhooks code and the release guard import it: a release binary must not
// contain these strings.
package testroutes

const (
	KV            = "/__test/kv"
	SchemaVersion = "/__test/schema-version"
	Clock         = "/__test/clock"
	Routes        = "/__test/routes"
	UserCodes     = "/__test/user-codes"
)

// All lists every test route; scripts/release_guard.py probes each one. A later module appends its own routes from an
// init function in testroutes/<module>.go, so this list is never edited by two work packages.
var All = []string{KV, SchemaVersion, Clock, Routes, UserCodes}
