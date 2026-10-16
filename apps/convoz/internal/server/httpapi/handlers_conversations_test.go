package httpapi

import "testing"

func TestCreateSignatureIgnoresCaseAndOrderButNotTheTitleOrTheSet(t *testing.T) {
	base := createSignature("Plan", []string{"devtool", "docs"})
	if createSignature("Plan", []string{"Docs", "DEVTOOL", "docs"}) != base {
		t.Error("case, order and repeats do not change the request")
	}
	for name, sig := range map[string]string{
		"another title":    createSignature("Other", []string{"devtool", "docs"}),
		"no title":         createSignature("", []string{"devtool", "docs"}),
		"fewer agents":     createSignature("Plan", []string{"devtool"}),
		"another agent":    createSignature("Plan", []string{"devtool", "ops"}),
		"title moves over": createSignature("", []string{"Plan", "devtool", "docs"}),
	} {
		if sig == base {
			t.Errorf("%s must differ", name)
		}
	}
}
