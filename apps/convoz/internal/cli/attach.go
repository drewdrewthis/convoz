package cli

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// maxFiles is the most files one message carries; the server enforces the same limit (message.MaxUploads), this check only
// saves the network calls of a command that cannot succeed.
const maxFiles = 10

// fileList is the value of a repeated --file flag.
type fileList []string

func (l *fileList) String() string     { return strings.Join(*l, ",") }
func (l *fileList) Set(v string) error { *l = append(*l, v); return nil }

// attachment is a local file to send: its name, size and checksum are known before any upload starts.
type attachment struct {
	path, name string
	size       int64
	sum        []byte
}

// sentFile is what --json prints for each file of a message.
type sentFile struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Size int64  `json:"size"`
}

// readAttachments checks the --file list before anything is sent: the count, then that each is a readable, non-empty file. What the
// file is (its type) is the server's call, as for the web composer.
func readAttachments(paths []string) ([]attachment, error) {
	if len(paths) > maxFiles {
		return nil, fmt.Errorf("a message carries at most %d files, got %d", maxFiles, len(paths))
	}
	out := make([]attachment, 0, len(paths))
	for _, p := range paths {
		info, err := os.Stat(p)
		switch {
		case err != nil:
			return nil, fmt.Errorf("--file %s cannot be read", p)
		case !info.Mode().IsRegular():
			return nil, fmt.Errorf("--file %s is not a file", p)
		case info.Size() == 0:
			return nil, fmt.Errorf("--file %s is empty", p)
		}
		sum, err := sha256File(p)
		if err != nil {
			return nil, fmt.Errorf("--file %s cannot be read", p)
		}
		out = append(out, attachment{path: p, name: filepath.Base(p), size: info.Size(), sum: sum})
	}
	return out, nil
}

func sha256File(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return nil, err
	}
	return h.Sum(nil), nil
}

// kindOf is the kind the web composer asks for, from the file's type: image, audio or file. The server sniffs the bytes and may only
// narrow it, so a wrong guess here costs nothing.
func kindOf(name string) string {
	m := mime.TypeByExtension(strings.ToLower(filepath.Ext(name)))
	switch {
	case strings.HasPrefix(m, "image/"):
		return "image"
	case strings.HasPrefix(m, "audio/"):
		return "audio"
	}
	return "file"
}

// pendingPost is the record that makes a re-run of a failed `post --file` safe. It holds the client id of the message and the
// upload ids already made, so the re-run resumes those uploads and posts with the same client id: the server stores the message once.
// It is keyed by what the command sends, so another message gets another record, and it is removed once the post is stored.
type pendingPost struct {
	path     string
	ClientID string   `json:"client_id"`
	Uploads  []string `json:"uploads"` // upload id per file, "" before the upload is started
}

// openPending loads the record of this exact message, or starts one. clientID is the --client-id given, or "".
func (k *chatCmd) openPending(conv, thread int64, format, text, clientID string, files []attachment) (*pendingPost, error) {
	h := sha256.New()
	fmt.Fprintf(h, "%d\x00%d\x00%s\x00%s\x00%s", conv, thread, format, text, clientID)
	for _, f := range files {
		fmt.Fprintf(h, "\x00%x", f.sum)
	}
	p := &pendingPost{path: filepath.Join(k.dir, "pending", hex.EncodeToString(h.Sum(nil))[:24]+".json")}
	if raw, err := os.ReadFile(p.path); err == nil && json.Unmarshal(raw, p) == nil && len(p.Uploads) == len(files) && wire.ValidClientID(p.ClientID) {
		return p, nil
	}
	p.ClientID, p.Uploads = clientID, make([]string, len(files))
	if p.ClientID == "" {
		p.ClientID = "convoz-" + randomHex(8)
	}
	return p, p.save()
}

func (p *pendingPost) save() error {
	if err := os.MkdirAll(filepath.Dir(p.path), 0o700); err != nil {
		return err
	}
	raw, _ := json.Marshal(p)
	return os.WriteFile(p.path, raw, 0o600)
}

func (p *pendingPost) done() { _ = os.Remove(p.path) }

// attach uploads the files that are not yet uploaded and returns what the message carries. An upload from an earlier run is resumed.
// A refusal names the file.
func (k *chatCmd) attach(conv int64, files []attachment, p *pendingPost) ([]sentFile, error) {
	sent := make([]sentFile, 0, len(files))
	for i, f := range files {
		id, err := k.sendFile(conv, f, p.Uploads[i], func(id string) error { p.Uploads[i] = id; return p.save() })
		if err != nil {
			return nil, fmt.Errorf("%s: %w", f.path, err)
		}
		sent = append(sent, sentFile{ID: id, Name: f.name, Size: f.size})
	}
	return sent, nil
}

// sendFile makes the upload (unless earlier holds one) and sends the bytes, resuming where the server stopped. started is called
// with a new upload's id before its bytes go, so a crash leaves the id on record.
func (k *chatCmd) sendFile(conv int64, f attachment, earlier string, started func(id string) error) (string, error) {
	if earlier != "" {
		content, err := os.ReadFile(f.path)
		if err != nil {
			return "", err
		}
		st, err := k.finishUpload(earlier, content, true)
		if !isNotFound(err) {
			return st.ID, err
		}
	}
	st, err := k.createUpload(conv, kindOf(f.name), f.name, f.size, f.sum)
	if err != nil {
		return "", err
	}
	if err := started(st.ID); err != nil {
		return "", err
	}
	content, err := os.ReadFile(f.path) // read only now: the server has accepted its size
	if err != nil {
		return "", err
	}
	st, err = k.finishUpload(st.ID, content, false)
	return st.ID, err
}

// createUpload starts an upload (POST /api/uploads). Its client id is the same on every try (callRetry), so a try whose answer was lost
// gets the first upload back and leaves no orphan. The server refuses a size or a conversation here, before any bytes are sent.
func (k *chatCmd) createUpload(conv int64, kind, name string, size int64, sum []byte) (st wire.UploadState, err error) {
	req := wire.CreateUploadRequest{ConversationID: conv, Kind: kind, Filename: name, Size: size, SHA256: hex.EncodeToString(sum), ClientID: "convoz-" + randomHex(8)}
	err = k.callRetry("POST", "/api/uploads", req, &st)
	return st, err
}

func isNotFound(err error) bool {
	code, _ := statusCode(err)
	return code == 404
}

// finishUpload sends content of upload id and returns the finished upload. After a failure it asks the server where it stopped
// (HEAD) and sends the rest (PATCH), under the retry rule of the other commands. resume starts with that question, for an upload
// an earlier run began.
func (k *chatCmd) finishUpload(id string, content []byte, resume bool) (wire.UploadState, error) {
	st := wire.UploadState{ID: id}
	var offset int64
	started := time.Now()
	for try := 1; ; try++ {
		var err error
		if resume {
			resume = false
			var state string
			if offset, state, err = k.uploadOffset(id); err == nil && state == "complete" {
				st.State = state
				return st, nil
			}
		}
		if err == nil {
			err = k.patchUpload(id, content, min(offset, int64(len(content))), &st)
		}
		if err == nil {
			return st, nil
		}
		wait, again := pause(err, try)
		if _, code := statusCode(err); code == "offset_mismatch" {
			wait, again = 0, true // the server is further on than the client thought: ask where
		}
		if !again || try >= retryTries || time.Since(started)+wait > maxSlowDown {
			return st, err
		}
		time.Sleep(wait)
		resume = true
	}
}

func (k *chatCmd) patchUpload(id string, content []byte, offset int64, st *wire.UploadState) error {
	ctx, cancel := context.WithTimeout(context.Background(), k.timeout)
	defer cancel()
	head := map[string]string{wire.HeaderUploadOffset: strconv.FormatInt(offset, 10)}
	err := k.c.withTimeout(k.timeout).callRaw(ctx, "PATCH", "/api/uploads/"+id, k.lease, wire.ChunkType, head, content[offset:], st)
	if err == nil && st.State != "complete" {
		err = errors.New("the server did not finish the upload")
	}
	return err
}

func (k *chatCmd) uploadOffset(id string) (int64, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), min(k.timeout, attemptTimeout))
	defer cancel()
	return k.c.headUpload(ctx, "/api/uploads/"+id, k.lease)
}
