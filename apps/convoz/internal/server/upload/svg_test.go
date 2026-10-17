package upload

import (
	"strings"
	"testing"
)

func TestAvatarScriptsAndHandlersAreStripped(t *testing.T) {
	in := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="x()"><script>alert(1)</script><circle cx="5" cy="5" r="4" fill="red" onclick="y()" style="fill:blue"/><image href="https://evil.example/p.png"/></svg>`
	out, err := SanitizeAvatar(in)
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"script", "alert", "onload", "onclick", "style", "image", "evil.example"} {
		if strings.Contains(out, bad) {
			t.Errorf("%q left in %s", bad, out)
		}
	}
	if !strings.Contains(out, `<circle cx="5" cy="5" r="4" fill="red">`) {
		t.Errorf("the shapes were lost: %s", out)
	}
}

func TestAvatarWithADoctypeOrEntityIsRefused(t *testing.T) {
	for _, in := range []string{
		`<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>`,
		`<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg">&a;</svg>`,
		`<svg xmlns="http://www.w3.org/2000/svg"><!ENTITY a "b"></svg>`,
	} {
		if _, err := SanitizeAvatar(in); err == nil {
			t.Errorf("accepted %s", in)
		}
	}
}

func TestAvatarThatIsNotAnSVGIsRefused(t *testing.T) {
	for _, in := range []string{"", "plain text", `<html><body/></html>`, `<svg xmlns="http://www.w3.org/2000/svg"><circle></svg>`, strings.Repeat("a", MaxAvatarIn+1)} {
		if _, err := SanitizeAvatar(in); err == nil {
			t.Errorf("accepted %.40q", in)
		}
	}
}

func TestAvatarGradientReferencesStayInTheFile(t *testing.T) {
	in := `<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="9" height="9" fill="url(#g)"/><rect width="9" height="9" fill="url(https://evil.example/x)"/></svg>`
	out, err := SanitizeAvatar(in)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, `fill="url(#g)"`) || strings.Contains(out, "evil.example") {
		t.Errorf("got %s", out)
	}
}
