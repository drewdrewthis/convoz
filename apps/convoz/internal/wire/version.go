package wire

import "regexp"

var commitVersion = regexp.MustCompile(`^[0-9a-f]{7,40}(\+dirty)?$`)

// ShortVersion is the version a server shows to the internet: a build named by its commit is cut to 7 characters, with no "+dirty"
// mark; a release name is left as it is. The CLI compares versions in this form, so the short answer raises no stale warning.
func ShortVersion(v string) string {
	if commitVersion.MatchString(v) {
		return v[:7]
	}
	return v
}
