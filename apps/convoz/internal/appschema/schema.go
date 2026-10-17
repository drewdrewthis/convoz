// Package appschema checks apps (app.v1), their results (app-result.v1) and bridge messages against the JSON Schema files of
// schemas/, and applies the semantic checks the schemas cannot say (docs/messages-apps-spec.md §4.4). The server and the CLI
// both use it, so they agree on every app. It has no database and no clock.
package appschema

import (
	"embed"
	"fmt"
	"io/fs"
	"slices"
	"sort"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/santhosh-tekuri/jsonschema/v6/kind"
)

// The schema files are a copy of the repository's schemas/ folder: go:embed cannot reach outside the module. A test compares the
// two folders, so a copy that drifted fails.
//
//go:embed schemas
var files embed.FS

const base = "https://schemas.convoz.dev/v1/"

// Codes of a failed check.
const (
	CodeInvalid       = "app_invalid"
	CodeSemantic      = "app_semantic"
	CodeTooLarge      = "app_too_large"
	CodeResultInvalid = "app_result_invalid"
	CodeBridgeInvalid = "bridge_invalid"
)

// Issue is the first thing wrong: a code, the JSON pointer of the place, the keyword that failed and what is wrong in words.
// It never repeats a submitted value.
type Issue struct {
	Code, Path, Rule, Message string
}

func (i *Issue) Error() string { return i.Path + ": " + i.Message }

var (
	once     sync.Once
	compiler *jsonschema.Compiler
	loadErr  error
	compiled sync.Map // schema reference -> *jsonschema.Schema
)

func load() {
	compiler = jsonschema.NewCompiler()
	loadErr = fs.WalkDir(files, "schemas", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		raw, err := files.ReadFile(p)
		if err != nil {
			return err
		}
		doc, err := jsonschema.UnmarshalJSON(strings.NewReader(string(raw)))
		if err != nil {
			return fmt.Errorf("%s: %w", p, err)
		}
		return compiler.AddResource(base+strings.TrimPrefix(p, "schemas/"), doc)
	})
}

func schemaOf(ref string) (*jsonschema.Schema, error) {
	once.Do(load)
	if loadErr != nil {
		return nil, loadErr
	}
	if s, ok := compiled.Load(ref); ok {
		return s.(*jsonschema.Schema), nil
	}
	s, err := compiler.Compile(base + ref)
	if err != nil {
		return nil, err
	}
	compiled.Store(ref, s)
	return s, nil
}

// check validates JSON text against the schema at ref ("app.json", "bridge.json#/$defs/fromFrame") and returns the first issue.
func check(ref, code string, raw []byte) *Issue {
	s, err := schemaOf(ref)
	if err != nil {
		return &Issue{Code: "internal", Rule: "schema", Message: err.Error()}
	}
	inst, err := jsonschema.UnmarshalJSON(strings.NewReader(string(raw)))
	if err != nil {
		return &Issue{Code: code, Path: "", Rule: "json", Message: "is not JSON"}
	}
	ve, ok := s.Validate(inst).(*jsonschema.ValidationError)
	if !ok {
		return nil
	}
	return firstIssue(ve, code)
}

// firstIssue picks one leaf of the error tree, the same one every time: the leaf with the shortest instance path, then the
// alphabetically first path. A failed anyOf, oneOf or not is one issue at its own place.
func firstIssue(ve *jsonschema.ValidationError, code string) *Issue {
	var leaves []*Issue
	var walk func(e *jsonschema.ValidationError)
	walk = func(e *jsonschema.ValidationError) {
		switch e.ErrorKind.(type) {
		case *kind.AnyOf, *kind.OneOf, *kind.Not, *kind.PropertyNames:
			leaves = append(leaves, describe(e, code))
			return
		}
		if len(e.Causes) == 0 {
			leaves = append(leaves, describe(e, code))
			return
		}
		for _, c := range e.Causes {
			walk(c)
		}
	}
	walk(ve)
	sort.SliceStable(leaves, func(a, b int) bool {
		if len(leaves[a].Path) != len(leaves[b].Path) {
			return len(leaves[a].Path) < len(leaves[b].Path)
		}
		return leaves[a].Path < leaves[b].Path
	})
	return leaves[0]
}

func pointer(loc []string) string {
	var b strings.Builder
	for _, s := range loc {
		b.WriteByte('/')
		b.WriteString(strings.NewReplacer("~", "~0", "/", "~1").Replace(s))
	}
	return b.String()
}

func describe(e *jsonschema.ValidationError, code string) *Issue {
	path := pointer(e.InstanceLocation)
	rule := strings.Join(e.ErrorKind.KeywordPath(), "/")
	at := func(key string) string { return path + "/" + strings.NewReplacer("~", "~0", "/", "~1").Replace(key) }
	i := &Issue{Code: code, Path: path, Rule: rule}
	switch k := e.ErrorKind.(type) {
	case *kind.Required:
		missing := slices.Clone(k.Missing)
		sort.Strings(missing)
		i.Path, i.Message = at(missing[0]), "is required"
	case *kind.AdditionalProperties:
		extra := slices.Clone(k.Properties)
		sort.Strings(extra)
		i.Path, i.Message = at(extra[0]), "unknown key"
	case *kind.FalseSchema:
		i.Message = "is not allowed here"
	case *kind.Type:
		i.Message = "must be " + article(strings.Join(k.Want, " or "))
	case *kind.Enum:
		i.Message = "must be one of: " + listOf(k.Want)
	case *kind.Const:
		i.Message = "must be " + fmt.Sprint(k.Want)
	case *kind.MinItems:
		i.Message = fmt.Sprintf("must have at least %d %s", k.Want, plural(k.Want, "item"))
	case *kind.MaxItems:
		i.Message = fmt.Sprintf("must have at most %d %s", k.Want, plural(k.Want, "item"))
	case *kind.MaxProperties:
		i.Message = fmt.Sprintf("must have at most %d %s", k.Want, plural(k.Want, "key"))
	case *kind.MinLength:
		i.Message = fmt.Sprintf("must have at least %d %s", k.Want, plural(k.Want, "character"))
	case *kind.MaxLength:
		i.Message = fmt.Sprintf("must have at most %d %s", k.Want, plural(k.Want, "character"))
	case *kind.DependentRequired:
		missing := slices.Clone(k.Missing)
		sort.Strings(missing)
		i.Path, i.Message = at(missing[0]), "is required with "+k.Prop
	case *kind.Not:
		i.Message = "these keys cannot be used together"
	case *kind.Pattern:
		i.Message = "has the wrong format"
	case *kind.Minimum:
		i.Message = "must be at least " + k.Want.RatString()
	case *kind.Maximum:
		i.Message = "must be at most " + k.Want.RatString()
	case *kind.ExclusiveMinimum:
		i.Message = "must be more than " + k.Want.RatString()
	case *kind.UniqueItems:
		i.Message = "items must be different"
	case *kind.PropertyNames:
		i.Path, i.Message = at(k.Property), "key has the wrong format"
	case *kind.AnyOf, *kind.OneOf:
		i.Message = "does not match any allowed shape"
	default:
		i.Message = "is not valid"
	}
	return i
}

func plural(n int, word string) string {
	if n == 1 {
		return word
	}
	return word + "s"
}

func article(t string) string {
	if t == "" {
		return "valid"
	}
	if strings.ContainsRune("aeiou", rune(t[0])) {
		return "an " + t
	}
	return "a " + t
}

func listOf(vs []any) string {
	out := make([]string, len(vs))
	for i, v := range vs {
		out[i] = fmt.Sprint(v)
	}
	return strings.Join(out, ", ")
}
