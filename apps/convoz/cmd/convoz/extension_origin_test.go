package main

import "testing"

func TestValidateExtensionOrigin(t *testing.T) {
	cases := []struct {
		in      string
		wantErr bool
	}{
		{"chrome-extension://mbdignacpmfihffcpigobpekahlmeleb", false},
		{"", false},
		{"*", true},
		{"chrome-extension://mbdignacpmfihffcpigobpekahlmeleb/", true},
		{"https://x", true},
		{"chrome-extension://ABC", true},
	}
	for _, c := range cases {
		if err := validateExtensionOrigin(c.in); (err != nil) != c.wantErr {
			t.Errorf("%q: err=%v wantErr=%v", c.in, err, c.wantErr)
		}
	}
}
