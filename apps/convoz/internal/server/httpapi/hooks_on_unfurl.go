//go:build testhooks

package httpapi

import (
	"encoding/json"
	"net/http"
	"net/netip"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/testroutes"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/unfurl"
)

func init() { moduleHooks = append(moduleHooks, registerUnfurlHooks) }

func registerUnfurlHooks(mux *http.ServeMux, _ *Server) {
	mux.HandleFunc("POST "+testroutes.UnfurlFixture, func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Host     string `json:"host"`
			Target   string `json:"target"`
			Resolves string `json:"resolves"`
		}
		if json.NewDecoder(r.Body).Decode(&in) != nil || in.Host == "" || (in.Target == "") == (in.Resolves == "") {
			http.Error(w, "need host and one of target or resolves", http.StatusBadRequest)
			return
		}
		if in.Target != "" {
			unfurl.ServeFixture(in.Host, in.Target)
		} else {
			ip, err := netip.ParseAddr(in.Resolves)
			if err != nil {
				http.Error(w, "bad address", http.StatusBadRequest)
				return
			}
			unfurl.ResolveFixture(in.Host, ip)
		}
		reply(w, nil, nil)
	})
}
