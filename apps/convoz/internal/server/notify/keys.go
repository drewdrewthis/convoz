package notify

import (
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"strconv"
)

// Keys is the secret material of push: the VAPID signing key (ES256) and the HMAC key of Topic values. Both come from the
// keyring (purposes vapid and push_topic), so a backup carries them (design §10.3).
type Keys struct {
	vapidPrivate string // base64url, the 32-byte scalar
	vapidPublic  string // base64url, the 65-byte uncompressed point
	topicKey     []byte
}

// NewKeys derives the VAPID key pair from the keyring's vapid key material and keeps the topic key.
// The scalar is HMAC(seed, counter): the first value the curve accepts, so the same keyring always gives the same key pair.
func NewKeys(vapidSeed, topicKey []byte) (Keys, error) {
	if len(vapidSeed) == 0 || len(topicKey) == 0 {
		return Keys{}, errors.New("push keys need the vapid and push_topic keys of the keyring")
	}
	for counter := uint32(0); counter < 64; counter++ {
		mac := hmac.New(sha256.New, vapidSeed)
		mac.Write([]byte("convoz vapid p256 scalar"))
		var c [4]byte
		binary.BigEndian.PutUint32(c[:], counter)
		mac.Write(c[:])
		scalar := mac.Sum(nil)
		priv, err := ecdh.P256().NewPrivateKey(scalar)
		if err != nil {
			continue // a scalar outside the curve order: about 1 in 2^32
		}
		return Keys{
			vapidPrivate: base64.RawURLEncoding.EncodeToString(scalar),
			vapidPublic:  base64.RawURLEncoding.EncodeToString(priv.PublicKey().Bytes()),
			topicKey:     topicKey,
		}, nil
	}
	return Keys{}, errors.New("no valid VAPID scalar")
}

// PublicKey is the VAPID public key a browser subscribes with (its applicationServerKey).
func (k Keys) PublicKey() string { return k.vapidPublic }

// Topic is the Web Push Topic of a thing: base64url(HMAC(push_topic_key, kind || id))[:22]. The push service sees a stable
// opaque value, never a sequential id (I-28). kind is 'a' for an ask, 'c' for a conversation, 't' for a thread, and so on.
func (k Keys) Topic(kind byte, id int64) string {
	mac := hmac.New(sha256.New, k.topicKey)
	mac.Write([]byte{kind})
	mac.Write([]byte(strconv.FormatInt(id, 10)))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))[:22]
}
