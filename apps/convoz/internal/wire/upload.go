package wire

// CreateUploadRequest is POST /api/uploads. Size and SHA256 (hex) are left out for a file whose length is not known yet, a voice
// note still recording: the last PATCH then carries Upload-Length and Upload-Checksum.
type CreateUploadRequest struct {
	ConversationID int64  `json:"conversation_id"`
	Kind           string `json:"kind"` // audio, image, file or app: what the client believes; the server decides from the bytes (I-44)
	Filename       string `json:"filename"`
	Size           int64  `json:"size,omitempty"`
	SHA256         string `json:"sha256,omitempty"`
	// ClientID names the request: a retry after a lost answer gets the first upload back and no orphan row is made.
	ClientID string `json:"client_id,omitempty"`
}

// UploadState is where an upload stands: the answer to POST and PATCH /api/uploads.
type UploadState struct {
	ID    string `json:"id"` // the public id; bind it to a message with upload_ids
	State string `json:"state"`
	// Offset is where the next chunk starts: the whole segments sealed and the partial one the server holds.
	Offset int64  `json:"offset"`
	Size   int64  `json:"size,omitempty"` // known from the start, or once the last chunk came
	Kind   string `json:"kind"`
	Name   string `json:"name"`
	// Mime, Inline, Width, Height and DurationMS are set once the upload is complete and was checked.
	Mime       string `json:"mime,omitempty"`
	Inline     bool   `json:"inline,omitempty"`
	Width      int64  `json:"width,omitempty"`
	Height     int64  `json:"height,omitempty"`
	DurationMS int64  `json:"duration_ms,omitempty"`
	// Segment is the size of one sealed segment, the unit the server commits in.
	Segment int64 `json:"segment,omitempty"`
}

// Upload header names (tus-like, design §12.3).
const (
	HeaderUploadOffset     = "Upload-Offset"
	HeaderUploadLength     = "Upload-Length"
	HeaderUploadChecksum   = "Upload-Checksum" // "sha256 <hex>"
	HeaderUploadDurationMS = "Upload-Duration-Ms"
	HeaderUploadWaveform   = "Upload-Waveform" // base64 of up to 64 peaks
	HeaderUploadState      = "Upload-State"
	// ChunkType is the content type of a chunk.
	ChunkType = "application/offset+octet-stream"
)
