package appschema

import (
	"encoding/json"
	"fmt"
	"strings"
)

func bad(path, rule, msg string) *Issue {
	return &Issue{Code: CodeSemantic, Path: path, Rule: rule, Message: msg}
}

// semantic applies the checks of docs/messages-apps-spec.md §4.4 (1 to 7) that a schema cannot say.
func semantic(a *App) *Issue {
	switch a.Type {
	case "chart":
		return chartCheck(a.Props)
	case "table":
		return tableCheck(a.Props)
	case "checklist":
		return checklistCheck(a.Props)
	case "picker":
		return pickerCheck(a.Props)
	case "form":
		return formCheck(a.Props)
	case "progress":
		var p struct{ Done, Total *int }
		_ = json.Unmarshal(a.Props, &p)
		if p.Done != nil && p.Total != nil && *p.Done > *p.Total {
			return bad("/props/done", "done_over_total", "must not be more than total")
		}
	case "code":
		var p struct{ Text string }
		_ = json.Unmarshal(a.Props, &p)
		if strings.Count(p.Text, "\n")+1 > 2000 {
			return bad("/props/text", "too_many_lines", "must have at most 2000 lines")
		}
	case "frame":
		var p struct{ Data json.RawMessage }
		_ = json.Unmarshal(a.Props, &p)
		if len(p.Data) > MaxFrameData {
			return &Issue{Code: CodeTooLarge, Path: "/props/data", Rule: "size", Message: fmt.Sprintf("must have at most %d bytes", MaxFrameData)}
		}
	}
	return nil
}

func chartCheck(props json.RawMessage) *Issue {
	var p struct {
		X      *struct{ Labels []string }
		Y      *struct{ Min, Max *float64 }
		Series []struct{ Values []any }
	}
	_ = json.Unmarshal(props, &p)
	if p.X != nil {
		for i, s := range p.Series {
			if len(s.Values) != len(p.X.Labels) {
				return bad(fmt.Sprintf("/props/series/%d/values", i), "lengths_mismatch", "must have as many values as x has labels")
			}
		}
	}
	if p.Y != nil && p.Y.Min != nil && p.Y.Max != nil && *p.Y.Min >= *p.Y.Max {
		return bad("/props/y/max", "range", "must be more than min")
	}
	return nil
}

func tableCheck(props json.RawMessage) *Issue {
	var p struct {
		Columns      []any
		Rows         [][]any
		HighlightRow *int
	}
	_ = json.Unmarshal(props, &p)
	for i, r := range p.Rows {
		if len(r) != len(p.Columns) {
			return bad(fmt.Sprintf("/props/rows/%d", i), "row_width", "must have one cell per column")
		}
	}
	if p.HighlightRow != nil && *p.HighlightRow >= len(p.Rows) {
		return bad("/props/highlightRow", "highlight_row", "must be a row of the table")
	}
	return nil
}

// duplicateID finds the first id used twice in a list; at(i) is the pointer of item i.
func duplicateID(ids []string, at func(int) string) *Issue {
	seen := map[string]bool{}
	for i, id := range ids {
		if seen[id] {
			return bad(at(i), "duplicate_id", "id is used twice")
		}
		seen[id] = true
	}
	return nil
}

func checklistCheck(props json.RawMessage) *Issue {
	var p struct {
		Items      []struct{ ID string }
		MinChecked *int
	}
	_ = json.Unmarshal(props, &p)
	ids := make([]string, len(p.Items))
	for i, it := range p.Items {
		ids[i] = it.ID
	}
	if i := duplicateID(ids, func(i int) string { return fmt.Sprintf("/props/items/%d/id", i) }); i != nil {
		return i
	}
	if p.MinChecked != nil && *p.MinChecked > len(p.Items) {
		return bad("/props/minChecked", "min_checked", "must not be more than the number of items")
	}
	return nil
}

func pickerCheck(props json.RawMessage) *Issue {
	var p struct {
		Options  []struct{ ID string }
		Min, Max *int
	}
	_ = json.Unmarshal(props, &p)
	ids := make([]string, len(p.Options))
	for i, o := range p.Options {
		ids[i] = o.ID
	}
	if i := duplicateID(ids, func(i int) string { return fmt.Sprintf("/props/options/%d/id", i) }); i != nil {
		return i
	}
	lo, hi := 1, len(p.Options)
	if p.Min != nil {
		lo = *p.Min
	}
	if p.Max != nil {
		hi = *p.Max
	}
	switch {
	case p.Max != nil && *p.Max > len(p.Options):
		return bad("/props/max", "max_options", "must not be more than the number of options")
	case lo > hi:
		return bad("/props/max", "min_max", "must not be less than min")
	}
	return nil
}

func formCheck(props json.RawMessage) *Issue {
	var p struct {
		Fields []struct {
			ID, Kind string
			Default  any
			Options  []struct{ ID string }
			Min, Max *float64
		}
	}
	_ = json.Unmarshal(props, &p)
	ids := make([]string, len(p.Fields))
	for i, f := range p.Fields {
		ids[i] = f.ID
	}
	if i := duplicateID(ids, func(i int) string { return fmt.Sprintf("/props/fields/%d/id", i) }); i != nil {
		return i
	}
	for i, f := range p.Fields {
		at := fmt.Sprintf("/props/fields/%d", i)
		if f.Kind == "select" {
			if d, ok := f.Default.(string); ok {
				found := false
				for _, o := range f.Options {
					found = found || o.ID == d
				}
				if !found {
					return bad(at+"/default", "select_default", "must be one of the option ids")
				}
			}
		}
		if f.Min != nil && f.Max != nil && *f.Min > *f.Max {
			return bad(at+"/max", "min_max", "must not be less than min")
		}
	}
	return nil
}
