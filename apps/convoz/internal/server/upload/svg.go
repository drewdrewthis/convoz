package upload

import (
	"bytes"
	"encoding/xml"
	"errors"
	"io"
	"regexp"
	"strings"
)

// Avatar limits: the identities column holds at most 4096 characters (I-32).
const (
	MaxAvatarIn  = 16 << 10
	MaxAvatarOut = 4096
)

// ErrAvatar means the SVG is refused: a DOCTYPE or an ENTITY, malformed, not an svg, or too big (answered 400).
var ErrAvatar = errors.New("the avatar is not a plain SVG")

const svgNS = "http://www.w3.org/2000/svg"

// avatarTags are the elements an avatar may use: shapes, groups and gradients. Anything else (script, style, foreignObject, image,
// use, animation) is cut out with everything inside it.
var avatarTags = map[string]bool{
	"svg": true, "g": true, "path": true, "circle": true, "ellipse": true, "rect": true, "line": true, "polyline": true, "polygon": true,
	"defs": true, "linearGradient": true, "radialGradient": true, "stop": true, "title": true, "desc": true,
}

// avatarAttrs are the attributes it may carry. No href, no style, no event handler: an avatar draws and does nothing else.
var avatarAttrs = map[string]bool{
	"viewBox": true, "width": true, "height": true, "x": true, "y": true, "cx": true, "cy": true, "r": true, "rx": true, "ry": true, "x1": true, "y1": true, "x2": true, "y2": true,
	"d": true, "points": true, "fill": true, "stroke": true, "stroke-width": true, "stroke-linecap": true, "stroke-linejoin": true, "opacity": true, "fill-opacity": true,
	"stroke-opacity": true, "fill-rule": true, "transform": true, "offset": true, "stop-color": true, "stop-opacity": true, "id": true,
	"gradientUnits": true, "gradientTransform": true, "fx": true, "fy": true, "preserveAspectRatio": true,
}

var localRef = regexp.MustCompile(`^url\(#[A-Za-z0-9_-]+\)$`)

// SanitizeAvatar rebuilds an SVG from an allow-list of elements and attributes and returns the clean text. A DOCTYPE or ENTITY
// declaration is refused outright (it could pull in files or expand to a bomb); a script or an unknown element is cut out.
func SanitizeAvatar(raw string) (string, error) {
	if len(raw) > MaxAvatarIn || strings.TrimSpace(raw) == "" {
		return "", ErrAvatar
	}
	dec := xml.NewDecoder(strings.NewReader(raw))
	dec.Strict = true
	var out bytes.Buffer
	var open []string // names of the elements written and not yet closed
	skip := 0         // depth inside an element being cut out
	roots := 0
	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", ErrAvatar
		}
		switch t := tok.(type) {
		case xml.Directive:
			return "", ErrAvatar // <!DOCTYPE ...> and <!ENTITY ...> both arrive here
		case xml.StartElement:
			switch {
			case skip > 0:
				skip++
			case !avatarTags[t.Name.Local] || (t.Name.Space != "" && t.Name.Space != svgNS):
				skip = 1
			case len(open) == 0 && (t.Name.Local != "svg" || roots > 0):
				return "", ErrAvatar
			default:
				if len(open) == 0 {
					roots++
				}
				writeStart(&out, t)
				open = append(open, t.Name.Local)
			}
		case xml.EndElement:
			if skip > 0 {
				skip--
				continue
			}
			out.WriteString("</" + open[len(open)-1] + ">")
			open = open[:len(open)-1]
		case xml.CharData:
			if skip == 0 && len(open) > 0 && (open[len(open)-1] == "title" || open[len(open)-1] == "desc") {
				_ = xml.EscapeText(&out, t)
			}
		}
	}
	if roots != 1 || len(open) != 0 || out.Len() > MaxAvatarOut {
		return "", ErrAvatar
	}
	return out.String(), nil
}

func writeStart(out *bytes.Buffer, t xml.StartElement) {
	out.WriteString("<" + t.Name.Local)
	if t.Name.Local == "svg" {
		out.WriteString(` xmlns="` + svgNS + `"`)
	}
	for _, a := range t.Attr {
		if a.Name.Space != "" || !avatarAttrs[a.Name.Local] || !safeValue(a.Value) {
			continue
		}
		out.WriteString(" " + a.Name.Local + `="`)
		_ = xml.EscapeText(out, []byte(a.Value))
		out.WriteString(`"`)
	}
	out.WriteString(">")
}

// safeValue refuses a value that reaches outside the drawing: a script URL, a data URL, or a reference to anything but a gradient of
// the same file.
func safeValue(v string) bool {
	l := strings.ToLower(strings.TrimSpace(v))
	if strings.Contains(l, "javascript:") || strings.Contains(l, "data:") || strings.Contains(l, "<") {
		return false
	}
	if strings.Contains(l, "url(") {
		return localRef.MatchString(strings.TrimSpace(v))
	}
	return true
}
