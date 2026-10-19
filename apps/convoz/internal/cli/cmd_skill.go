package cli

import (
	_ "embed"
	"flag"
	"fmt"
	"os"
	"path/filepath"
)

// skillText is the Agent Skills file that teaches the Convoz rules. It is embedded so the skill always matches this CLI.
//
//go:embed skill.md
var skillText string

func init() {
	Register(Command{Name: "skill", Summary: "Print or install the Convoz skill that teaches an agent the rules.", Example: "convoz skill install", Order: 96, Run: skill,
		Subs:  []string{"install"},
		Usage: "convoz skill\nconvoz skill install [--dir D] [--hooks]"})
}

// SkillText is the SKILL.md this binary ships.
func SkillText() string { return skillText }

func skill(args []string, io IO) int {
	if len(args) == 0 {
		fmt.Fprint(io.Stdout, skillText)
		return ExitOK
	}
	if args[0] != "install" {
		return usageError(io, "usage: convoz skill | convoz skill install [--dir D] [--hooks]")
	}
	fs := flag.NewFlagSet("skill install", flag.ContinueOnError)
	dir := fs.String("dir", "", "the skill folder (default ~/.claude/skills/convoz); with --hooks they go in settings.json two folders up")
	withHooks := fs.Bool("hooks", false, "also add the Claude Code hooks to settings.json (the plugin does this for you)")
	if !parseNoArgs(fs, args[1:], io) {
		return ExitUsage
	}
	if *dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return fail(io, err)
		}
		*dir = filepath.Join(home, ".claude", "skills", "convoz")
	}
	path := filepath.Join(*dir, "SKILL.md")
	_, statErr := os.Stat(path)
	if err := os.MkdirAll(*dir, 0o755); err != nil {
		return fail(io, err)
	}
	if err := os.WriteFile(path, []byte(skillText), 0o644); err != nil {
		return fail(io, err)
	}
	verb := "installed"
	if statErr == nil {
		verb = "updated"
	}
	fmt.Fprintf(io.Stdout, "%s %s\n", verb, path)
	if !*withHooks {
		return ExitOK
	}
	// The skill folder is <claude dir>/skills/convoz, so the settings file is two folders up.
	settings := filepath.Join(*dir, "..", "..", "settings.json")
	changed, err := MergeHooks(settings)
	if err != nil {
		fmt.Fprintf(io.Stderr, "convoz: skill installed, hooks not added: %s\n", err)
		return ExitOK
	}
	if changed {
		fmt.Fprintf(io.Stdout, "hooks added to %s\n", filepath.Clean(settings))
	}
	return ExitOK
}
