// Package ops is a server module (design §4.2). Ops is backup, restore, export, delete, purge, key rotation and nightly maintenance. It owns no table.
//
// A backup (design §14) is one file:
//
//	"CONVOZ-BACKUP-1\n" | ed25519ph signature (64 bytes) | age ciphertext of a tar (convoz.db snapshot, keyring.json, blobs/)
//
// The age ciphertext is made for an X25519 recipient (filippo.io/age). The signature covers the magic and the
// ciphertext, so restore checks it before it decrypts a byte.
package ops
