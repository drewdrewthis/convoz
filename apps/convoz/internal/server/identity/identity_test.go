package identity

import "testing"

func TestValidDisplayNameRejectsFormatCharacters(t *testing.T) {
	cases := map[string]bool{
		"Dev Tool":      true,
		"Café":          true,
		"":              false,
		"   ":           false,
		"Dev‮Tool":      false, // right-to-left override
		"Dev​Tool":      false, // zero-width space
		"Dev⁦Tool":      false, // isolate
		"Dev\u0007Tool": false, // control
	}
	for name, want := range cases {
		if got := ValidDisplayName(name); got != want {
			t.Errorf("ValidDisplayName(%q) = %v, want %v", name, got, want)
		}
	}
}
