package wire

import "testing"

func TestShortVersion(t *testing.T) {
	for in, want := range map[string]string{"fbab9b4ae66b+dirty": "fbab9b4", "fbab9b4ae66b": "fbab9b4", "dev": "dev", "v1.2.3": "v1.2.3", "": ""} {
		if got := ShortVersion(in); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
}
