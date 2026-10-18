package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	stdio "io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

const fileUsage = "usage: convoz file [-o PATH|-] <id>"

// publicIDRE is the shape of an upload id (`convoz read --json` lists it as uploads[].id). The id goes into a URL path, so nothing else may pass.
var publicIDRE = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

// File runs `convoz file [-o PATH] <id>`: it fetches an attachment of a conversation the agent is in. With -o PATH the bytes go to
// PATH; with -o - to standard output. With neither they go to ./<id>_<name> in the current folder, which is never overwritten, never
// a dotfile and never outside the folder, whatever name the uploader gave. It prints where the file went (or, with --json, the id,
// path, name, size and type).
func File(args []string, io IO) int {
	f := newChatFlags("file", io)
	out := f.fs.String("o", "", "where to write the file; - for standard output (default: ./<id>_<name>)")
	pos, ok := f.parse(args, io)
	if !ok {
		return ExitUsage
	}
	if len(pos) != 1 || !publicIDRE.MatchString(pos[0]) {
		return usageError(io, fileUsage)
	}
	if *out == "-" && *f.asJSON {
		return usageError(io, "--json cannot go with -o -: the file is on standard output")
	}
	k, code := f.open(io)
	if k == nil {
		return code
	}
	ctx, cancel := context.WithTimeout(context.Background(), k.timeout)
	defer cancel()
	res, err := k.c.withTimeout(k.timeout).open(ctx, wire.RouteFiles+"/"+url.PathEscape(pos[0]), k.lease)
	if err != nil {
		return k.fail(err)
	}
	defer res.Body.Close()
	name := nameOf(res.Header.Get("Content-Disposition"))
	if *out == "-" {
		if _, err := stdio.Copy(k.io.Stdout, res.Body); err != nil {
			return fail(io, fmt.Errorf("the file was cut off: %w", err))
		}
		return ExitOK
	}
	path, explicit := *out, *out != ""
	if !explicit {
		path = pos[0] + "_" + safeName(name)
	}
	size, err := saveTo(path, explicit, res.Body)
	if err != nil {
		return fail(io, err)
	}
	if k.asJSON {
		k.printJSON(map[string]any{"id": pos[0], "path": path, "name": name, "size": size, "mime": res.Header.Get("Content-Type")})
	} else {
		fmt.Fprintln(k.io.Stdout, path)
	}
	return ExitOK
}

// open sends an authenticated GET and returns the response with its body unread. A non-2xx answer is a *statusError.
func (c *client) open(ctx context.Context, path, token string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: cannot reach %s: %v", errUnreachable, c.base, err)
	}
	if res.StatusCode/100 == 2 {
		return res, nil
	}
	defer res.Body.Close()
	raw, _ := stdio.ReadAll(stdio.LimitReader(res.Body, 1<<16))
	var e wire.Error
	if json.Unmarshal(raw, &e) == nil && e.Error.Code != "" {
		return nil, &statusError{status: res.StatusCode, code: e.Error.Code, msg: e.Error.Message, retryAfter: retryAfter(res)}
	}
	return nil, &statusError{status: res.StatusCode, msg: fmt.Sprintf("the server answered %d", res.StatusCode)}
}

// nameOf is the file name in a Content-Disposition header, or "" when there is none.
func nameOf(disposition string) string {
	_, params, err := mime.ParseMediaType(disposition)
	if err != nil {
		return ""
	}
	return params["filename"]
}

var unsafeNameChars = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// safeName turns the uploader's file name into one that is safe as part of a local name: no path, no odd characters, no leading dot.
func safeName(name string) string {
	name = unsafeNameChars.ReplaceAllString(filepath.Base(strings.ReplaceAll(name, "\\", "/")), "_")
	name = strings.TrimLeft(name, ".")
	if len(name) > 100 {
		name = name[len(name)-100:]
	}
	if name == "" {
		return "file"
	}
	return name
}

// saveTo writes r to path. A path the caller chose is replaced, through a temporary file in the same folder, so a cut-off download leaves
// the old file as it was. A path made by default must be new: it is created exclusively, and removed again if the download breaks.
func saveTo(path string, replace bool, r stdio.Reader) (int64, error) {
	if !replace {
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if errors.Is(err, os.ErrExist) {
			return 0, fmt.Errorf("%s exists: choose where to write with -o", path)
		}
		if err != nil {
			return 0, err
		}
		n, err := stdio.Copy(f, r)
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			_ = os.Remove(path)
		}
		return n, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".convoz-file-*") // mode 0600
	if err != nil {
		return 0, err
	}
	n, err := stdio.Copy(tmp, r)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp.Name(), path)
	}
	if err != nil {
		_ = os.Remove(tmp.Name())
	}
	return n, err
}
