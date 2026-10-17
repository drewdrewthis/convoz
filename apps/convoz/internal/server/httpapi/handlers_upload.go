package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/identity"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/upload"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// uploadsPerHour is how many uploads one identity may start in an hour (design §13.1).
const uploadsPerHour = 60

type uploadBudgets struct{ starts auth.Limiter }

var uploadBudgetsOf sync.Map // *Server -> *uploadBudgets

func (s *Server) uploadBudget() *uploadBudgets {
	b, _ := uploadBudgetsOf.LoadOrStore(s, &uploadBudgets{starts: auth.Limiter{Window: time.Hour, Max: uploadsPerHour}})
	return b.(*uploadBudgets)
}

// uploadService is the service, or a 503 when this server has no blob directory (it never happens in `convoz serve`).
func (s *Server) uploadService(w http.ResponseWriter) *upload.Service {
	svc := files.Load()
	if svc == nil {
		writeErr(w, http.StatusServiceUnavailable, "uploads_off", "Uploads are not available on this server.")
	}
	return svc
}

func stateOf(svc *upload.Service, r upload.Row) wire.UploadState {
	st := wire.UploadState{ID: r.PublicID, State: r.State, Offset: svc.Offset(r), Kind: r.Kind, Name: r.Filename, Segment: upload.SegmentSize}
	if !r.Deferred {
		st.Size = r.DeclaredSize
	}
	if r.Complete() {
		st.Mime, st.Inline, st.Width, st.Height, st.DurationMS = r.Mime, r.Inline, r.Width, r.Height, r.DurationMS
	}
	return st
}

// createUpload is POST /api/uploads: it starts an upload in a conversation the caller can write in (I-31). The daily byte quota of
// the identity and of its machine, and 60 starts an hour, bound it.
func (s *Server) createUpload(w http.ResponseWriter, r *http.Request, c *call) {
	svc := s.uploadService(w)
	if svc == nil {
		return
	}
	var in wire.CreateUploadRequest
	if !decode(w, r, &in) {
		return
	}
	var sum []byte
	if in.SHA256 != "" {
		var err error
		if sum, err = hex.DecodeString(in.SHA256); err != nil || len(sum) != 32 {
			writeFieldErr(w, http.StatusBadRequest, "invalid_request", "sha256", "The checksum is 64 hex characters.")
			return
		}
	}
	switch {
	case !upload.ValidKind(in.Kind):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "kind", "The kind is audio, image, file or app.")
		return
	case in.Kind == upload.KindApp && in.Size > upload.MaxAppBytes:
		writeErr(w, http.StatusRequestEntityTooLarge, wire.CodeAppTooLarge, "A bundle has at most 524288 bytes.")
		return
	case in.Filename == "" || len(in.Filename) > 255 || strings.ContainsFunc(in.Filename, func(r rune) bool { return r < 0x20 }):
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "filename", "The file name is 1 to 255 characters.")
		return
	case in.Size < 0 || in.Size > upload.MaxSize:
		writeFieldErr(w, http.StatusRequestEntityTooLarge, "upload_too_large", "size", "A file has at most 25 MB.")
		return
	case in.Size > 0 && sum == nil:
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", "sha256", "A file of known size needs its checksum.")
		return
	}
	ctx, d := r.Context(), s.reader()
	if _, visible, err := canSee(ctx, d, c.p, in.ConversationID); err != nil {
		s.internalError(w, r, err)
		return
	} else if !visible {
		notVisible(w, c)
		return
	}
	who, now := c.p.Identity(), s.Clock.Now()
	key := strconv.FormatInt(who, 10)
	if !s.uploadBudget().starts.Allow(key, now) {
		tooMany(w, s.uploadBudget().starts.RetryAfter(key, now), "Too many uploads. Slow down.")
		return
	}
	var row upload.Row
	err := s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) (err error) {
		row, err = svc.Create(ctx, tx.DBTX(), now, upload.NewRequest{
			Uploader: who, Session: c.p.SessionID, Conversation: in.ConversationID, Kind: in.Kind, Filename: in.Filename, Size: in.Size, SHA256: sum,
		}, c.lease.MachineID)
		return err
	})
	switch {
	case errors.Is(err, upload.ErrQuota):
		tooMany(w, time.Hour, "The daily upload limit is reached.")
	case errors.Is(err, upload.ErrBadRequest):
		writeErr(w, http.StatusBadRequest, "invalid_request", "The upload is not valid.")
	case err != nil:
		s.internalError(w, r, err)
	default:
		w.Header().Set(wire.HeaderUploadOffset, "0")
		writeJSON(w, http.StatusCreated, stateOf(svc, row))
	}
}

// ownUpload finds the upload the caller started. Another identity's is a 404, as an unknown one: its id tells nothing.
func (s *Server) ownUpload(w http.ResponseWriter, r *http.Request, c *call) (upload.Row, bool) {
	row, found, err := upload.ByPublicID(r.Context(), s.reader(), r.PathValue("id"))
	if err != nil {
		s.internalError(w, r, err)
		return row, false
	}
	if !found || row.UploaderID != c.p.Identity() {
		writeErr(w, http.StatusNotFound, "not_found", "No such upload.")
		return row, false
	}
	return row, true
}

// headUpload is HEAD /api/uploads/:id: where to resume from. A client that lost its connection asks this before it sends again.
func (s *Server) headUpload(w http.ResponseWriter, r *http.Request, c *call) {
	svc := s.uploadService(w)
	if svc == nil {
		return
	}
	row, ok := s.ownUpload(w, r, c)
	if !ok {
		return
	}
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set(wire.HeaderUploadOffset, strconv.FormatInt(svc.Offset(row), 10))
	h.Set(wire.HeaderUploadState, row.State)
	if !row.Deferred {
		h.Set(wire.HeaderUploadLength, strconv.FormatInt(row.DeclaredSize, 10))
	}
	w.WriteHeader(http.StatusOK)
}

// chunkOf reads the headers of a PATCH.
func chunkOf(r *http.Request) (upload.Chunk, bool) {
	off, err := strconv.ParseInt(r.Header.Get(wire.HeaderUploadOffset), 10, 64)
	if err != nil || off < 0 {
		return upload.Chunk{}, false
	}
	c := upload.Chunk{Offset: off}
	if v := r.Header.Get(wire.HeaderUploadLength); v != "" {
		if c.Length, err = strconv.ParseInt(v, 10, 64); err != nil || c.Length <= 0 || c.Length > upload.MaxSize {
			return c, false
		}
	}
	if v := r.Header.Get(wire.HeaderUploadChecksum); v != "" {
		algo, hexed, _ := strings.Cut(v, " ")
		if c.Checksum, err = hex.DecodeString(hexed); !strings.EqualFold(algo, "sha256") || err != nil || len(c.Checksum) != 32 {
			return c, false
		}
	}
	if v := r.Header.Get(wire.HeaderUploadDurationMS); v != "" {
		if c.DurationMS, err = strconv.ParseInt(v, 10, 64); err != nil || c.DurationMS < 0 {
			return c, false
		}
	}
	if v := r.Header.Get(wire.HeaderUploadWaveform); v != "" {
		if c.Waveform, err = base64.StdEncoding.DecodeString(v); err != nil || len(c.Waveform) > upload.MaxWaveform {
			return c, false
		}
	}
	return c, true
}

// patchUpload is PATCH /api/uploads/:id: one chunk of the file at Upload-Offset. The bytes are sealed segment by segment as they
// arrive (I-27). More bytes than the declared size end the upload with a 413 (I-31); a connection that drops keeps what came.
func (s *Server) patchUpload(w http.ResponseWriter, r *http.Request, c *call) {
	svc := s.uploadService(w)
	if svc == nil {
		return
	}
	row, ok := s.ownUpload(w, r, c)
	if !ok {
		return
	}
	if media, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); media != wire.ChunkType && media != "application/octet-stream" {
		writeErr(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "A chunk is application/offset+octet-stream.")
		return
	}
	chunk, ok := chunkOf(r)
	if !ok {
		writeFieldErr(w, http.StatusBadRequest, "invalid_request", wire.HeaderUploadOffset, "The upload headers are not valid.")
		return
	}
	who := c.p.Identity()
	if !svc.Enter(who) {
		tooMany(w, time.Second, "Too many chunks at once. Wait a moment.")
		return
	}
	defer svc.Leave(who)
	prog, err := svc.Receive(row, chunk, r.Body)
	// What arrived is kept whatever happened to the connection: the database counts the whole segments, so a resume finds them.
	persistErr := s.persistUpload(context.WithoutCancel(r.Context()), row, prog)
	var off *upload.OffsetError
	switch {
	case errors.As(err, &off):
		w.Header().Set(wire.HeaderUploadOffset, strconv.FormatInt(off.Have, 10))
		writeErr(w, http.StatusConflict, "offset_mismatch", "The chunk does not start where the server is.")
	case errors.Is(err, upload.ErrTooLarge):
		s.abortUpload(r.Context(), svc, row)
		writeErr(w, http.StatusRequestEntityTooLarge, "upload_too_large", "More bytes arrived than the upload declared.")
	case errors.Is(err, upload.ErrImageTooLarge):
		s.abortUpload(r.Context(), svc, row)
		writeErr(w, http.StatusRequestEntityTooLarge, "image_too_large", "image too large")
	case errors.Is(err, upload.ErrChecksum):
		s.abortUpload(r.Context(), svc, row)
		writeErr(w, http.StatusUnprocessableEntity, "checksum_mismatch", "The file does not match its checksum.")
	case errors.Is(err, upload.ErrComplete):
		writeErr(w, http.StatusConflict, "upload_complete", "The upload is complete.")
	case errors.Is(err, upload.ErrBadRequest):
		writeErr(w, http.StatusBadRequest, "invalid_request", "The upload is not valid.")
	case err != nil:
		s.Log.Printf("upload chunk: %v", err) // a connection that dropped, or a disk fault
		writeErr(w, http.StatusBadRequest, "chunk_incomplete", "The chunk did not arrive whole.")
	case persistErr != nil:
		s.internalError(w, r, persistErr)
	default:
		row.Committed = prog.Committed
		if f := prog.Finished; f != nil {
			row.State, row.Kind, row.Mime, row.Inline, row.DeclaredSize, row.Width, row.Height, row.DurationMS = "complete", f.Kind, f.Mime, f.Inline, f.Size, f.Width, f.Height, f.DurationMS
			row.Deferred = false
			svc.Forget(row.StorageName)
		}
		w.Header().Set(wire.HeaderUploadOffset, strconv.FormatInt(prog.Offset, 10))
		st := stateOf(svc, row)
		st.Offset = prog.Offset
		writeJSON(w, http.StatusOK, st)
	}
}

// persistUpload writes what a chunk changed: the sealed bytes, and a finished file's facts.
func (s *Server) persistUpload(ctx context.Context, row upload.Row, p upload.Progress) error {
	if p.Finished == nil && p.Committed <= row.Committed {
		return nil
	}
	return s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		if p.Finished != nil {
			return upload.Finish(ctx, d, s.Clock.Now(), row.ID, *p.Finished)
		}
		return upload.SetCommitted(ctx, d, row.ID, p.Committed)
	})
}

// abortUpload ends an upload that broke a rule: its row and its file go.
func (s *Server) abortUpload(ctx context.Context, svc *upload.Service, row upload.Row) {
	if err := s.Store.Writer.Tx(context.WithoutCancel(ctx), func(ctx context.Context, tx *pdb.Tx) error { return upload.Delete(ctx, tx.DBTX(), row.ID) }); err != nil {
		s.Log.Printf("abort upload: %v", err)
	}
	svc.Remove(row.StorageName)
}

// getFile is GET /api/files/:public_id: the decrypted file with Range support. Only a safe image or audio type is shown inline; the
// rest is an attachment. Always nosniff and a sandbox CSP that allows nothing (I-44). A file of a message is read by whoever may
// see the message; one not yet in a message only by the one who uploaded it.
func (s *Server) getFile(w http.ResponseWriter, r *http.Request, c *call) {
	svc := s.uploadService(w)
	if svc == nil {
		return
	}
	ctx, d := r.Context(), s.reader()
	row, found, err := upload.ByPublicID(ctx, d, r.PathValue("public_id"))
	if err == nil && found && row.Complete() {
		found, err = s.mayOpen(ctx, d, c, row)
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !found || !row.Complete() || row.Kind == upload.KindApp { // a bundle is served only by its frame route
		writeErr(w, http.StatusNotFound, "not_found", "No such file.")
		return
	}
	rd, err := svc.Blobs.Open(row)
	if err == nil {
		err = rd.Verify() // a moved or cut-off blob fails here, before a byte goes out
	}
	if err != nil {
		s.Log.Printf("file %s: %v", row.PublicID, err)
		if rd != nil {
			rd.Close()
		}
		writeErr(w, http.StatusInternalServerError, "file_unreadable", "That file cannot be read.")
		return
	}
	defer rd.Close()
	disposition, ctype := "attachment", "application/octet-stream"
	if row.Inline {
		disposition, ctype = "inline", row.Mime
	}
	h := w.Header()
	h.Set("Content-Type", ctype)
	if v := mime.FormatMediaType(disposition, map[string]string{"filename": row.Filename}); v != "" {
		h.Set("Content-Disposition", v)
	} else {
		h.Set("Content-Disposition", disposition)
	}
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'")
	h.Set("Cache-Control", "private, no-cache")
	h.Set("ETag", `"`+row.PublicID+`"`)
	http.ServeContent(w, r, "", time.Time{}, rd)
}

// mayOpen says whether the caller may read a complete file.
func (s *Server) mayOpen(ctx context.Context, d pdb.DBTX, c *call, row upload.Row) (bool, error) {
	floor, visible, err := canSee(ctx, d, c.p, row.ConversationID)
	switch {
	case err != nil || !visible:
		return false, err
	case row.MessageID == 0:
		return row.UploaderID == c.p.Identity(), nil
	}
	return row.MessageID > floor, nil
}

// avatar is GET /api/identities/:id/avatar.svg: the cleaned SVG an identity set, served so it can only draw (I-32).
func (s *Server) avatar(w http.ResponseWriter, r *http.Request, _ *call) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	svg, found, err := identity.Avatar(r.Context(), s.reader(), id)
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	if !found {
		writeErr(w, http.StatusNotFound, "not_found", "No avatar.")
		return
	}
	h := w.Header()
	h.Set("Content-Type", "image/svg+xml")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("Cache-Control", "private, no-cache")
	h.Set("ETag", `"`+strconv.Itoa(len(svg))+"-"+hex.EncodeToString([]byte(svg[:min(len(svg), 16)]))+`"`)
	_, _ = w.Write([]byte(svg))
}

// setAvatar applies the avatar_svg of PATCH /api/me/profile and returns where it is served ("" once removed). The SVG is rebuilt
// from an allow-list; a DOCTYPE, an ENTITY or anything that is not an svg is a 400 (I-32). It writes the refusal itself.
func (s *Server) setAvatar(w http.ResponseWriter, r *http.Request, c *call, raw json.RawMessage) (url string, ok bool) {
	var svg string
	if strings.TrimSpace(string(raw)) != "null" {
		var text string
		if json.Unmarshal(raw, &text) != nil {
			writeFieldErr(w, http.StatusBadRequest, "invalid_request", "avatar_svg", "The avatar is the SVG text.")
			return "", false
		}
		clean, err := upload.SanitizeAvatar(text)
		if err != nil {
			writeFieldErr(w, http.StatusBadRequest, "invalid_avatar", "avatar_svg", "The avatar must be a plain SVG: no DOCTYPE, no ENTITY, at most 4096 characters once cleaned.")
			return "", false
		}
		svg = clean
	}
	who := c.p.Identity()
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error { return identity.SetAvatar(ctx, tx.DBTX(), who, svg) })
	if err != nil {
		s.internalError(w, r, err)
		return "", false
	}
	s.Bus.Notify()
	if svg != "" {
		url = "/api/identities/" + strconv.FormatInt(who, 10) + "/avatar.svg"
	}
	return url, true
}
