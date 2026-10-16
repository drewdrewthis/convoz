package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"errors"
)

// KeyBox seals the recoverable copy of each machine key (I-25) with the machine_key DEK. The AAD binds a
// copy to its machine and key version, so a copy moved into another machine's row cannot be opened.
type KeyBox struct{ gcm cipher.AEAD }

// NewKeyBox builds a KeyBox from the 32-byte machine_key DEK.
func NewKeyBox(dek []byte) (*KeyBox, error) {
	block, err := aes.NewCipher(dek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &KeyBox{gcm: gcm}, nil
}

func keyAAD(machineID, version int64) []byte {
	out := []byte("convoz-machine-key-v1")
	out = binary.BigEndian.AppendUint64(out, uint64(machineID))
	return binary.BigEndian.AppendUint64(out, uint64(version))
}

// Seal returns nonce‖ciphertext‖tag.
func (b *KeyBox) Seal(machineID, version int64, key string) []byte {
	nonce := make([]byte, b.gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	return b.gcm.Seal(nonce, nonce, []byte(key), keyAAD(machineID, version))
}

// ErrKeyUnreadable means the stored copy does not open for this machine and key version.
var ErrKeyUnreadable = errors.New("the stored machine key cannot be read")

// Open returns the key sealed by Seal for the same machine and version.
func (b *KeyBox) Open(machineID, version int64, blob []byte) (string, error) {
	n := b.gcm.NonceSize()
	if len(blob) < n {
		return "", ErrKeyUnreadable
	}
	plain, err := b.gcm.Open(nil, blob[:n], blob[n:], keyAAD(machineID, version))
	if err != nil {
		return "", ErrKeyUnreadable
	}
	return string(plain), nil
}
