package mcp

import (
	"encoding/json"
	"fmt"

	"github.com/google/jsonschema-go/jsonschema"
)

// Small builders for the JSON Schema (2020-12) of each tool's arguments. Every property carries a description, because the
// model reads it; every object refuses fields it does not know.
type props map[string]any

func object(required []string, p props) json.RawMessage {
	if required == nil {
		required = []string{}
	}
	return mustJSON(map[string]any{"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "properties": p, "required": required, "additionalProperties": false})
}

func text(desc string) props    { return props{"type": "string", "description": desc} }
func boolean(desc string) props { return props{"type": "boolean", "description": desc} }
func integer(desc string, lo, hi int) props {
	return props{"type": "integer", "minimum": lo, "maximum": hi, "description": desc}
}
func oneOf(desc string, values ...string) props {
	return props{"type": "string", "enum": values, "description": desc}
}
func list(desc string, item props, lo, hi int) props {
	return props{"type": "array", "items": item, "minItems": lo, "maxItems": hi, "description": desc}
}

func mustJSON(v any) json.RawMessage {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(fmt.Sprintf("mcp: schema does not marshal: %v", err))
	}
	return raw
}

// needsYou is the required yes-or-no field of every tool that posts. False is news; true is refused with the pointer to the ask tool.
func needsYou() props {
	return boolean("Does this need the owner? false for news or a note to an agent. true is refused: use the ask tool.")
}

// needsYouFlag is the CLI flag for the field.
func needsYouFlag(needs bool) string {
	if needs {
		return "--needs-you"
	}
	return "--fyi"
}

// conv is the argument that names a conversation.
func conv() props { return integer("The conversation id.", 1, 1<<53-1) }

// appSchema is the shape of an app (app.v1): a small card the agent puts in a message. The server checks the parts of each
// type; this schema checks what every app has.
func appSchema() props {
	return props{
		"type":                 "object",
		"description":          "An app in the app.v1 shape: a card shown with the message.",
		"required":             []string{"v", "type", "fallback", "props"},
		"additionalProperties": false,
		"properties": props{
			"v":        props{"const": 1, "description": "The app format version; always 1."},
			"type":     oneOf("The kind of app.", "chart", "table", "checklist", "kv", "picker", "form", "progress", "code", "gallery", "frame"),
			"title":    props{"type": "string", "maxLength": 80, "description": "A short title."},
			"fallback": props{"type": "string", "minLength": 1, "maxLength": 2000, "description": "Plain text that says the same, for readers that cannot show the app."},
			"height":   integer("A height hint in pixels.", 80, 600),
			"props":    props{"type": "object", "description": "The parts of the app; they depend on its type."},
		},
	}
}

// validator checks arguments against a tool's schema.
type validator struct{ rs *jsonschema.Resolved }

func newValidator(raw json.RawMessage) (validator, error) {
	var s jsonschema.Schema
	if err := json.Unmarshal(raw, &s); err != nil {
		return validator{}, err
	}
	rs, err := s.Resolve(nil)
	return validator{rs}, err
}

// check validates the JSON arguments; an empty body counts as {}.
func (v validator) check(args json.RawMessage) error {
	var instance any = map[string]any{}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &instance); err != nil {
			return fmt.Errorf("the arguments are not JSON: %w", err)
		}
	}
	return v.rs.Validate(instance)
}
