package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/audit"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/auth"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/conversation"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/ops"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// startExport is POST /api/me/export: one passkey check starts a job that gathers everything the caller can see.
func (s *Server) startExport(w http.ResponseWriter, r *http.Request, c *call) {
	var in struct{}
	if !decode(w, r, &in) {
		return
	}
	now := s.Clock.Now()
	err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
		d := tx.DBTX()
		if err := auth.ConsumeStepUp(ctx, d, c.stepUp, c.dev.ID, "data.export", nil, now); err != nil {
			return err
		}
		return audit.Write(ctx, d, now, audit.Entry{Actor: c.human.ID, Device: c.dev.ID, Action: "export.started", TargetKind: "identity", TargetID: c.human.ID})
	})
	if errors.Is(err, auth.ErrStepUp) {
		stepUpInvalid(w)
		return
	}
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	p := c.p
	id, err := s.exports.Start(s.Clock, c.human.ID, func() ([]ops.File, error) { return s.exportFiles(context.Background(), p, s.Clock.Now()) })
	if err != nil {
		s.internalError(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"id": id, "status": ops.ExportRunning})
}

// getExport is GET /api/me/export/:id: the job's state, or with ?download=1 the finished archive.
func (s *Server) getExport(w http.ResponseWriter, r *http.Request, c *call) {
	id := r.PathValue("id")
	state, data, found := s.exports.Get(s.Clock, c.human.ID, id)
	switch {
	case !found:
		writeErr(w, http.StatusNotFound, "not_found", "No such export.")
	case r.URL.Query().Get("download") == "1" && state == ops.ExportDone:
		h := w.Header()
		h.Set("Content-Type", "application/zip")
		h.Set("Content-Disposition", fmt.Sprintf(`attachment; filename="convoz-export-%s.zip"`, s.Clock.Now().UTC().Format("2006-01-02")))
		h.Set("Cache-Control", "no-store")
		_, _ = w.Write(data)
	case r.URL.Query().Get("download") == "1":
		writeErr(w, http.StatusConflict, "not_ready", "The export is not ready.")
	default:
		writeJSON(w, http.StatusOK, map[string]any{"id": id, "status": state, "size": len(data)})
	}
}

// exportFiles gathers the archive of p: manifest.json and one conversations/<id>.json per conversation p can see,
// each with its main-thread messages from the point p may see them.
func (s *Server) exportFiles(ctx context.Context, p authz.Principal, now time.Time) ([]ops.File, error) {
	d := s.reader()
	dir, err := loadDirectory(ctx, d)
	if err != nil {
		return nil, err
	}
	var list []conversation.Conversation
	if p.Role == "owner" {
		list, err = conversation.ListAll(ctx, d)
	} else {
		list, err = conversation.ListOf(ctx, d, p.Identity())
	}
	if err != nil {
		return nil, err
	}
	var files []ops.File
	messages := 0
	for _, cv := range list {
		floor, ok, err := canSee(ctx, d, p, cv.ID)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		view, err := conversationView(ctx, d, p, dir, cv, floor)
		if err != nil {
			return nil, err
		}
		msgs, err := allMessages(ctx, d, dir, cv.ID, floor)
		if err != nil {
			return nil, err
		}
		messages += len(msgs)
		raw, err := json.MarshalIndent(map[string]any{
			"id": cv.ID, "title": view.Title, "created_at": cv.CreatedAt, "participants": view.Participants, "messages": msgs,
		}, "", "  ")
		if err != nil {
			return nil, err
		}
		files = append(files, ops.File{Name: fmt.Sprintf("conversations/%d.json", cv.ID), Data: raw})
	}
	manifest, err := json.MarshalIndent(map[string]any{"format": "convoz-export-v1", "exported_at": now.UnixMilli(), "conversations": len(files), "messages": messages}, "", "  ")
	if err != nil {
		return nil, err
	}
	return append([]ops.File{{Name: "manifest.json", Data: manifest}}, files...), nil
}

// allMessages pages through the main thread of one conversation, oldest first.
func allMessages(ctx context.Context, d pdb.DBTX, dir directory, conv, floor int64) ([]wire.Message, error) {
	out := []wire.Message{}
	after := floor
	for {
		page, err := message.After(ctx, d, conv, after, floor, message.MaxPage)
		if err != nil {
			return nil, err
		}
		for _, m := range page {
			out = append(out, dir.message(m))
		}
		if len(page) < message.MaxPage {
			return out, nil
		}
		after = page[len(page)-1].ID
	}
}
