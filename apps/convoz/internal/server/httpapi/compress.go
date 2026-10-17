package httpapi

import (
	"compress/gzip"
	"io"
	"mime"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/andybalholm/brotli"
)

// Compression (design §12.3): brotli, or gzip for a client without it, on every text answer over 1 KB. A short answer
// costs more to compress than it saves, and a stream must flush each frame, so neither is touched.
const (
	compressMin   = 1024
	brotliQuality = 4 // an answer is compressed on every request, so speed counts more than the last few percent
)

var (
	brotliPool = sync.Pool{New: func() any { return brotli.NewWriterLevel(nil, brotliQuality) }}
	gzipPool   = sync.Pool{New: func() any { return gzip.NewWriter(nil) }}
)

// compress wraps next so that its answers are compressed when the client accepts it and they are big enough.
func compress(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		enc := chooseEncoding(r.Header.Get("Accept-Encoding"))
		if enc == "" || r.Method == http.MethodHead || r.Header.Get("Range") != "" || strings.HasPrefix(r.URL.Path, "/api/stream") {
			next.ServeHTTP(w, r)
			return
		}
		cw := &compressWriter{ResponseWriter: w, enc: enc}
		defer cw.finish()
		next.ServeHTTP(cw, r)
	})
}

// chooseEncoding picks br over gzip from an Accept-Encoding header; "" means send the answer as it is.
func chooseEncoding(accept string) string {
	var gz bool
	for _, part := range strings.Split(accept, ",") {
		name, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if q, ok := strings.CutPrefix(strings.ReplaceAll(params, " ", ""), "q="); ok {
			if n, err := strconv.ParseFloat(q, 64); err == nil && n == 0 {
				continue // q=0 means "not acceptable"
			}
		}
		switch strings.ToLower(name) {
		case "br":
			return "br"
		case "gzip":
			gz = true
		}
	}
	if gz {
		return "gzip"
	}
	return ""
}

// compressWriter holds an answer back until it is more than compressMin bytes, then compresses the rest as it comes.
type compressWriter struct {
	http.ResponseWriter
	enc     string
	status  int
	buf     []byte
	decided bool
	zw      io.WriteCloser
	release func()
}

func (c *compressWriter) WriteHeader(code int) {
	if c.status == 0 {
		c.status = code
	}
}

func (c *compressWriter) Write(p []byte) (int, error) {
	if c.status == 0 {
		c.status = http.StatusOK
	}
	if c.decided {
		return c.sink().Write(p)
	}
	c.buf = append(c.buf, p...)
	if len(c.buf) > compressMin {
		return len(p), c.decide(true)
	}
	return len(p), nil
}

// Flush is a handler saying its answer is a stream: it goes out as it is.
func (c *compressWriter) Flush() {
	if !c.decided && c.status != 0 {
		_ = c.decide(false)
	}
	if c.zw != nil {
		if f, ok := c.zw.(interface{ Flush() error }); ok {
			_ = f.Flush()
		}
	}
	if f, ok := c.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap lets http.NewResponseController reach the real writer's deadlines.
func (c *compressWriter) Unwrap() http.ResponseWriter { return c.ResponseWriter }

func (c *compressWriter) sink() io.Writer {
	if c.zw != nil {
		return c.zw
	}
	return c.ResponseWriter
}

// decide writes the header and what was held back, compressing from here on when it applies.
func (c *compressWriter) decide(big bool) error {
	c.decided = true
	h := c.Header()
	if compressible(h.Get("Content-Type")) && c.status == http.StatusOK {
		if !slices.Contains(h.Values("Vary"), "Accept-Encoding") { // a handler that serves its own encodings set it already
			h.Add("Vary", "Accept-Encoding")
		}
		if big && h.Get("Content-Encoding") == "" && !strings.Contains(h.Get("Cache-Control"), "no-transform") {
			h.Set("Content-Encoding", c.enc)
			h.Del("Content-Length")
			if etag := h.Get("ETag"); etag != "" && !strings.HasPrefix(etag, "W/") {
				h.Set("ETag", "W/"+etag) // the compressed bytes are another representation of it
			}
			c.zw, c.release = newEncoder(c.enc, c.ResponseWriter)
		}
	}
	c.ResponseWriter.WriteHeader(c.status)
	_, err := c.sink().Write(c.buf)
	c.buf = nil
	return err
}

// finish ends the answer: what was held back goes out as it is, and a compressed body is closed.
func (c *compressWriter) finish() {
	if !c.decided && c.status != 0 {
		_ = c.decide(false)
	}
	if c.zw != nil {
		_ = c.zw.Close()
		c.release()
	}
}

func newEncoder(enc string, w io.Writer) (io.WriteCloser, func()) {
	if enc == "br" {
		bw := brotliPool.Get().(*brotli.Writer)
		bw.Reset(w)
		return bw, func() { brotliPool.Put(bw) }
	}
	gw := gzipPool.Get().(*gzip.Writer)
	gw.Reset(w)
	return gw, func() { gzipPool.Put(gw) }
}

// compressible reports whether a Content-Type is text worth compressing: JSON, text, JavaScript, SVG, a manifest.
func compressible(contentType string) bool {
	media, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return false
	}
	switch {
	case strings.HasPrefix(media, "text/"), media == "application/json", media == "application/javascript", media == "image/svg+xml":
		return true
	}
	return strings.HasSuffix(media, "+json") || strings.HasSuffix(media, "+xml")
}
