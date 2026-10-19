package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// convozHooks are the Claude Code hooks `convoz skill install` adds: event name to command. "|| true" keeps the exit code 0
// even when convoz is missing, so a hook can never block Claude Code.
var convozHooks = map[string]string{
	"Notification":     "convoz hook notify || true",
	"UserPromptSubmit": "convoz hook resume || true",
}

const hookTimeoutSeconds = 3

// MergeHooks adds the convoz hooks to the Claude Code settings file at path and keeps everything else. A missing file is made; a
// file that is not a JSON object is left alone and reported. Running it twice adds nothing. It reports whether it changed the file.
func MergeHooks(path string) (bool, error) {
	settings := map[string]any{}
	raw, err := os.ReadFile(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return false, err
	case json.Unmarshal(raw, &settings) != nil || settings == nil:
		return false, fmt.Errorf("%s is not a JSON object; add the hooks by hand or fix the file", path)
	}
	hooks, _ := settings["hooks"].(map[string]any)
	if hooks == nil {
		if _, taken := settings["hooks"]; taken {
			return false, fmt.Errorf("%s: \"hooks\" is not an object", path)
		}
		hooks = map[string]any{}
	}
	changed := false
	for event, command := range convozHooks {
		list, _ := hooks[event].([]any)
		if hasCommand(list, command) {
			continue
		}
		hooks[event] = append(list, map[string]any{"hooks": []any{map[string]any{"type": "command", "command": command, "timeout": hookTimeoutSeconds}}})
		changed = true
	}
	if !changed {
		return false, nil
	}
	settings["hooks"] = hooks
	out, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return false, err
	}
	return true, writeAtomic(path, append(out, '\n'))
}

func hasCommand(list []any, command string) bool {
	for _, entry := range list {
		group, _ := entry.(map[string]any)
		inner, _ := group["hooks"].([]any)
		for _, h := range inner {
			if m, _ := h.(map[string]any); m != nil && strings.TrimSpace(fmt.Sprint(m["command"])) == command {
				return true
			}
		}
	}
	return false
}

// writeAtomic writes next to path and renames, so a reader never sees half a file.
func writeAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	mode := os.FileMode(0o600)
	if st, err := os.Stat(path); err == nil {
		mode = st.Mode().Perm()
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".settings-*.tmp")
	if err != nil {
		return err
	}
	_, werr := tmp.Write(data)
	cerr := tmp.Close()
	if err := errors.Join(werr, cerr, os.Chmod(tmp.Name(), mode)); err != nil {
		_ = os.Rename(tmp.Name(), tmp.Name()+".failed")
		return err
	}
	return os.Rename(tmp.Name(), path)
}
