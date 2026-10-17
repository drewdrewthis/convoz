package unfurl

import "testing"

func TestFirstURLTakesTheFirstLinkWithoutItsPunctuation(t *testing.T) {
	cases := map[string]string{
		"see https://github.com/acme/app/pull/415.":          "https://github.com/acme/app/pull/415",
		"a [b](https://example.com/x) and https://other.dev": "https://example.com/x",
		"HTTP://Example.COM/Path?q=1#top":                    "http://example.com/Path?q=1",
		"https://user:pw@example.com/a":                      "https://example.com/a",
	}
	for body, want := range cases {
		u, ok := FirstURL(body)
		if !ok || u.String() != want {
			t.Errorf("%q: got %v %v, want %s", body, u, ok, want)
		}
	}
	if _, ok := FirstURL("no link here, ftp://x.test"); ok {
		t.Error("a body without an http link has no first url")
	}
}
