package mcp

import (
	"encoding/json"
	"strings"
	"testing"
)

var wantTools = []string{"whoami", "brief", "inbox", "claim", "ack", "read", "search", "post", "reply", "ask", "status", "handoff", "profile", "app_validate", "app_build"}

func TestTools_AreTheFifteenInTheirOrder(t *testing.T) {
	var got []string
	for _, tool := range Tools() {
		got = append(got, tool.Name)
	}
	if strings.Join(got, ",") != strings.Join(wantTools, ",") {
		t.Fatalf("tools = %v", got)
	}
}

func TestTools_EachHasOneLinePurposeAndAValidSchema(t *testing.T) {
	for _, tool := range Tools() {
		if tool.Description == "" || strings.Contains(tool.Description, "\n") {
			t.Errorf("%s: the purpose must be one line", tool.Name)
		}
		v, err := newValidator(tool.InputSchema)
		if err != nil {
			t.Fatalf("%s: schema: %v", tool.Name, err)
		}
		if err := v.check(json.RawMessage(`{"notAnArgument":1}`)); err == nil {
			t.Errorf("%s: an unknown argument must be refused", tool.Name)
		}
	}
}

func TestPost_SchemaTakesAnAppInTheV1Shape(t *testing.T) {
	post, _ := Lookup("post")
	v, err := newValidator(post.InputSchema)
	if err != nil {
		t.Fatal(err)
	}
	ok := `{"conversation":41,"text":"hi","app":{"v":1,"type":"code","fallback":"x","props":{}}}`
	if err := v.check(json.RawMessage(ok)); err != nil {
		t.Fatalf("a whole app: %v", err)
	}
	for name, bad := range map[string]string{
		"version": `{"conversation":41,"text":"hi","app":{"v":2,"type":"code","fallback":"x","props":{}}}`,
		"type":    `{"conversation":41,"text":"hi","app":{"v":1,"type":"video","fallback":"x","props":{}}}`,
		"missing": `{"conversation":41,"text":"hi","app":{"v":1,"type":"code","props":{}}}`,
		"no text": `{"conversation":41}`,
	} {
		if err := v.check(json.RawMessage(bad)); err == nil {
			t.Errorf("%s: must be refused", name)
		}
	}
}
