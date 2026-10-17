package ops

import (
	"bytes"
	"errors"
	"io"
	"path/filepath"
	"testing"
)

func keysIn(t *testing.T) (recipient, identity string) {
	t.Helper()
	dir := t.TempDir()
	if err := GenerateBackupKeys(dir); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, RecipientFile), filepath.Join(dir, IdentityFile)
}

func seal(t *testing.T, recipient string, plain []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	w, err := newSealWriter(&buf, recipient)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(plain); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestEnvelopeRoundTrip(t *testing.T) {
	rcpt, id := keysIn(t)
	plain := bytes.Repeat([]byte("convoz"), 50_000)
	r, err := openReader(bytes.NewReader(seal(t, rcpt, plain)), id)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(r)
	if err != nil || !bytes.Equal(got, plain) {
		t.Fatalf("round trip failed: %v", err)
	}
}

func TestEnvelopeRefusesWrongIdentityAndChangedByte(t *testing.T) {
	rcpt, id := keysIn(t)
	_, other := keysIn(t)
	ct := seal(t, rcpt, bytes.Repeat([]byte("x"), 200_000))
	changed := append([]byte{}, ct...)
	changed[len(changed)-40] ^= 1
	for name, c := range map[string]struct {
		data []byte
		id   string
	}{"wrong identity": {ct, other}, "changed byte": {changed, id}, "cut": {ct[:len(ct)-80], id}} {
		r, err := openReader(bytes.NewReader(c.data), c.id)
		if err == nil {
			_, err = io.ReadAll(r)
		}
		if !errors.Is(err, errDecrypt) {
			t.Errorf("%s: got %v, want errDecrypt", name, err)
		}
	}
}
