//go:build testhooks

package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/authz"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/message"
	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/testroutes"
)

func init() { moduleHooks = append(moduleHooks, registerMessageHooks) }

func registerMessageHooks(mux *http.ServeMux, s *Server) {
	mux.HandleFunc("POST "+testroutes.SystemLine, func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Conversation int64  `json:"conversation"`
			T            string `json:"t"`
			Identity     string `json:"identity"`
			By           string `json:"by"`
			Via          string `json:"via"`
			History      string `json:"history"`
			Reason       string `json:"reason"`
			Streak       int    `json:"streak"`
		}
		if json.NewDecoder(r.Body).Decode(&in) != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		var id int64
		err := s.Store.Writer.Tx(r.Context(), func(ctx context.Context, tx *pdb.Tx) error {
			dir, err := loadDirectory(ctx, tx.DBTX())
			if err != nil {
				return err
			}
			idOf := func(handle string) int64 {
				for k, e := range dir {
					if e.Handle == handle {
						return k
					}
				}
				return 0
			}
			line := message.SystemLine{T: in.T, Identity: idOf(in.Identity), By: idOf(in.By), Via: in.Via, History: in.History, Reason: in.Reason, Streak: in.Streak}
			m, err := message.WriteSystem(ctx, tx.DBTX(), messagePorts(authz.Principal{}), s.Clock.Now(), in.Conversation, line)
			id = m.ID
			return err
		})
		if err == nil {
			s.Bus.Notify()
		}
		reply(w, err, map[string]int64{"id": id})
	})
	mux.HandleFunc("POST "+testroutes.MessageBudget, func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Machine int64 `json:"machine"`
			Count   int   `json:"count"`
		}
		if json.NewDecoder(r.Body).Decode(&in) != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		now := s.Clock.Now()
		for range in.Count {
			s.dayMachineLimit.Allow(strconv.FormatInt(in.Machine, 10), now)
		}
		reply(w, nil, nil)
	})
	mux.HandleFunc("POST "+testroutes.Project, func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Message message.Projectable `json:"message"`
		}
		if json.NewDecoder(r.Body).Decode(&in) != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		reply(w, nil, map[string]string{"short": message.Project(in.Message, message.Short), "long": message.Project(in.Message, message.Long)})
	})
}
