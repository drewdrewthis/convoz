package appschema

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The repository's schemas/ folder is the source; the embedded copy must be the same bytes.
func TestEmbeddedSchemasAreTheRepositoryFiles(t *testing.T) {
	root := filepath.Join("..", "..", "..", "..", "schemas")
	for _, name := range []string{"app.json", "app-result.json", "bridge.json", "common.json", "manifest.json", "system.json"} {
		want, err := os.ReadFile(filepath.Join(root, name))
		if err != nil {
			t.Fatal(err)
		}
		got, _ := files.ReadFile("schemas/" + name)
		if string(got) != string(want) {
			t.Errorf("schemas/%s differs from the repository copy", name)
		}
	}
	entries, _ := os.ReadDir(filepath.Join(root, "components"))
	for _, e := range entries {
		want, _ := os.ReadFile(filepath.Join(root, "components", e.Name()))
		got, _ := files.ReadFile("schemas/components/" + e.Name())
		if string(got) != string(want) {
			t.Errorf("schemas/components/%s differs from the repository copy", e.Name())
		}
	}
}

type example struct {
	Name, Schema, Ref string
	Data              json.RawMessage
	Expect            *struct{ Code, Path string }
}

func examples(t *testing.T, kind string) []example {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "schemas", "examples", kind+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var list []example
	if err := json.Unmarshal(raw, &list); err != nil {
		t.Fatal(err)
	}
	return list
}

func refOf(e example) string {
	if e.Ref != "" {
		return e.Ref
	}
	return e.Schema
}

func TestEveryValidFixtureIsAccepted(t *testing.T) {
	for _, e := range examples(t, "valid") {
		if i := check(refOf(e), "x", e.Data); i != nil {
			t.Errorf("%s: %v", e.Name, i)
		}
		if e.Schema == "app.json" {
			if _, i := Check(e.Data); i != nil {
				t.Errorf("%s: Check: %v", e.Name, i)
			}
		}
	}
}

func TestEveryInvalidFixtureIsRefusedWithItsCodeAndPath(t *testing.T) {
	for _, e := range examples(t, "invalid") {
		i := check(refOf(e), "x", e.Data)
		if i == nil {
			t.Errorf("%s: accepted", e.Name)
			continue
		}
		if e.Schema != "app.json" {
			continue
		}
		_, got := Check(e.Data)
		if got == nil || e.Expect == nil || got.Code != e.Expect.Code || got.Path != e.Expect.Path {
			t.Errorf("%s: got %v, expected %+v", e.Name, got, e.Expect)
		}
	}
}
