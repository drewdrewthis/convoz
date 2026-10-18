package notify

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/mail"
	"net/url"
	"strings"
)

// VAPIDClaims decodes the claims of the JWT in a "vapid t=<jwt>, k=<key>" Authorization header. It checks no signature:
// it is for the fake push services of tests, which read what a real push service would judge.
func VAPIDClaims(authorization string) (map[string]any, error) {
	rest, ok := strings.CutPrefix(authorization, "vapid ")
	if !ok {
		return nil, errors.New("not a vapid Authorization header")
	}
	var jwt string
	for _, part := range strings.Split(rest, ",") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(part), "t="); ok {
			jwt = v
		}
	}
	segs := strings.Split(jwt, ".")
	if len(segs) != 3 {
		return nil, errors.New("vapid token is not a JWT")
	}
	raw, err := base64.RawURLEncoding.DecodeString(segs[1])
	if err != nil {
		return nil, err
	}
	var claims map[string]any
	return claims, json.Unmarshal(raw, &claims)
}

// ValidVAPIDSubject applies the rule Apple's push service enforces on the "sub" claim: an https URL, or "mailto:" and exactly one
// plain address (so no second "mailto:" and no port in the domain).
func ValidVAPIDSubject(sub string) bool {
	if u, err := url.Parse(sub); err == nil && u.Scheme == "https" && u.Host != "" {
		return true
	}
	addr, ok := strings.CutPrefix(sub, "mailto:")
	if !ok {
		return false
	}
	a, err := mail.ParseAddress(addr)
	if err != nil || a.Address != addr {
		return false
	}
	domain := addr[strings.LastIndex(addr, "@")+1:]
	return !strings.Contains(domain, ":")
}
