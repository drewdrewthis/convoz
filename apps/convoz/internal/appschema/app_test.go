package appschema

import (
	"strings"
	"testing"
)

const picker = `{"v":1,"type":"picker","fallback":"Pick","props":{"options":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}}`

func TestCheckRefusesWhatTheSchemaAndTheSemanticChecksRefuse(t *testing.T) {
	cases := []struct{ name, app, code, path string }{
		{"duplicate key", `{"v":1,"v":1,"type":"kv","fallback":"x","props":{"pairs":[{"k":"a","v":"b"}]}}`, CodeInvalid, "/v"},
		{"chart lengths", `{"v":1,"type":"chart","fallback":"x","props":{"kind":"bar","x":{"labels":["a","b"]},"series":[{"name":"s","values":[1]}]}}`, CodeSemantic, "/props/series/0/values"},
		{"table width", `{"v":1,"type":"table","fallback":"x","props":{"columns":[{"label":"a"},{"label":"b"}],"rows":[["1"]]}}`, CodeSemantic, "/props/rows/0"},
		{"picker ids", `{"v":1,"type":"picker","fallback":"x","props":{"options":[{"id":"a","label":"A"},{"id":"a","label":"B"}]}}`, CodeSemantic, "/props/options/1/id"},
		{"progress", `{"v":1,"type":"progress","fallback":"x","props":{"done":3,"total":2}}`, CodeSemantic, "/props/done"},
	}
	for _, c := range cases {
		_, issue := Check([]byte(c.app))
		if issue == nil || issue.Code != c.code || issue.Path != c.path {
			t.Errorf("%s: got %v, want %s %s", c.name, issue, c.code, c.path)
		}
	}
}

func TestCheckSizeIsMeasuredOnTheCompactJSON(t *testing.T) {
	pad := func(n int) string {
		return `{"v":1,"type":"code","fallback":"x","props":{"mode":"code","text":"` + strings.Repeat("a", n) + `"}}`
	}
	base := len(pad(0))
	// the text of a code app tops out at 49152 characters, so the size limit is reached with a table; here only the guard is checked
	if _, issue := Check([]byte(pad(49152))); issue != nil {
		t.Fatalf("a code app at the cap was refused: %v", issue)
	}
	if _, issue := Check([]byte(strings.Repeat(" ", MaxAppBytes) + pad(1))); issue != nil {
		t.Fatalf("white space counts for nothing, got %v", issue)
	}
	if _, issue := Check([]byte(`{"v":1,"type":"kv","fallback":"x","props":{"pairs":[` + strings.Repeat(`{"k":"a","v":"b"},`, MaxAppBytes/18+1) + `{"k":"a","v":"b"}]}}`)); issue == nil || issue.Code != CodeTooLarge {
		t.Fatalf("an app over the cap must be app_too_large, got %v (base %d)", issue, base)
	}
}

func TestOnAskRefusesWhatActs(t *testing.T) {
	a, issue := Check([]byte(picker))
	if issue != nil {
		t.Fatal(issue)
	}
	if got := a.OnAsk(); got == nil || got.Code != CodeNotAllowedOnAsk {
		t.Fatalf("a picker on an ask: %v", got)
	}
	chart, _ := Check([]byte(`{"v":1,"type":"kv","fallback":"x","props":{"pairs":[{"k":"a","v":"b"}]}}`))
	if chart.OnAsk() != nil {
		t.Fatal("a kv helps decide and may sit on an ask")
	}
}

func TestCheckResultJudgesTheResultAgainstItsApp(t *testing.T) {
	a, _ := Check([]byte(picker))
	ok := `{"v":1,"source":"picker","summary":"Picked a","value":{"selected":["a"]}}`
	if _, issue := CheckResult(a, []byte(ok)); issue != nil {
		t.Fatalf("a good result: %v", issue)
	}
	for name, raw := range map[string]string{
		"not an option": `{"v":1,"source":"picker","summary":"x","value":{"selected":["mocha"]}}`,
		"two for one":   `{"v":1,"source":"picker","summary":"x","value":{"selected":["a","b"]}}`,
		"wrong source":  `{"v":1,"source":"form","summary":"x","value":{"fields":{}}}`,
	} {
		if _, issue := CheckResult(a, []byte(raw)); issue == nil || issue.Code != CodeResultInvalid {
			t.Errorf("%s: got %v", name, issue)
		}
	}
}

func TestBridgeRefusesWhatTheFrameMayNotSay(t *testing.T) {
	if issue := CheckBridge("fromFrame", []byte(`{"t":"navigate","v":1,"url":"https://example.com"}`)); issue == nil {
		t.Fatal("an unknown message must be refused")
	}
	if issue := CheckBridge("fromFrame", []byte(`{"t":"ready","v":1,"kit":"1.0.0"}`)); issue != nil {
		t.Fatalf("ready: %v", issue)
	}
}
