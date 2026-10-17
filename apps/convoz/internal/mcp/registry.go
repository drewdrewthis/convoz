// Package mcp is `convoz mcp`: the MCP server an agent runs, a thin client of the HTTP API (design §13.2). Like
// internal/cli it never imports internal/server. Each tool registers itself from its own tool_<name>.go in an init
// function, so a new tool never edits a shared table; the server (S-A) serves Tools() in Order.
package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
)

// Tool is one MCP tool.
type Tool struct {
	Name        string
	Description string
	// InputSchema is the JSON Schema 2020-12 of the arguments (packages/contracts holds the source).
	InputSchema json.RawMessage
	// Order places the tool in the tools list (lower first).
	Order int
	// Call runs the tool with its JSON arguments and returns the JSON-ready result.
	Call func(ctx context.Context, args json.RawMessage) (any, error)
}

var tools = map[string]Tool{}

// Register adds a tool. Two tools with one name is a build defect.
func Register(t Tool) {
	if _, taken := tools[t.Name]; taken {
		panic(fmt.Sprintf("mcp: tool %q registered twice", t.Name))
	}
	tools[t.Name] = t
}

// Lookup finds a registered tool.
func Lookup(name string) (Tool, bool) {
	t, ok := tools[name]
	return t, ok
}

// Tools lists every registered tool, in Order.
func Tools() []Tool {
	out := make([]Tool, 0, len(tools))
	for _, t := range tools {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Order != out[j].Order {
			return out[i].Order < out[j].Order
		}
		return out[i].Name < out[j].Name
	})
	return out
}
