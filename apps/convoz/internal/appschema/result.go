package appschema

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"slices"
	"unicode/utf8"
)

// Result is a checked app result: what the owner confirmed.
type Result struct {
	V       int             `json:"v"`
	Source  string          `json:"source"`
	Summary string          `json:"summary"`
	Value   json.RawMessage `json:"value"`
	raw     []byte
}

// Canonical is the compact JSON the server stores.
func (r *Result) Canonical() []byte { return r.raw }

func badResult(path, rule, msg string) *Issue {
	return &Issue{Code: CodeResultInvalid, Path: path, Rule: rule, Message: msg}
}

// CheckResult judges the result an app sent back against the app it came from (§4.4 #10). The server runs it on every via_app message.
func CheckResult(app *App, raw []byte) (*Result, *Issue) {
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return nil, badResult("", "json", "is not JSON")
	}
	if compact.Len() > MaxResultBytes {
		return nil, badResult("", "size", fmt.Sprintf("must have at most %d bytes", MaxResultBytes))
	}
	if i := check("app-result.json", CodeResultInvalid, compact.Bytes()); i != nil {
		return nil, i
	}
	r := &Result{raw: slices.Clone(compact.Bytes())}
	if err := json.Unmarshal(compact.Bytes(), r); err != nil {
		return nil, badResult("", "json", err.Error())
	}
	if r.Source != app.Type {
		return nil, badResult("/source", "source", "must be the type of the app")
	}
	var i *Issue
	switch app.Type {
	case "picker":
		i = pickerResult(app, r)
	case "checklist":
		i = checklistResult(app, r)
	case "form":
		i = formResult(app, r)
	case "frame":
		var p struct{ Manifest struct{ Results bool } }
		_ = json.Unmarshal(app.Props, &p)
		if !p.Manifest.Results {
			i = &Issue{Code: CodeResultNotAllowed, Path: "/source", Rule: "results", Message: "this app does not send results"}
		}
	}
	if i != nil {
		return nil, i
	}
	return r, nil
}

func pickerResult(app *App, r *Result) *Issue {
	var p struct {
		Options  []struct{ ID string }
		Multi    bool
		Min, Max *int
	}
	var v struct{ Selected []string }
	_ = json.Unmarshal(app.Props, &p)
	_ = json.Unmarshal(r.Value, &v)
	for k, id := range v.Selected {
		if !slices.ContainsFunc(p.Options, func(o struct{ ID string }) bool { return o.ID == id }) {
			return badResult(fmt.Sprintf("/value/selected/%d", k), "option", "is not an option of the picker")
		}
	}
	lo, hi := 1, 1
	if p.Multi {
		hi = len(p.Options)
		if p.Min != nil {
			lo = *p.Min
		}
		if p.Max != nil {
			hi = *p.Max
		}
	}
	if n := len(v.Selected); n < lo || n > hi {
		return badResult("/value/selected", "count", fmt.Sprintf("must have %d to %d choices", lo, hi))
	}
	return nil
}

func checklistResult(app *App, r *Result) *Issue {
	var p struct {
		Mode       string
		Items      []struct{ ID string }
		MinChecked int
	}
	var v struct{ Checked []string }
	_ = json.Unmarshal(app.Props, &p)
	_ = json.Unmarshal(r.Value, &v)
	if p.Mode != "select" {
		return &Issue{Code: CodeResultNotAllowed, Path: "/source", Rule: "mode", Message: "this checklist is read only"}
	}
	for k, id := range v.Checked {
		if !slices.ContainsFunc(p.Items, func(o struct{ ID string }) bool { return o.ID == id }) {
			return badResult(fmt.Sprintf("/value/checked/%d", k), "item", "is not an item of the checklist")
		}
	}
	if len(v.Checked) < p.MinChecked {
		return badResult("/value/checked", "min_checked", fmt.Sprintf("must have at least %d checks", p.MinChecked))
	}
	return nil
}

var dateRE = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)

func formResult(app *App, r *Result) *Issue {
	type field struct {
		ID, Kind  string
		Required  bool
		Options   []struct{ ID string }
		Min, Max  *float64
		MaxLength int
	}
	var p struct{ Fields []field }
	var v struct{ Fields map[string]any }
	_ = json.Unmarshal(app.Props, &p)
	_ = json.Unmarshal(r.Value, &v)
	byID := map[string]field{}
	for _, f := range p.Fields {
		byID[f.ID] = f
	}
	keys := make([]string, 0, len(v.Fields))
	for k := range v.Fields {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		if _, ok := byID[k]; !ok {
			return badResult("/value/fields/"+k, "field", "is not a field of the form")
		}
	}
	for _, f := range p.Fields {
		at := "/value/fields/" + f.ID
		val, given := v.Fields[f.ID]
		if !given || val == nil || val == "" {
			if f.Required && f.Kind != "toggle" {
				return badResult(at, "required", "is required")
			}
			continue
		}
		if i := formValue(f.Kind, val, f.Options, f.Min, f.Max, f.MaxLength, at); i != nil {
			return i
		}
	}
	return nil
}

func formValue(kind string, val any, options []struct{ ID string }, lo, hi *float64, maxLen int, at string) *Issue {
	switch kind {
	case "text", "textarea":
		s, ok := val.(string)
		limit := 2000
		if maxLen > 0 {
			limit = maxLen
		}
		if !ok || utf8.RuneCountInString(s) > limit {
			return badResult(at, "text", fmt.Sprintf("must be text of at most %d characters", limit))
		}
	case "number":
		n, ok := val.(float64)
		if !ok || math.IsNaN(n) || (lo != nil && n < *lo) || (hi != nil && n > *hi) {
			return badResult(at, "number", "must be a number within the limits of the field")
		}
	case "select":
		s, ok := val.(string)
		if !ok || !slices.ContainsFunc(options, func(o struct{ ID string }) bool { return o.ID == s }) {
			return badResult(at, "select", "must be one of the options")
		}
	case "toggle":
		if _, ok := val.(bool); !ok {
			return badResult(at, "toggle", "must be true or false")
		}
	case "date":
		if s, ok := val.(string); !ok || !dateRE.MatchString(s) {
			return badResult(at, "date", "must be a date like 2026-10-17")
		}
	}
	return nil
}

// CheckBridge judges one bridge message. direction is "fromFrame" or "toFrame".
func CheckBridge(direction string, raw []byte) *Issue {
	if len(raw) > 8192 {
		return &Issue{Code: CodeBridgeInvalid, Rule: "size", Message: "must have at most 8192 bytes"}
	}
	return check("bridge.json#/$defs/"+direction, CodeBridgeInvalid, raw)
}

// CheckManifest judges the manifest of a Tier-2 app (schemas/manifest.json).
func CheckManifest(raw []byte) *Issue {
	return check("manifest.json", CodeInvalid, raw)
}
