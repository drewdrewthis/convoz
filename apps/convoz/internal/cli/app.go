package cli

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/appbuild"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/appschema"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

func init() {
	Register(Command{Name: "app", Order: 90, Run: App,
		Usage: "convoz app init <dir>\n       convoz app build [--out DIR] <dir>\n       convoz app validate <file>"})
}

// App runs `convoz app init|build|validate`: the work on an app before it is posted. None of them needs the server.
func App(args []string, io IO) int {
	const usage = "usage: convoz app init <dir> | build [--out DIR] <dir> | validate <file>"
	f := newChatFlags("app", io)
	out := f.fs.String("out", "", "build: where to write app.html and app.json (default: dist in the app folder)")
	pos, ok := f.parse(args, io) // the subcommand is the first word, wherever the flags stand
	if !ok {
		return ExitUsage
	}
	if len(pos) != 2 {
		return usageError(io, usage)
	}
	switch pos[0] {
	case "init":
		return appInit(f, io, pos[1])
	case "build":
		return appBuild(f, io, pos[1], *out)
	case "validate":
		return appValidate(f, io, pos[1])
	}
	return usageError(io, usage)
}

func printResult(f *chatFlags, io IO, v any, text string) {
	if *f.asJSON {
		raw, _ := json.Marshal(v)
		fmt.Fprintln(io.Stdout, string(raw))
		return
	}
	fmt.Fprintln(io.Stdout, text)
}

func appInit(f *chatFlags, io IO, dir string) int {
	if err := appbuild.Init(dir); err != nil {
		return fail(io, err)
	}
	printResult(f, io, map[string]string{"dir": dir}, "wrote "+filepath.Join(dir, "convoz.app.json")+" and "+filepath.Join(dir, "index.html"))
	return ExitOK
}

func appBuild(f *chatFlags, io IO, dir, out string) int {
	res, err := appbuild.Build(dir, out)
	var p *appbuild.Problem
	if errors.As(err, &p) {
		return usageError(io, p.Error())
	}
	if err != nil {
		return fail(io, err)
	}
	for _, w := range res.Warnings {
		fmt.Fprintf(io.Stderr, "convoz: warning: %s\n", w)
	}
	printResult(f, io, res, fmt.Sprintf("%s %d bytes sha256 %s\n%s", res.HTML, res.Size, res.SHA256, res.AppJSON))
	return ExitOK
}

func appValidate(f *chatFlags, io IO, path string) int {
	raw, err := os.ReadFile(path)
	if err != nil || !json.Valid(raw) {
		return usageError(io, fmt.Sprintf("%s is not a file of JSON", path))
	}
	app, _, issue := checkLocal(raw, filepath.Dir(path))
	if issue != nil {
		return appRefused(io, *f.asJSON, issue)
	}
	printResult(f, io, wire.AppChecked{OK: true, Type: app.Type, Bytes: len(app.Canonical())}, "ok")
	return ExitOK
}

// appRefused prints what is wrong with an app, one line naming the place ("/props/colour: unknown key"), and exits 2.
func appRefused(io IO, asJSON bool, issue *appschema.Issue) int {
	if asJSON {
		raw, _ := json.Marshal(map[string]any{"ok": false, "code": issue.Code, "path": issue.Path, "message": issue.Message})
		fmt.Fprintln(io.Stdout, string(raw))
	}
	return usageError(io, issue.Error())
}

// placeholder stands in for an upload that has not happened yet, so the rest of a frame app can be checked.
const (
	placeholderUpload = "AAAAAAAAAAAAAAAAAAAAAA"
	placeholderSHA    = "0000000000000000000000000000000000000000000000000000000000000000"
)

// checkLocal checks an app with the schemas the server uses. A frame app in the authoring form (bundle.file) is checked as if
// its file were already uploaded; bundle is that file's path when there is one.
func checkLocal(raw []byte, base string) (app *appschema.App, bundle string, issue *appschema.Issue) {
	var doc map[string]any
	if json.Unmarshal(raw, &doc) != nil {
		return nil, "", &appschema.Issue{Code: appschema.CodeInvalid, Rule: "json", Message: "is not a JSON object"}
	}
	if props, ok := doc["props"].(map[string]any); ok && doc["type"] == "frame" {
		if b, ok := props["bundle"].(map[string]any); ok {
			// The authoring form counts only when its file is there; without it the app is judged as it stands, as the server judges it.
			if file, ok := b["file"].(string); ok && len(b) == 1 {
				if info, err := os.Stat(filepath.Join(base, file)); err == nil && info.Size() > 0 {
					bundle = filepath.Join(base, file)
					props["bundle"] = map[string]any{"upload": placeholderUpload, "sha256": placeholderSHA, "size": int(info.Size())}
					raw, _ = json.Marshal(doc)
				}
			}
		}
	}
	app, issue = appschema.Check(raw)
	return app, bundle, issue
}

// appOpts are the flags `post`, `reply` and `ask` share for an app (docs/messages-apps-spec.md §6).
type appOpts struct{ file, data, fallback, title *string }

func newAppOpts(f *chatFlags, help string) appOpts {
	return appOpts{
		file:     f.fs.String("app", "", help),
		data:     f.fs.String("app-data", "", "a file of JSON handed to a Tier-2 app as its data"),
		fallback: f.fs.String("app-fallback", "", "the plain-text version of the app, replacing the one in the file"),
		title:    f.fs.String("app-title", "", "the title of the app, replacing the one in the file"),
	}
}

func (o appOpts) set() bool { return *o.file != "" }

// check reads and checks the app file before anything is sent or opened, so a typo costs nothing. It returns the app JSON, in
// the authoring form for a Tier-2 app, and the path of the bundle to upload ("" for a Tier-1 app).
func (o appOpts) check(io IO) (raw []byte, bundle string, code int) {
	raw, err := os.ReadFile(*o.file)
	if err != nil || !json.Valid(raw) {
		return nil, "", usageError(io, fmt.Sprintf("--app %s is not a file of JSON", *o.file))
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, "", usageError(io, fmt.Sprintf("--app %s is not a JSON object", *o.file))
	}
	if *o.fallback != "" {
		doc["fallback"] = *o.fallback
	}
	if *o.title != "" {
		doc["title"] = *o.title
	}
	if *o.data != "" {
		data, err := os.ReadFile(*o.data)
		if err != nil || !json.Valid(data) {
			return nil, "", usageError(io, fmt.Sprintf("--app-data %s is not a file of JSON", *o.data))
		}
		props, _ := doc["props"].(map[string]any)
		if props == nil {
			props = map[string]any{}
			doc["props"] = props
		}
		props["data"] = json.RawMessage(data)
	}
	raw, _ = json.Marshal(doc)
	_, bundle, issue := checkLocal(raw, filepath.Dir(*o.file))
	if issue != nil {
		return nil, "", appRefused(io, false, issue)
	}
	return raw, bundle, ExitOK
}

// send finishes an app for the server: a Tier-2 bundle is uploaded and the app names it by the id, hash and size the server gives.
func (o appOpts) send(k *chatCmd, raw []byte, bundle string) (json.RawMessage, int) {
	if bundle == "" {
		return raw, ExitOK
	}
	content, err := os.ReadFile(bundle)
	if err != nil {
		return nil, usageError(k.io, fmt.Sprintf("the bundle %s cannot be read", bundle))
	}
	sum := sha256.Sum256(content)
	ctx, cancel := context.WithTimeout(context.Background(), k.timeout)
	defer cancel()
	var stored wire.AppBundle
	if err := k.c.callRaw(ctx, "POST", "/api/apps/bundles", k.lease, "text/html", content, &stored); err != nil {
		return nil, k.fail(err)
	}
	if stored.SHA256 != hex.EncodeToString(sum[:]) || stored.Size != len(content) {
		return nil, fail(k.io, errors.New("the server kept a different bundle than the one sent"))
	}
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	doc["props"].(map[string]any)["bundle"] = stored
	final, _ := json.Marshal(doc)
	if _, _, issue := checkLocal(final, ""); issue != nil {
		return nil, appRefused(k.io, false, issue)
	}
	return bytes.Clone(final), ExitOK
}
