package upload

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"slices"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/upload/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// Limits (design §13.1).
const (
	// SegmentSize is the plaintext size of one sealed segment.
	SegmentSize = 1 << 20
	// MaxSize is the biggest file: 25 MiB. It is also the cap of an upload whose length is not known yet.
	MaxSize = 26214400
	// MaxAppBytes is the biggest app bundle.
	MaxAppBytes = 524288
	// MaxPixels and MaxSide bound an image before anything decodes it (I-44).
	MaxPixels = 40_000_000
	MaxSide   = 16384
	// MaxWaveform is the number of peaks a voice note carries.
	MaxWaveform = 64
	// MaxDurationMS is the longest voice note: 30 minutes (the column's check, migration 0044). At the recorder's 32 kbit/s that is
	// about 7 MB, well under MaxSize.
	MaxDurationMS = 1_800_000
	// QuotaIdentityDay and QuotaMachineDay are the bytes one identity and one machine may start in a day.
	QuotaIdentityDay = 500 << 20
	QuotaMachineDay  = 2 << 30
	// MaxInFlight is how many chunks of one identity are received at the same time.
	MaxInFlight = 4
	// UnboundTTL is how long an upload nobody bound to a message lives.
	UnboundTTL = 24 * time.Hour
	// dekGeneration is the generation of the keyring blob DEK that wraps the file keys (the column is for a later rewrap).
	dekGeneration = 1
)

// Kinds of upload.
const (
	KindAudio = "audio"
	KindImage = "image"
	KindFile  = "file"
	// KindApp is a Tier-2 app bundle: one UTF-8 HTML document, served only by the frame route.
	KindApp = "app"
)

// Errors the HTTP layer maps to an answer.
var (
	ErrNotFound      = errors.New("no such upload")
	ErrBadRequest    = errors.New("the upload is not valid")
	ErrQuota         = errors.New("the daily upload limit is reached")
	ErrTooLarge      = errors.New("the upload is bigger than its declared size")
	ErrImageTooLarge = errors.New("image too large")
	ErrChecksum      = errors.New("the file does not match its checksum")
	ErrComplete      = errors.New("the upload is complete")
	ErrCorrupt       = errors.New("the stored file cannot be read")
	// ErrBound means the upload belongs to a message already (I-31): answered 409.
	ErrBound = errors.New("the upload is already part of a message")
	// ErrUnfinished means the upload is not complete: answered 409.
	ErrUnfinished = errors.New("the upload is not finished")
	// ErrNotYours means the upload is unknown, another identity's, or another conversation's: answered 400.
	ErrNotYours = errors.New("that upload cannot be used in this message")
	// ErrAudioAlone means a voice note shares its message with another file: answered 400.
	ErrAudioAlone = errors.New("a voice note is the only file of its message")
)

// OffsetError says the chunk did not start where the server is.
type OffsetError struct{ Have int64 }

func (e *OffsetError) Error() string {
	return "the chunk does not start at the offset the server holds"
}

// Row is an upload as the module reads it.
type Row struct {
	ID, UploaderID, SessionID, ConversationID, MessageID int64
	PublicID, Kind, State, Mime, Filename, StorageName   string
	DeclaredSize, Committed                              int64
	Deferred                                             bool // the length is not known yet
	SHA256                                               []byte
	Inline                                               bool
	KeyWrapped                                           []byte
	Width, Height, DurationMS                            int64
	Waveform                                             []byte
	CreatedAt                                            int64
}

// Complete reports whether every byte has arrived and the file was checked.
func (r Row) Complete() bool { return r.State == "complete" }

func nullInt(v int64) sql.NullInt64 { return sql.NullInt64{Int64: v, Valid: v != 0} }

func rowOf(r db.GetUploadByPublicIDRow) Row {
	return Row{
		ID: r.ID, PublicID: r.PublicID, UploaderID: r.UploaderID, SessionID: r.SessionID.Int64, ConversationID: r.ConversationID, MessageID: r.MessageID.Int64,
		Kind: r.Kind, State: r.State, DeclaredSize: r.DeclaredSize, Committed: r.CommittedBytes, SHA256: r.DeclaredSha256, Mime: r.MimeSniffed.String, Inline: r.ServeInline == 1,
		Filename: r.Filename, StorageName: r.StorageName, KeyWrapped: r.FileKeyWrapped, Width: r.Width.Int64, Height: r.Height.Int64, DurationMS: r.DurationMs.Int64,
		Waveform: r.Waveform, CreatedAt: r.CreatedAt, Deferred: r.State == "receiving" && allZero(r.DeclaredSha256),
	}
}

func allZero(b []byte) bool {
	for _, c := range b {
		if c != 0 {
			return false
		}
	}
	return true
}

// ByPublicID reads an upload by the id clients know.
func ByPublicID(ctx context.Context, d pdb.DBTX, publicID string) (Row, bool, error) {
	r, err := db.New(d).GetUploadByPublicID(ctx, publicID)
	if errors.Is(err, sql.ErrNoRows) {
		return Row{}, false, nil
	}
	return rowOf(r), err == nil, err
}

// ByID reads an upload by its row id.
func ByID(ctx context.Context, d pdb.DBTX, id int64) (Row, bool, error) {
	r, err := db.New(d).GetUpload(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return Row{}, false, nil
	}
	return rowOf(db.GetUploadByPublicIDRow(r)), err == nil, err
}

// NewRequest is what a client says when it starts an upload.
type NewRequest struct {
	Uploader, Session, Conversation int64
	Kind, Filename                  string
	ClientID                        string // names the request: a retry with the same one gets the first upload back; "" for none
	Size                            int64  // 0 for a length not known yet
	SHA256                          []byte // nil when the length is not known
}

// ValidKind reports whether k is a kind a client may ask for.
func ValidKind(k string) bool {
	return k == KindAudio || k == KindImage || k == KindFile || k == KindApp
}

// Create starts an upload: the daily byte quota of the identity (I-31) is checked first, then the row is written. The file is
// created with the first segment. machineUsed is what the caller's machine started today, counted by the service.
func (s *Service) Create(ctx context.Context, d pdb.DBTX, now time.Time, in NewRequest, machine int64) (Row, error) {
	if !ValidKind(in.Kind) || in.Filename == "" || len(in.Filename) > 255 || in.Size < 0 || in.Size > MaxSize || (in.Size > 0 && len(in.SHA256) != 32) {
		return Row{}, ErrBadRequest
	}
	q := db.New(d)
	if in.ClientID != "" {
		if !wire.ValidClientID(in.ClientID) {
			return Row{}, ErrBadRequest
		}
		if r, found, err := replayOf(ctx, d, in); found || err != nil {
			return r, err
		}
	}
	limit := int64(MaxSize)
	if in.Kind == KindApp {
		limit = MaxAppBytes
	}
	if in.Size > limit {
		return Row{}, ErrTooLarge
	}
	size, sum := in.Size, in.SHA256
	if size == 0 {
		size, sum = limit, make([]byte, 32) // the cap now, the real length with the last chunk
	}
	used, err := q.SumUploadedSince(ctx, db.SumUploadedSinceParams{UploaderID: in.Uploader, Since: now.Add(-24 * time.Hour).UnixMilli()})
	if err != nil {
		return Row{}, err
	}
	if in.Size > 0 && used+in.Size > QuotaIdentityDay || used >= QuotaIdentityDay || (machine != 0 && !s.machineBudget.take(machine, now, in.Size)) {
		return Row{}, ErrQuota
	}
	pub, err := newPublicID()
	if err != nil {
		return Row{}, err
	}
	_, wrapped, err := s.Blobs.newFileKey(pub)
	if err != nil {
		return Row{}, err
	}
	storage, err := newStorageName()
	if err != nil {
		return Row{}, err
	}
	if beforeInsert != nil {
		beforeInsert()
	}
	id, err := q.InsertUpload(ctx, db.InsertUploadParams{
		PublicID: pub, UploaderID: in.Uploader, SessionID: nullInt(in.Session), ConversationID: in.Conversation, Kind: in.Kind,
		DeclaredSize: size, DeclaredSha256: sum, Filename: in.Filename, StorageName: storage, DekID: dekGeneration, FileKeyWrapped: wrapped, CreatedAt: now.UnixMilli(),
		ClientID: sql.NullString{String: in.ClientID, Valid: in.ClientID != ""},
	})
	if err != nil && in.ClientID != "" && pdb.IsUniqueViolation(err) { // a start of the same client id got in between: it is the first one
		if r, found, rerr := replayOf(ctx, d, in); found || rerr != nil {
			return r, rerr
		}
	}
	if err != nil {
		return Row{}, err
	}
	r, _, err := ByID(ctx, d, id)
	return r, err
}

// beforeInsert is a seam for a test: it runs between the look-up of the client id and the insert. It is a package variable: a test
// that sets it must not run in parallel (no t.Parallel()), or it would hit the other tests' uploads.
var beforeInsert func()

// replayOf finds the upload this identity already started under the request's client id. found is false when there is none. It is
// ErrBadRequest when the request differs from the first one in anything it asks (conversation, kind, name, size or checksum): one
// client id names one upload.
func replayOf(ctx context.Context, d pdb.DBTX, in NewRequest) (Row, bool, error) {
	first, err := db.New(d).UploadOfClientID(ctx, db.UploadOfClientIDParams{UploaderID: in.Uploader, ClientID: sql.NullString{String: in.ClientID, Valid: true}})
	if errors.Is(err, sql.ErrNoRows) {
		return Row{}, false, nil
	}
	if err != nil {
		return Row{}, false, err
	}
	r, _, err := ByID(ctx, d, first.ID)
	if err != nil {
		return Row{}, false, err
	}
	same := r.ConversationID == in.Conversation && r.Kind == in.Kind && r.Filename == in.Filename
	if in.Size == 0 {
		same = same && allZero(r.SHA256) // a start with no length keeps the zero checksum
	} else {
		same = same && !allZero(r.SHA256) && r.DeclaredSize == in.Size && bytes.Equal(r.SHA256, in.SHA256)
	}
	if !same {
		return Row{}, true, ErrBadRequest
	}
	return r, true, nil
}

// newPublicID is 128 random bits as 22 URL-safe characters: the id in URLs and in each segment's AAD.
// It never starts with "-": a command line would read such an id as a flag.
func newPublicID() (string, error) {
	b := make([]byte, 16)
	for {
		if _, err := rand.Read(b); err != nil {
			return "", err
		}
		if id := base64.RawURLEncoding.EncodeToString(b); id[0] != '-' {
			return id, nil
		}
	}
}

func newStorageName() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// SetCommitted records how many whole segments are sealed. It never moves backwards.
func SetCommitted(ctx context.Context, d pdb.DBTX, id, committed int64) error {
	return db.New(d).SetCommitted(ctx, db.SetCommittedParams{ID: id, CommittedBytes: committed})
}

// Finish stores the checked facts of a complete file.
func Finish(ctx context.Context, d pdb.DBTX, now time.Time, id int64, f Finished) error {
	return db.New(d).CompleteUpload(ctx, db.CompleteUploadParams{
		ID: id, Kind: f.Kind, Size: f.Size, Mime: sql.NullString{String: f.Mime, Valid: true}, ServeInline: boolInt(f.Inline),
		Width: nullInt(f.Width), Height: nullInt(f.Height), DurationMs: nullInt(f.DurationMS), Waveform: f.Waveform, Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true},
	})
}

func boolInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

// Delete removes an upload row (its file is the service's to unlink).
func Delete(ctx context.Context, d pdb.DBTX, id int64) error { return db.New(d).DeleteUpload(ctx, id) }

// BindArgs is the message the uploads join.
type BindArgs struct {
	MessageID, ConversationID, Author int64
	PublicIDs                         []string
	// AppIDs are the ones of PublicIDs that belong to the message's app: they are bound as its files, not shown as files of the message.
	AppIDs []string
}

// Bound is an upload now part of a message.
type Bound struct {
	ID    int64
	Kind  string
	Mime  string
	Name  string
	Size  int64
	Audio bool
}

// Bind joins the uploads to the message, once and only by their uploader, in their own conversation and when complete (I-31).
// An audio upload is the only upload of its message. It runs inside the post's transaction, so one bad id undoes the post.
func Bind(ctx context.Context, d pdb.DBTX, now time.Time, a BindArgs) ([]Bound, error) {
	q := db.New(d)
	out := make([]Bound, 0, len(a.PublicIDs))
	seen := map[string]bool{}
	for i, pub := range a.PublicIDs {
		at := now.Add(time.Duration(i) * time.Millisecond) // bound_at carries the order the files were sent in
		if seen[pub] {
			return nil, ErrNotYours
		}
		seen[pub] = true
		r, found, err := ByPublicID(ctx, d, pub)
		switch {
		case err != nil:
			return nil, err
		case !found || r.UploaderID != a.Author || r.ConversationID != a.ConversationID:
			return nil, ErrNotYours
		case r.MessageID != 0:
			return nil, ErrBound
		case !r.Complete():
			return nil, ErrUnfinished
		}
		var n int64
		if slices.Contains(a.AppIDs, pub) {
			n, err = q.BindAppUpload(ctx, db.BindAppUploadParams(bindArgs(a.MessageID, at, r.ID)))
		} else {
			n, err = q.BindUpload(ctx, db.BindUploadParams(bindArgs(a.MessageID, at, r.ID)))
		}
		if err != nil {
			return nil, err
		} else if n == 0 {
			return nil, ErrBound
		}
		out = append(out, Bound{ID: r.ID, Kind: r.Kind, Mime: r.Mime, Name: r.Filename, Size: r.DeclaredSize, Audio: r.Kind == KindAudio})
	}
	if len(out) > 1 {
		for _, b := range out {
			if b.Audio {
				return nil, ErrAudioAlone
			}
		}
	}
	return out, nil
}

type bindParams struct {
	MessageID sql.NullInt64
	Now       sql.NullInt64
	ID        int64
}

func bindArgs(message int64, now time.Time, id int64) bindParams {
	return bindParams{MessageID: nullInt(message), Now: sql.NullInt64{Int64: now.UnixMilli(), Valid: true}, ID: id}
}

// Attached is an upload of a message as a reader sees it.
type Attached struct {
	MessageID, ID                   int64
	PublicID, Kind, Mime, Name      string
	Size, Width, Height, DurationMS int64
	Inline                          bool
	Waveform                        []byte
}

// OfMessages lists the uploads of the given messages, in the order they were bound (the order they were sent in).
func OfMessages(ctx context.Context, d pdb.DBTX, messageIDs []int64) ([]Attached, error) {
	if len(messageIDs) == 0 {
		return nil, nil
	}
	ids := make([]sql.NullInt64, len(messageIDs))
	for i, id := range messageIDs {
		ids[i] = nullInt(id)
	}
	rows, err := db.New(d).UploadsOfMessages(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := make([]Attached, 0, len(rows))
	for _, r := range rows {
		out = append(out, Attached{
			MessageID: r.MessageID.Int64, ID: r.ID, PublicID: r.PublicID, Kind: r.Kind, Mime: r.MimeSniffed.String, Name: r.Filename, Size: r.DeclaredSize,
			Width: r.Width.Int64, Height: r.Height.Int64, DurationMS: r.DurationMs.Int64, Inline: r.ServeInline == 1, Waveform: r.Waveform,
		})
	}
	return out, nil
}

// RemoveOfMessage deletes the uploads of a message and returns the files to unlink. A delete or a purge of the message ends them (E-16, I-49);
// the transcript rows go with them (cascade).
func RemoveOfMessage(ctx context.Context, d pdb.DBTX, messageID int64) ([]string, error) {
	q := db.New(d)
	rows, err := q.StorageOfMessage(ctx, nullInt(messageID))
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(rows))
	for _, r := range rows {
		names = append(names, r.StorageName)
	}
	return names, q.DeleteUploadsOfMessage(ctx, nullInt(messageID))
}

// Expire deletes the uploads nobody bound within a day and returns their files to unlink.
func Expire(ctx context.Context, d pdb.DBTX, now time.Time) ([]string, error) {
	q := db.New(d)
	rows, err := q.ExpiredUploads(ctx, now.Add(-UnboundTTL).UnixMilli())
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(rows))
	for _, r := range rows {
		if err := q.DeleteUpload(ctx, r.ID); err != nil {
			return nil, err
		}
		names = append(names, r.StorageName)
	}
	return names, nil
}

// KnownFiles lists the storage names the database holds, for the sweep of files nothing points at.
func KnownFiles(ctx context.Context, d pdb.DBTX) (map[string]bool, error) {
	names, err := db.New(d).AllStorageNames(ctx)
	if err != nil {
		return nil, err
	}
	out := make(map[string]bool, len(names))
	for _, n := range names {
		out[n] = true
	}
	return out, nil
}

// BoundAudioAfter lists the ids of stored voice notes that belong to a message, oldest first, from the id after the cursor.
func BoundAudioAfter(ctx context.Context, d pdb.DBTX, after int64, limit int) ([]int64, error) {
	return db.New(d).BoundAudioAfter(ctx, db.BoundAudioAfterParams{AfterID: after, MaxRows: int64(limit)})
}
