// Package upload is a server module (design §4.2). Upload owns uploads: resumable uploads, encrypted segments, quotas and file serving.
//
// A file reaches the server in chunks (tus-like, design §12.3). The server keeps at most one partial segment of it in memory
// and writes every whole 1 MB segment to <data dir>/blobs/ sealed with AES-256-GCM under a random per-file key, which the
// keyring's blob DEK wraps (I-27). No plaintext of a file ever touches the disk, a resumable upload included. A segment's AAD is
// the upload's public id, its index and whether it is the last one, so a blob moved to another file id, a reordered segment and
// a truncated file all fail to open.
//
// The offset a client resumes from is what the server holds now: the sealed segments plus the partial one in memory. After a
// restart the memory is gone and the offset falls back to the last whole segment, which the database keeps (committed_bytes).
//
// A length the client does not know yet (a voice note still recording) is declared by leaving the size out. The row then holds the
// size cap and an all-zero checksum until the last chunk says how long the file is.
package upload
