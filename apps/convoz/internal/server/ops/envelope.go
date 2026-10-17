package ops

import (
	"errors"
	"io"
	"os"
	"strings"

	"filippo.io/age"
)

// errDecrypt is every failure of the envelope: a wrong identity, a changed byte and a cut-off file look the same.
var errDecrypt = errors.New("cannot decrypt the backup")

// newSealWriter returns a writer that age-encrypts to the X25519 recipient in recipientFile. Close finishes the stream.
func newSealWriter(out io.Writer, recipientFile string) (io.WriteCloser, error) {
	rcpt, err := readRecipient(recipientFile)
	if err != nil {
		return nil, err
	}
	return age.Encrypt(out, rcpt)
}

// openReader returns a reader of the plaintext, decrypted with the age identity in identityFile.
// Header and payload failures are errDecrypt.
func openReader(in io.Reader, identityFile string) (io.Reader, error) {
	id, err := readIdentity(identityFile)
	if err != nil {
		return nil, err
	}
	r, err := age.Decrypt(in, id)
	if err != nil {
		return nil, errDecrypt
	}
	return decryptErrors{r}, nil
}

// decryptErrors turns a failed payload chunk into errDecrypt.
type decryptErrors struct{ io.Reader }

func (d decryptErrors) Read(p []byte) (int, error) {
	n, err := d.Reader.Read(p)
	if err != nil && !errors.Is(err, io.EOF) {
		return n, errDecrypt
	}
	return n, err
}

func readRecipient(path string) (*age.X25519Recipient, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return age.ParseX25519Recipient(strings.TrimSpace(string(raw)))
}

func readIdentity(path string) (*age.X25519Identity, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return age.ParseX25519Identity(strings.TrimSpace(string(raw)))
}
