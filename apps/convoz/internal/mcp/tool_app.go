package mcp

import (
	"context"
	"encoding/json"
)

// The tools that check and build an app before it is posted. They run `convoz app validate` and `convoz app build`; a build
// without those commands answers that they are not part of it.

func init() {
	Register(Tool{Name: "app_validate", Order: 14, Description: "Check a file of app JSON against the app.v1 shape before you post it.",
		InputSchema: object([]string{"path"}, props{"path": text("The path of the JSON file.")}),
		Call: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct{ Path string }
			if err := decodeArgs(args, &a); err != nil {
				return nil, err
			}
			return runnerOf(ctx).runSub("app", []string{"validate"}, "", a.Path)
		}})

	Register(Tool{Name: "app_build", Order: 15, Description: "Bundle the app in a directory into one app that can be posted.",
		InputSchema: object([]string{"dir"}, props{"dir": text("The directory of the app.")}),
		Call: func(ctx context.Context, args json.RawMessage) (any, error) {
			var a struct{ Dir string }
			if err := decodeArgs(args, &a); err != nil {
				return nil, err
			}
			return runnerOf(ctx).runSub("app", []string{"build"}, "", a.Dir)
		}})
}
