package upload

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"testing"
)

// pngHeader is a PNG that claims w by h pixels in its header and holds none of them: all a size check needs.
func pngHeader(w, h uint32) []byte {
	var out bytes.Buffer
	out.WriteString("\x89PNG\r\n\x1a\n")
	chunk := func(kind string, data []byte) {
		_ = binary.Write(&out, binary.BigEndian, uint32(len(data)))
		out.WriteString(kind)
		out.Write(data)
		_ = binary.Write(&out, binary.BigEndian, crc32.ChecksumIEEE(append([]byte(kind), data...)))
	}
	ihdr := binary.BigEndian.AppendUint32(nil, w)
	ihdr = binary.BigEndian.AppendUint32(ihdr, h)
	ihdr = append(ihdr, 8, 2, 0, 0, 0)
	chunk("IHDR", ihdr)
	var z bytes.Buffer
	zw := zlib.NewWriter(&z)
	_, _ = zw.Write([]byte{0})
	_ = zw.Close()
	chunk("IDAT", z.Bytes())
	chunk("IEND", nil)
	return out.Bytes()
}

func TestAPixelBombIsRefusedFromItsHeader(t *testing.T) {
	_, err := sniff(bytes.NewReader(pngHeader(30000, 30000)), KindImage)
	if !errors.Is(err, ErrImageTooLarge) {
		t.Fatalf("got %v", err)
	}
	if _, err := sniff(bytes.NewReader(pngHeader(20000, 10)), KindImage); !errors.Is(err, ErrImageTooLarge) {
		t.Fatalf("a side over 16384: %v", err)
	}
}

func TestOnlySafeTypesAreInline(t *testing.T) {
	cases := []struct {
		name  string
		data  []byte
		asked string
		want  string
		kind  string
		in    bool
	}{
		{"png", pngHeader(4, 4), KindImage, "image/png", KindImage, true},
		{"png asked as a file", pngHeader(4, 4), KindFile, "application/octet-stream", KindFile, false},
		{"html called an image", []byte("<html><script>alert(1)</script></html>"), KindImage, "application/octet-stream", KindFile, false},
		{"svg called an image", []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`), KindImage, "application/octet-stream", KindFile, false},
		{"ogg", append([]byte("OggS\x00"), make([]byte, 64)...), KindAudio, "audio/ogg", KindAudio, true},
		{"webm", append([]byte{0x1A, 0x45, 0xDF, 0xA3}, make([]byte, 64)...), KindAudio, "audio/webm", KindAudio, true},
		{"ogg called a file", append([]byte("OggS\x00"), make([]byte, 64)...), KindFile, "application/octet-stream", KindFile, false},
		{"html called audio", []byte("<html>"), KindAudio, "application/octet-stream", KindFile, false},
	}
	for _, c := range cases {
		got, err := sniff(bytes.NewReader(c.data), c.asked)
		if err != nil || got.Mime != c.want || got.Kind != c.kind || got.Inline != c.in {
			t.Errorf("%s: got %+v, %v", c.name, got, err)
		}
	}
}
