package appschema

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strings"
)

// Limits (design §13.1).
const (
	MaxAppBytes    = 65536
	MaxFrameData   = 32768
	MaxBundleBytes = 524288
	MaxResultBytes = 4096
)

// Codes only the callers of Check add.
const (
	CodeNotAllowedOnAsk  = "app_type_not_allowed_on_ask"
	CodeResultNotAllowed = "app_result_not_allowed"
)

// App is a checked app: its envelope, with props kept as they came.
type App struct {
	V        int             `json:"v"`
	Type     string          `json:"type"`
	Title    string          `json:"title,omitempty"`
	Fallback string          `json:"fallback"`
	Height   int             `json:"height,omitempty"`
	Props    json.RawMessage `json:"props"`
	raw      []byte
}

// Check judges the JSON of an app: its size, duplicate keys, the schema, then the semantic checks. It returns the app with the
// compact JSON to store (Canonical). The Tier-2 authoring form (bundle.file) fails like any unknown key.
func Check(raw []byte) (*App, *Issue) {
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return nil, &Issue{Code: CodeInvalid, Rule: "json", Message: "is not JSON"}
	}
	if compact.Len() > MaxAppBytes {
		return nil, &Issue{Code: CodeTooLarge, Rule: "size", Message: fmt.Sprintf("must have at most %d bytes", MaxAppBytes)}
	}
	if path := duplicateKey(compact.Bytes()); path != "" {
		return nil, &Issue{Code: CodeInvalid, Path: path, Rule: "duplicateKey", Message: "key is given twice"}
	}
	if i := check("app.json", CodeInvalid, compact.Bytes()); i != nil {
		return nil, i
	}
	a := &App{raw: slices.Clone(compact.Bytes())}
	if err := json.Unmarshal(compact.Bytes(), a); err != nil {
		return nil, &Issue{Code: CodeInvalid, Rule: "json", Message: err.Error()}
	}
	if i := semantic(a); i != nil {
		return nil, i
	}
	return a, nil
}

// Canonical is the compact JSON the server stores.
func (a *App) Canonical() []byte { return a.raw }

// OnAsk refuses what answers or acts: a picker, a form, a checklist in select mode (I-50). Everything else only helps decide.
func (a *App) OnAsk() *Issue {
	switch a.Type {
	case "picker", "form":
		return &Issue{Code: CodeNotAllowedOnAsk, Path: "/type", Rule: "onAsk", Message: a.Type + " cannot sit on an ask"}
	case "checklist":
		var p struct{ Mode string }
		_ = json.Unmarshal(a.Props, &p)
		if p.Mode == "select" {
			return &Issue{Code: CodeNotAllowedOnAsk, Path: "/props/mode", Rule: "onAsk", Message: "a checklist in select mode cannot sit on an ask"}
		}
	}
	return nil
}

// Bundle is the stored bundle a frame app names.
type Bundle struct {
	Upload, SHA256 string
	Size           int64
}

// Refs are the uploads an app points at: the images of a gallery, or the bundle of a frame.
type Refs struct {
	Images []string
	Bundle *Bundle
}

// Refs lists them. An app that needs no upload has none.
func (a *App) Refs() Refs {
	var out Refs
	switch a.Type {
	case "gallery":
		var p struct{ Images []struct{ Upload string } }
		_ = json.Unmarshal(a.Props, &p)
		for _, im := range p.Images {
			out.Images = append(out.Images, im.Upload)
		}
	case "frame":
		var p struct {
			Bundle struct {
				Upload, SHA256 string
				Size           int64
			}
		}
		_ = json.Unmarshal(a.Props, &p)
		out.Bundle = &Bundle{Upload: p.Bundle.Upload, SHA256: p.Bundle.SHA256, Size: p.Bundle.Size}
	}
	return out
}

// duplicateKey returns the pointer of the first object key given twice, or "".
func duplicateKey(raw []byte) string {
	dec := json.NewDecoder(bytes.NewReader(raw))
	var walk func(path string) string
	walk = func(path string) string {
		tok, err := dec.Token()
		if err != nil {
			return ""
		}
		switch tok {
		case json.Delim('{'):
			seen := map[string]bool{}
			for dec.More() {
				k, _ := dec.Token()
				key, _ := k.(string)
				at := path + "/" + strings.NewReplacer("~", "~0", "/", "~1").Replace(key)
				if seen[key] {
					return at
				}
				seen[key] = true
				if p := walk(at); p != "" {
					return p
				}
			}
			_, _ = dec.Token()
		case json.Delim('['):
			for i := 0; dec.More(); i++ {
				if p := walk(fmt.Sprintf("%s/%d", path, i)); p != "" {
					return p
				}
			}
			_, _ = dec.Token()
		}
		return ""
	}
	p := walk("")
	if _, err := dec.Token(); err != io.EOF && p == "" {
		return ""
	}
	return p
}
