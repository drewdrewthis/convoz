package httpapi

import (
	"context"
	"sync"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/event"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/inbox"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/transcript"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/upload"
)

// eventTranscribed is the event a finished transcript writes (design §8): ids only. Its frame is the message as it reads now.
const eventTranscribed = "upload.transcribed.v1"

// transcribePoll is how often the worker looks for a transcript that is due.
const transcribePoll = time.Second

var transcribers sync.Map // *Server -> struct{}: the servers whose worker runs

// startTranscriber runs the transcript worker of this server once. It takes the pending transcripts, oldest first, one at a time.
func (s *Server) startTranscriber() {
	if _, running := transcribers.LoadOrStore(s, struct{}{}); running {
		return
	}
	go func() {
		tick := time.NewTicker(transcribePoll)
		defer tick.Stop()
		for range tick.C {
			s.transcribeDue(context.Background())
		}
	}()
}

// transcribeDue works through every transcript that is due now.
func (s *Server) transcribeDue(ctx context.Context) {
	svc := files.Load()
	if svc == nil {
		return
	}
	for {
		job, ok, err := transcript.Next(ctx, s.reader(), s.Clock.Now())
		if err != nil || !ok {
			if err != nil {
				s.Log.Printf("transcripts: %v", err)
			}
			return
		}
		s.transcribeOne(ctx, svc, job)
	}
}

// transcribeOne hands one voice note to its engine and stores the outcome. A failure books another try, and after the last one
// marks the transcript failed; either way the inbox items held for the words are let go once they will not come.
func (s *Server) transcribeOne(ctx context.Context, svc *upload.Service, job transcript.Job) {
	text, up, err := s.transcribeAudio(ctx, svc, job)
	now := s.Clock.Now()
	werr := s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		if err != nil {
			gaveUp, rerr := transcript.Retry(ctx, d, now, job)
			if rerr != nil || !gaveUp {
				return rerr
			}
			return s.releaseVoice(ctx, d, now, up)
		}
		if err := transcript.Finish(ctx, d, now, job.UploadID, job.Engine, text); err != nil {
			return err
		}
		return s.announceTranscript(ctx, d, now, up)
	})
	if werr != nil {
		s.Log.Printf("transcript of upload %d: %v", job.UploadID, werr)
		return
	}
	if err != nil {
		s.Log.Printf("transcript of upload %d (try %d): %v", job.UploadID, job.Attempts+1, err)
	}
	s.Bus.Notify()
}

// transcribeAudio decrypts the note into the engine. The audio is read once and never lands on disk in the clear (I-27).
func (s *Server) transcribeAudio(ctx context.Context, svc *upload.Service, job transcript.Job) (string, upload.Row, error) {
	up, found, err := upload.ByID(ctx, s.reader(), job.UploadID)
	if err != nil {
		return "", up, err
	}
	engine, ok := transcript.Lookup(job.Engine)
	if !found || !ok {
		return "", up, transcript.ErrNoEngine
	}
	rd, err := svc.Blobs.Open(up)
	if err != nil {
		return "", up, err
	}
	defer rd.Close()
	text, err := engine.Transcribe(ctx, rd, up.Mime)
	return text, up, err
}

// announceTranscript is what a finished transcript changes: the search entry gets the words, the held inbox items are let go and
// readers are told. All in the transaction of the transcript.
func (s *Server) announceTranscript(ctx context.Context, d pdb.DBTX, now time.Time, up upload.Row) error {
	m, found, err := message.Get(ctx, d, up.MessageID)
	if err != nil || !found {
		return err
	}
	if err := (searchPort{}).IndexMessage(ctx, d, now, m); err != nil {
		return err
	}
	if err := s.releaseVoice(ctx, d, now, up); err != nil {
		return err
	}
	_, err = event.Write(ctx, d, now, event.Entry{Type: eventTranscribed, Conversation: up.ConversationID, Message: up.MessageID,
		Payload: map[string]any{"id": up.MessageID, "upload": up.PublicID}})
	return err
}

// releaseVoice lets the inbox items that waited for a voice note be claimed (E-5).
func (s *Server) releaseVoice(ctx context.Context, d pdb.DBTX, now time.Time, up upload.Row) error {
	if up.MessageID == 0 {
		return nil
	}
	return inbox.ReleaseVoice(ctx, d, now, up.ConversationID, up.MessageID)
}
