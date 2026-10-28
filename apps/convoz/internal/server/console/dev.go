package console

import (
	"errors"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// ServeDev serves one file of the owner's dev build of the web app (the /dev/ pages). dir is --dev-web-dir: on prod a symlink
// (/var/lib/convoz-devweb/current) to the folder of the live build, which the deploy swaps by renaming a new symlink over it. The
// symlink is resolved once per request, so a new build shows at the next load without a restart, and every file of one request
// comes from one build. name is the path under /dev/ ("" for the page itself). The resolved folder is opened as an os.Root, so no
// name or ".." reaches a file outside it, and no symlink inside the tree is followed at all (a build holds only files and folders):
// such a name is a 404. A name that is no file of the build gets the build's index.html, so the app picks the screen from the
// URL; a missing file under assets/ is a 404, never a page in place of a script. A file under assets/ has a content-hashed name (Vite), so it is cached for a year as the prod console does (Asset);
// the page and every other file are never cached: the next build must show at the next load. With no folder (dir empty, missing, or no build in it), every name is a 404, the same answer as an unknown path.
func ServeDev(w http.ResponseWriter, r *http.Request, dir, name string) {
	if dir == "" || (name != "" && !fs.ValidPath(name)) {
		http.NotFound(w, r)
		return
	}
	build, err := filepath.EvalSymlinks(dir)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	root, err := os.OpenRoot(build)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer root.Close()
	if name == "" {
		name = "index.html"
	}
	file, err := openDev(root, name)
	if errors.Is(err, fs.ErrNotExist) && !strings.HasPrefix(name, "assets/") {
		name = "index.html"
		file, err = openDev(root, name)
	}
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	h := w.Header()
	contentType := mime.TypeByExtension(path.Ext(name))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	h.Set("Content-Type", contentType)
	h.Set("Content-Security-Policy", policy())
	h.Set("Cache-Control", devCacheControl(name))
	http.ServeContent(w, r, "", time.Time{}, file)
}

// errSymlink is a name that passes through a symlink inside the build: it is refused, never followed.
var errSymlink = errors.New("console: a symlink in the dev build")

// openDev opens name as a regular file inside root. A name with no file, or a folder, is fs.ErrNotExist. A name that passes
// through a symlink, or that the root refuses (out of the folder), is another error, so it never falls back to the page.
func openDev(root *os.Root, name string) (io.ReadSeekCloser, error) {
	parts := strings.Split(name, "/")
	for i := range parts {
		info, err := root.Lstat(strings.Join(parts[:i+1], "/"))
		if err != nil {
			return nil, err
		}
		if info.Mode()&fs.ModeSymlink != 0 {
			return nil, errSymlink
		}
	}
	f, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		_ = f.Close()
		return nil, fs.ErrNotExist
	}
	return f, nil
}

// devCacheControl is the Cache-Control of one served name: a year for a hashed file under assets/ (a new build has new names), none
// for the page, the manifest and anything else, whose names stay the same from build to build.
func devCacheControl(name string) string {
	if strings.HasPrefix(name, "assets/") {
		return "public, max-age=31536000, immutable"
	}
	return "no-store"
}
