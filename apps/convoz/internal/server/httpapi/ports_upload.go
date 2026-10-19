package httpapi

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/appschema"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/appkit"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/settings"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/transcript"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/upload"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// files is the server's upload service, which the message ports (built per request, without a Server) reach. One server lives per
// process; a server without one (a test that never uploads) leaves it nil and the ports skip the files on disk.
var files atomic.Pointer[upload.Service]

// uploadPort binds the uploads a message carries (I-31), and ends them with the message (E-16, I-49).
type uploadPort struct{}

func (uploadPort) BindUploads(ctx context.Context, d pdb.DBTX, now time.Time, m message.Message, ids []string) error {
	bound, err := upload.Bind(ctx, d, now, upload.BindArgs{MessageID: m.ID, ConversationID: m.ConversationID, Author: m.AuthorID, PublicIDs: ids, AppIDs: appUploadIDs(m.App)})
	if err != nil {
		return err
	}
	engine := transcriptionEngine(ctx, d)
	for _, b := range bound {
		if b.Audio && engine != transcript.None {
			if err := transcript.Enqueue(ctx, d, now, b.ID, engine); err != nil {
				return err
			}
		}
	}
	return nil
}

func (uploadPort) MessageDeleted(ctx context.Context, d pdb.DBTX, _ time.Time, m message.Message) error {
	return dropUploads(ctx, d, m.ID)
}

func (uploadPort) MessagePurged(ctx context.Context, d pdb.DBTX, _ time.Time, m message.Message) error {
	return dropUploads(ctx, d, m.ID)
}

// dropUploads deletes the files of a message: the rows (and so their transcripts) go in the transaction, the sealed files at once.
func dropUploads(ctx context.Context, d pdb.DBTX, messageID int64) error {
	names, err := upload.RemoveOfMessage(ctx, d, messageID)
	if err != nil {
		return err
	}
	if svc := files.Load(); svc != nil {
		svc.Remove(names...)
	}
	return nil
}

// transcriptionEngine is the workspace setting transcription.engine: "none" is off, "auto" (the default) is the engine the server was
// started with (--transcribe), "none" when it has no key, and any other value names an engine.
func transcriptionEngine(ctx context.Context, d pdb.DBTX) string {
	all, err := settings.All(ctx, d, 0)
	if err != nil {
		return transcript.None
	}
	for _, e := range all {
		if e.Key == "transcription.engine" {
			if name, ok := e.Value.(string); ok {
				if name == "auto" {
					return transcript.Default()
				}
				return name
			}
		}
	}
	return transcript.None
}

// attachment is an upload of a message with the words of its transcript, if it has one.
type attachment struct {
	upload.Attached
	Transcript *transcript.Of
}

func (a attachment) wire() wire.Upload {
	u := wire.Upload{ID: a.PublicID, Kind: a.Kind, Name: a.Name, Size: a.Size, Mime: a.Mime, Inline: a.Inline, Width: a.Width, Height: a.Height, DurationMS: a.DurationMS}
	for _, p := range a.Waveform {
		u.Waveform = append(u.Waveform, int(p))
	}
	if a.Transcript != nil {
		u.Transcript = &wire.Transcript{State: a.Transcript.State, Text: a.Transcript.Text, RedoFailed: a.Transcript.RedoFailed}
	}
	return u
}

// attachmentsOf reads the files and transcripts of the given messages, by message id.
func attachmentsOf(ctx context.Context, d pdb.DBTX, messageIDs []int64) (map[int64][]attachment, error) {
	ups, err := upload.OfMessages(ctx, d, messageIDs)
	if err != nil || len(ups) == 0 {
		return nil, err
	}
	ids := make([]int64, len(ups))
	for i, u := range ups {
		ids[i] = u.ID
	}
	words, err := transcript.ForUploads(ctx, d, ids)
	if err != nil {
		return nil, err
	}
	out := map[int64][]attachment{}
	for _, u := range ups {
		a := attachment{Attached: u}
		if t, ok := words[u.ID]; ok {
			a.Transcript = &t
		}
		out[u.MessageID] = append(out[u.MessageID], a)
	}
	return out, nil
}

// projection is a message's files and transcript in the form the plain-text projection reads.
func projection(list []attachment) (uploads []message.Upload, words string) {
	for _, a := range list {
		uploads = append(uploads, message.Upload{Kind: a.Kind, Name: a.Name, Size: a.Size, DurationMS: a.DurationMS})
		if a.Transcript != nil && a.Transcript.State == transcript.Done {
			words = a.Transcript.Text
		}
	}
	return uploads, words
}

// transcribing is true while an engine still works on a voice note of the list.
func transcribing(list []attachment) bool {
	for _, a := range list {
		if a.Transcript != nil && a.Transcript.State == transcript.Pending {
			return true
		}
	}
	return false
}

// attachUploads puts the files of each message on the page, and the plain-text form of a message that carries any. A tombstone has none.
func attachUploads(ctx context.Context, d pdb.DBTX, msgs []*wire.Message) error {
	var ids []int64
	for _, m := range msgs {
		if m.ID != 0 && !m.Deleted && m.Kind != "system" {
			ids = append(ids, m.ID)
		}
	}
	by, err := attachmentsOf(ctx, d, ids)
	if err != nil || len(by) == 0 {
		return err
	}
	for _, m := range msgs {
		list := by[m.ID]
		if len(list) == 0 {
			continue
		}
		for _, a := range list {
			m.Uploads = append(m.Uploads, a.wire())
		}
		ups, words := projection(list)
		m.Text = message.Project(message.Projectable{Format: m.Format, Body: m.Body, Uploads: ups, Transcript: words}, message.Long)
		if words == "" && transcribing(list) {
			m.Text += " (transcribing…)"
		}
	}
	return nil
}

// attachSlice is attachUploads for a page.
func attachSlice(ctx context.Context, d pdb.DBTX, page []wire.Message) error {
	ptrs := make([]*wire.Message, len(page))
	for i := range page {
		ptrs[i] = &page[i]
	}
	return attachUploads(ctx, d, ptrs)
}

// appUploadIDs are the uploads the app of a message names.
func appUploadIDs(raw []byte) []string {
	if len(raw) == 0 {
		return nil
	}
	a, issue := appschema.Check(raw)
	if issue != nil {
		return nil
	}
	return appkit.UploadIDs(a)
}
