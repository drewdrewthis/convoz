//go:build !testhooks

package httpapi

import "net/http"

func registerTestHooks(*http.ServeMux, *Server) {}
