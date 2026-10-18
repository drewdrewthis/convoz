package httpapi

import (
	"context"
	"errors"
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
		ctx := context.Background()
		var seen string // the engine of the last look: a change from "none" to an engine is what starts a backfill
		more := false
		for range tick.C {
			now := s.currentEngine(ctx)
			if now != seen || more {
				more = s.backfillTranscripts(ctx, now) == backfillBatch
				seen = now
			}
			s.transcribeDue(ctx)
		}
	}()
}

// backfillBatch is how many old voice notes one pass queues; the worker takes them one at a time, so the queue never floods.
const backfillBatch = 20

// currentEngine is the engine the workspace setting picks right now, "none" when off or when the build has no such engine.
func (s *Server) currentEngine(ctx context.Context) string {
	name := transcriptionEngine(ctx, s.reader())
	if _, ok := transcript.Lookup(name); !ok {
		return transcript.None
	}
	return name
}

// backfillTranscripts queues, oldest first, up to backfillBatch stored voice notes that have no transcript row (they were sent while
// no engine was on), through the same queue as a new note. It is idempotent: a note with a row is skipped. It reports how many it
// queued and logs only that count.
func (s *Server) backfillTranscripts(ctx context.Context, engine string) int {
	if engine == transcript.None {
		return 0
	}
	queued := 0
	err := s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		var cursor int64
		for queued < backfillBatch {
			ids, err := upload.BoundAudioAfter(ctx, d, cursor, backfillBatch)
			if err != nil || len(ids) == 0 {
				return err
			}
			cursor = ids[len(ids)-1]
			have, err := transcript.ForUploads(ctx, d, ids)
			if err != nil {
				return err
			}
			for _, id := range ids {
				if _, ok := have[id]; ok || queued == backfillBatch {
					continue
				}
				if err := transcript.Enqueue(ctx, d, s.Clock.Now(), id, engine); err != nil {
					return err
				}
				queued++
			}
		}
		return nil
	})
	if err != nil {
		s.Log.Printf("transcript backfill: %v", err)
		return 0
	}
	if queued > 0 {
		s.Log.Printf("transcript backfill: queued %d", queued)
	}
	return queued
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
	text, engineName, up, err := s.transcribeAudio(ctx, svc, job)
	now := s.Clock.Now()
	werr := s.Store.Writer.Tx(ctx, func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		if errors.Is(err, transcript.ErrBadAudio) { // no engine will take this file, so a retry would only repeat it
			if gerr := transcript.GiveUp(ctx, d, now, job); gerr != nil {
				return gerr
			}
			return s.releaseVoice(ctx, d, now, up)
		}
		if err != nil {
			gaveUp, rerr := transcript.Retry(ctx, d, now, job)
			if rerr != nil || !gaveUp {
				return rerr
			}
			return s.releaseVoice(ctx, d, now, up)
		}
		if err := transcript.Finish(ctx, d, now, job.UploadID, engineName, text); err != nil {
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

// transcribeAudio decrypts the note into the engine. The audio is read once and never lands on disk in the clear (I-27). It returns
// the name of the engine that answered: the job's, unless the engine is a chain that says which of its own did.
func (s *Server) transcribeAudio(ctx context.Context, svc *upload.Service, job transcript.Job) (text, engineName string, up upload.Row, err error) {
	up, found, err := upload.ByID(ctx, s.reader(), job.UploadID)
	if err != nil {
		return "", "", up, err
	}
	engine, ok := transcript.Lookup(job.Engine)
	if !found || !ok {
		return "", "", up, transcript.ErrNoEngine
	}
	rd, err := svc.Blobs.Open(up)
	if err != nil {
		return "", "", up, err
	}
	defer rd.Close()
	if a, ok := engine.(transcript.Attributing); ok {
		text, engineName, err = a.TranscribeAs(ctx, rd, up.Mime)
	} else {
		engineName = job.Engine
		text, err = engine.Transcribe(ctx, rd, up.Mime)
	}
	return text, engineName, up, err
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
