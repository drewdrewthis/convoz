package unfurl

import (
	"crypto/sha256"
	"errors"
	"net/url"
	"regexp"
	"strings"
)

// linkRE finds an address in a message body. The first one gets the card (the prototype's rule); a closing bracket ends it so a
// markdown link or a parenthesis does not carry the bracket into the address.
var linkRE = regexp.MustCompile(`(?i)\bhttps?://[^\s<>)\]]+`)

// ErrBlocked means the address may not be fetched: a scheme other than http or https, or a place the worker must never reach.
var ErrBlocked = errors.New("unfurl: address not allowed")

// FirstURL is the address of the first link of a body, cleaned, or false when the body has none.
func FirstURL(body string) (*url.URL, bool) {
	raw := linkRE.FindString(body)
	if raw == "" {
		return nil, false
	}
	u, err := Clean(strings.TrimRight(raw, ".,;:!?"))
	return u, err == nil
}

// Clean parses an address and removes what must never be sent or stored: a name and password in front of the host, and the
// fragment. Only http and https pass.
func Clean(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, ErrBlocked
	}
	if (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return nil, ErrBlocked
	}
	u.User, u.Fragment, u.RawFragment = nil, "", ""
	u.Host = strings.ToLower(u.Host)
	return u, nil
}

// key is the primary key of an address: the hash of its cleaned form.
func key(u *url.URL) []byte {
	sum := sha256.Sum256([]byte(u.String()))
	return sum[:]
}
