package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// The embedded SKILL.md has the Agent Skills frontmatter, stays short, and names only commands this CLI has.
func TestSkillIsValidAndNamesRealCommands(t *testing.T) {
	text := SkillText()
	front, body, ok := strings.Cut(strings.TrimPrefix(text, "---\n"), "\n---\n")
	if !strings.HasPrefix(text, "---\n") || !ok {
		t.Fatal("SKILL.md has no frontmatter")
	}
	if !strings.Contains(front, "name: convoz\n") || !regexp.MustCompile(`(?m)^description: .{40,}`).MatchString(front) {
		t.Errorf("frontmatter needs name: convoz and a description:\n%s", front)
	}
	if n := strings.Count(body, "\n"); n > 70 {
		t.Errorf("body is %d lines, at most 70", n)
	}
	named := regexp.MustCompile("`convoz ([a-z]+)")
	for _, line := range strings.Split(body, "\n") {
		if strings.Contains(line, "if your CLI has it") {
			continue // convoz plan comes from another change
		}
		for _, m := range named.FindAllStringSubmatch(line, -1) {
			if _, ok := Lookup(m[1]); !ok && m[1] != "help" {
				t.Errorf("SKILL.md names convoz %s, which is not registered", m[1])
			}
		}
	}
}

// The plugin ships the same skill as the binary, and its manifests have the shapes Claude Code reads.
func TestPluginMatchesTheBinary(t *testing.T) {
	root := filepath.Join("..", "..", "..", "..")
	read := func(rel string) []byte {
		raw, err := os.ReadFile(filepath.Join(root, rel))
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	if string(read("plugins/convoz/skills/convoz/SKILL.md")) != SkillText() {
		t.Error("plugins/convoz/skills/convoz/SKILL.md differs from internal/cli/skill.md: copy one over the other")
	}
	var market struct {
		Plugins []struct{ Name, Source string }
	}
	if err := json.Unmarshal(read(".claude-plugin/marketplace.json"), &market); err != nil || len(market.Plugins) != 1 || market.Plugins[0].Name != "convoz" || market.Plugins[0].Source != "./plugins/convoz" {
		t.Errorf("marketplace.json: %v %+v", err, market)
	}
	var manifest struct{ Name string }
	if err := json.Unmarshal(read("plugins/convoz/.claude-plugin/plugin.json"), &manifest); err != nil || manifest.Name != "convoz" {
		t.Errorf("plugin.json: %v %+v", err, manifest)
	}
	// hooks.json must hold exactly the hooks `skill install --hooks` merges.
	var hooks struct {
		Hooks map[string][]struct {
			Hooks []struct {
				Command string
				Timeout int
			}
		}
	}
	if err := json.Unmarshal(read("plugins/convoz/hooks/hooks.json"), &hooks); err != nil {
		t.Fatal(err)
	}
	for event, command := range convozHooks {
		got := hooks.Hooks[event]
		if len(got) != 1 || len(got[0].Hooks) != 1 || got[0].Hooks[0].Command != command || got[0].Hooks[0].Timeout != hookTimeoutSeconds {
			t.Errorf("hooks.json %s: %+v, want %q with a %d s timeout", event, got, command, hookTimeoutSeconds)
		}
	}
}

// The skill is a stable pointer: it never carries a rule, so it never changes when the rules do. The rules live in wire.RulesText.
func TestSkillIsAPointerToConvozRules(t *testing.T) {
	_, body, _ := strings.Cut(strings.TrimPrefix(SkillText(), "---\n"), "\n---\n")
	if !strings.Contains(body, "`convoz rules`") {
		t.Errorf("the skill must tell the agent to run `convoz rules`:\n%s", body)
	}
	if n := strings.Count(body, "\n"); n > 12 {
		t.Errorf("a pointer is short: %d lines", n)
	}
	if strings.Contains(body, "one-way door") {
		t.Error("a rule is in the skill: it belongs in wire.RulesText")
	}
}

// The rules name only commands this CLI has.
func TestRulesNameRealCommands(t *testing.T) {
	named := regexp.MustCompile("`convoz ([a-z]+)")
	for _, m := range named.FindAllStringSubmatch(wire.RulesText, -1) {
		if _, ok := Lookup(m[1]); !ok && m[1] != "help" {
			t.Errorf("the rules name convoz %s, which is not registered", m[1])
		}
	}
	if strings.HasSuffix(wire.RulesText, "\n") {
		t.Error("the rules text has no trailing newline: the CLI adds one")
	}
}
