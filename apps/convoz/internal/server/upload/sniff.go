package upload

import (
	"bytes"
	"encoding/binary"
	"image"
	_ "image/gif" // registers the decoder image.DecodeConfig uses
	_ "image/jpeg"
	_ "image/png"
	"io"
	"unicode/utf8"
)

// sniffed is what the first bytes of a file say it is.
type sniffed struct {
	Kind, Mime    string
	Inline        bool
	Width, Height int64
}

// sniff decides what a file is from its bytes, never from its name or from what the client called it (I-44). Only a safe image or
// audio type is shown inline; everything else is served as an attachment. The kind the client asked for can only narrow the result:
// a file called an image that is not one becomes a plain file. An image's size is read from its header alone, and a header that
// promises more than 40 megapixels, or more than 16384 on a side, is refused before anything decodes it.
func sniff(r io.ReadSeeker, asked string) (sniffed, error) {
	head := make([]byte, 512)
	n, err := io.ReadFull(r, head)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return sniffed{}, err
	}
	head = head[:n]
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return sniffed{}, err
	}
	other := sniffed{Kind: KindFile, Mime: "application/octet-stream"}
	if asked == KindApp {
		whole, err := io.ReadAll(io.LimitReader(r, MaxAppBytes+1))
		if err != nil {
			return sniffed{}, err
		}
		if _, err := r.Seek(0, io.SeekStart); err != nil {
			return sniffed{}, err
		}
		if len(whole) > 0 && utf8.Valid(whole) {
			return sniffed{Kind: KindApp, Mime: "text/html; charset=utf-8"}, nil
		}
		return other, nil
	}
	if mime := imageMime(head); mime != "" {
		w, h, ok := dimensions(r, mime)
		if _, err := r.Seek(0, io.SeekStart); err != nil {
			return sniffed{}, err
		}
		if ok && (int64(w)*int64(h) > MaxPixels || w > MaxSide || h > MaxSide) {
			return sniffed{}, ErrImageTooLarge
		}
		if ok && asked == KindImage && w > 0 && h > 0 {
			return sniffed{Kind: KindImage, Mime: mime, Inline: true, Width: int64(w), Height: int64(h)}, nil
		}
		return other, nil
	}
	if mime := audioMime(head); mime != "" && asked == KindAudio {
		return sniffed{Kind: KindAudio, Mime: mime, Inline: true}, nil
	}
	return other, nil
}

func imageMime(b []byte) string {
	switch {
	case bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")):
		return "image/png"
	case bytes.HasPrefix(b, []byte{0xFF, 0xD8, 0xFF}):
		return "image/jpeg"
	case bytes.HasPrefix(b, []byte("GIF87a")), bytes.HasPrefix(b, []byte("GIF89a")):
		return "image/gif"
	case len(b) >= 12 && bytes.Equal(b[:4], []byte("RIFF")) && bytes.Equal(b[8:12], []byte("WEBP")):
		return "image/webp"
	}
	return ""
}

func audioMime(b []byte) string {
	switch {
	case bytes.HasPrefix(b, []byte("OggS")):
		return "audio/ogg"
	case bytes.HasPrefix(b, []byte{0x1A, 0x45, 0xDF, 0xA3}):
		return "audio/webm"
	case bytes.HasPrefix(b, []byte("ID3")), len(b) > 1 && b[0] == 0xFF && b[1]&0xE0 == 0xE0 && b[1]&0x06 != 0:
		return "audio/mpeg"
	case len(b) >= 12 && bytes.Equal(b[:4], []byte("RIFF")) && bytes.Equal(b[8:12], []byte("WAVE")):
		return "audio/wav"
	case bytes.HasPrefix(b, []byte("fLaC")):
		return "audio/flac"
	case len(b) >= 12 && bytes.Equal(b[4:8], []byte("ftyp")) && audioBrand(b[8:12]):
		return "audio/mp4"
	}
	return ""
}

func audioBrand(b []byte) bool {
	switch string(b) {
	case "M4A ", "M4B ", "mp42", "isom", "iso2", "dash":
		return true
	}
	return false
}

// dimensions reads the size of an image from its header. ok is false when the header cannot be read.
func dimensions(r io.Reader, mime string) (w, h int, ok bool) {
	if mime == "image/webp" {
		return webpSize(r)
	}
	cfg, _, err := image.DecodeConfig(r)
	if err != nil {
		return 0, 0, false
	}
	return cfg.Width, cfg.Height, true
}

// webpSize reads the canvas size of a WebP from its first chunk (VP8, VP8L or VP8X).
func webpSize(r io.Reader) (w, h int, ok bool) {
	b := make([]byte, 30)
	if _, err := io.ReadFull(r, b); err != nil || !bytes.Equal(b[12:15], []byte("VP8")) {
		return 0, 0, false
	}
	switch b[15] {
	case ' ': // lossy: a 14-bit width and height after the frame tag and start code
		if b[23] != 0x9d || b[24] != 0x01 || b[25] != 0x2a {
			return 0, 0, false
		}
		return int(binary.LittleEndian.Uint16(b[26:])) & 0x3fff, int(binary.LittleEndian.Uint16(b[28:])) & 0x3fff, true
	case 'L': // lossless: 14 bits each, minus one
		if b[20] != 0x2f {
			return 0, 0, false
		}
		bits := binary.LittleEndian.Uint32(b[21:])
		return int(bits&0x3fff) + 1, int(bits>>14&0x3fff) + 1, true
	case 'X': // extended: 24 bits each, minus one
		return int(b[24]) | int(b[25])<<8 | int(b[26])<<16 + 1, int(b[27]) | int(b[28])<<8 | int(b[29])<<16 + 1, true
	}
	return 0, 0, false
}
