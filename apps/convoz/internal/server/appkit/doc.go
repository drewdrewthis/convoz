// Package appkit is a server module (design §4.2). Appkit judges the apps a message carries (Tier 1 and Tier 2) and the results
// people send back through them, keeps the files an app points at, and serves a Tier-2 frame. The schemas and the checks that
// need no database are in internal/appschema, which the CLI uses too.
package appkit
