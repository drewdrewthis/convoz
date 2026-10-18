package notify

import (
	"crypto/ecdh"
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A push service reads the VAPID token: this fake captures it and refuses a sub that Apple would refuse.
func TestPostSendsAValidVAPIDSubjectAndAudience(t *testing.T) {
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		claims, err := VAPIDClaims(auth)
		if err != nil {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		if sub, _ := claims["sub"].(string); !ValidVAPIDSubject(sub) {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	keys, err := NewKeys([]byte("TESTONLY-vapid-seed"), []byte("TESTONLY-topic-key"))
	if err != nil {
		t.Fatal(err)
	}
	device, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{Keys: keys, Client: srv.Client(), Subject: "push@host.ts.net"}
	status, _, err := s.post(t.Context(), srv.URL+"/push/TESTONLY", device.PublicKey().Bytes(), make([]byte, 16), Payload{V: 1, Reason: "test", Title: "t", Body: "b", URL: "/", Topic: "x"}, false, 60)
	if err != nil {
		t.Fatal(err)
	}
	if status != http.StatusCreated {
		t.Fatalf("the push service refused the token: status %d", status)
	}
	claims, err := VAPIDClaims(auth)
	if err != nil {
		t.Fatal(err)
	}
	if claims["sub"] != "mailto:push@host.ts.net" {
		t.Fatalf("sub = %v, want mailto:push@host.ts.net", claims["sub"])
	}
	if claims["aud"] != srv.URL {
		t.Fatalf("aud = %v, want %s", claims["aud"], srv.URL)
	}
	if exp, _ := claims["exp"].(float64); exp <= float64(time.Now().Unix()) {
		t.Fatalf("exp %v is not in the future", claims["exp"])
	}
}

func TestValidVAPIDSubject(t *testing.T) {
	for sub, want := range map[string]bool{
		"mailto:push@host.ts.net":           true,
		"https://host.ts.net/contact":       true,
		"mailto:mailto:push@host.ts.net:80": false,
		"mailto:push@host.ts.net:8473":      false,
		"push@host.ts.net":                  false,
		"":                                  false,
	} {
		if got := ValidVAPIDSubject(sub); got != want {
			t.Errorf("ValidVAPIDSubject(%q) = %v, want %v", sub, got, want)
		}
	}
}
