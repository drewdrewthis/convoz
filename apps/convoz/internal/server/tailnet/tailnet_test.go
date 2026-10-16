package tailnet

import (
	"errors"
	"testing"
)

func status(proxy, funnel string) []byte {
	return []byte(`{"TCP":{"443":{"HTTPS":true}},` + `"Web":{"convoz.testonly.ts.net:443":{"Handlers":{"/":{"Proxy":"` + proxy + `"}}}},"AllowFunnel":{"convoz.testonly.ts.net:443":` + funnel + `}}`)
}

func TestFunnelOn(t *testing.T) {
	cases := []struct {
		name   string
		doc    string
		target string
		want   bool
	}{
		{"funnel on, tcp target", string(status("http://127.0.0.1:41000", "true")), "127.0.0.1:41000", true},
		{"funnel on, localhost spelling", string(status("http://localhost:41000", "true")), "127.0.0.1:41000", true},
		{"funnel on, unix target", string(status("unix:/run/convoz/http.sock", "true")), "/run/convoz/http.sock", true},
		{"funnel on for another port", string(status("http://127.0.0.1:41001", "true")), "127.0.0.1:41000", false},
		{"funnel off for ours", string(status("http://127.0.0.1:41000", "false")), "127.0.0.1:41000", false},
		{"foreground session", `{"Foreground":{"s":` + string(status("http://127.0.0.1:41000", "true")) + `}}`, "127.0.0.1:41000", true},
		{"service", `{"Services":{"svc:x":` + string(status("http://127.0.0.1:41000", "true")) + `}}`, "127.0.0.1:41000", true},
		{"tcp forward", `{"TCP":{"443":{"TCPForward":"127.0.0.1:41000"}},"AllowFunnel":{"h.ts.net:443":true}}`, "127.0.0.1:41000", true},
		{"empty config", `{}`, "127.0.0.1:41000", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := funnelOn([]byte(c.doc), c.target)
			if got := errors.Is(err, ErrFunnelOn); got != c.want {
				t.Fatalf("funnel on = %v (err %v), want %v", got, err, c.want)
			}
		})
	}
	if err := funnelOn([]byte("not json"), "127.0.0.1:1"); err == nil || errors.Is(err, ErrFunnelOn) {
		t.Fatalf("unreadable status must be an error that is not ErrFunnelOn, got %v", err)
	}
}

func TestParseWhois(t *testing.T) {
	n, err := parseWhois([]byte(`{"Node":{"Name":"laptop-1.tailnet.ts.net.","Tags":["tag:dev"]},"UserProfile":{"LoginName":"x"}}`))
	if err != nil || n.Name != "laptop-1.tailnet.ts.net" || len(n.Tags) != 1 || n.Tags[0] != "tag:dev" {
		t.Fatalf("got %+v, %v", n, err)
	}
}
