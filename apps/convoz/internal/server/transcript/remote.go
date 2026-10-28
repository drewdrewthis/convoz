package transcript

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"strings"
	"time"
)

// Keys are the API keys of the remote engines; an empty one leaves its engine out.
type Keys struct{ Groq, OpenAI, Gemini string }

// Endpoints say where the engines live; tests point them at fakes.
type Endpoints struct {
	Groq, OpenAI, Gemini string
	Timeout              time.Duration // per engine
	Client               *http.Client
}

// DefaultEndpoints are the real services, with the 20 s limit per engine for a note up to 5 minutes (longer: see timeLimit).
func DefaultEndpoints() Endpoints {
	return Endpoints{
		Groq:    "https://api.groq.com/openai/v1/audio/transcriptions",
		OpenAI:  "https://api.openai.com/v1/audio/transcriptions",
		Gemini:  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
		Timeout: 20 * time.Second,
		Client:  &http.Client{},
	}
}

// NewChain builds the chain of the keys that are set: Groq, then OpenAI, then Gemini, which only stands in while there is no OpenAI key.
// It returns nil when no key is set.
func NewChain(k Keys, ep Endpoints) *Chain {
	var c Chain
	if k.Groq != "" {
		c.steps = append(c.steps, step{"groq", whisper(ep, ep.Groq, k.Groq, "whisper-large-v3-turbo", true)})
	}
	if k.OpenAI != "" {
		c.steps = append(c.steps, step{"openai", whisper(ep, ep.OpenAI, k.OpenAI, "whisper-1", false)})
	} else if k.Gemini != "" {
		c.steps = append(c.steps, step{"gemini", gemini(ep, k.Gemini)})
	}
	if len(c.steps) == 0 {
		return nil
	}
	return &c
}

// whisper is the OpenAI-shaped transcription call that Groq and OpenAI both serve. The file part has a generic name: the extension tells
// the service the format and nothing else leaves the box. verbose asks for segments with end times, an empty prompt and temperature 0:
// the end of the last segment shows an engine that gave up before the end of the note.
func whisper(ep Endpoints, url, key, model string, verbose bool) func(context.Context, []byte, string) (answer, error) {
	return func(ctx context.Context, audio []byte, mime string) (answer, error) {
		var body bytes.Buffer
		mw := multipart.NewWriter(&body)
		_ = mw.WriteField("model", model)
		if verbose {
			_ = mw.WriteField("response_format", "verbose_json")
			_ = mw.WriteField("prompt", "")
			_ = mw.WriteField("temperature", "0")
		} else {
			_ = mw.WriteField("response_format", "json")
		}
		h := textproto.MIMEHeader{}
		h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="audio.%s"`, extension(mime)))
		h.Set("Content-Type", "application/octet-stream")
		part, _ := mw.CreatePart(h)
		_, _ = part.Write(audio)
		if err := mw.Close(); err != nil {
			return answer{}, err
		}
		var out struct {
			Text     string `json:"text"`
			Segments []struct {
				End float64 `json:"end"`
			} `json:"segments"`
		}
		if err := post(ctx, ep, url, "Authorization", "Bearer "+key, mw.FormDataContentType(), &body, &out); err != nil {
			return answer{}, err
		}
		a := answer{text: out.Text}
		if n := len(out.Segments); n > 0 {
			a.end = time.Duration(out.Segments[n-1].End * float64(time.Second))
		}
		return a, nil
	}
}

// gemini sends the note inline with the prompt "Transcribe verbatim". The key goes in a header, never in the URL.
func gemini(ep Endpoints, key string) func(context.Context, []byte, string) (answer, error) {
	return func(ctx context.Context, audio []byte, mime string) (answer, error) {
		req, _ := json.Marshal(map[string]any{"contents": []any{map[string]any{"parts": []any{
			map[string]any{"text": "Transcribe verbatim"},
			map[string]any{"inline_data": map[string]string{"mime_type": baseMime(mime), "data": base64.StdEncoding.EncodeToString(audio)}},
		}}}})
		var out struct {
			Candidates []struct {
				Content struct {
					Parts []struct {
						Text string `json:"text"`
					} `json:"parts"`
				} `json:"content"`
			} `json:"candidates"`
		}
		if err := post(ctx, ep, ep.Gemini, "x-goog-api-key", key, "application/json", bytes.NewReader(req), &out); err != nil {
			return answer{}, err
		}
		if len(out.Candidates) == 0 {
			return answer{}, errors.New("no answer")
		}
		var text strings.Builder
		for _, p := range out.Candidates[0].Content.Parts {
			text.WriteString(p.Text)
		}
		return answer{text: strings.TrimSpace(text.String())}, nil
	}
}

// shortNote is the note length the per-engine limit was set for (the old 5-minute cap).
const shortNote = 5 * time.Minute

// timeLimit is the engine's time for this note: the limit for a note up to shortNote, and in proportion for a longer one, so a
// 30-minute note gets six times the limit (2 minutes with the real 20 s) and the first engine is not cut off while it still works.
func timeLimit(ctx context.Context, limit time.Duration) time.Duration {
	note, _ := ctx.Value(durationKey{}).(time.Duration)
	if note <= shortNote {
		return limit
	}
	return time.Duration(float64(limit) * float64(note) / float64(shortNote))
}

// post sends one request within the engine's time limit and decodes a 200 answer into out. Any other status becomes an error that
// holds the status only; a refused file is ErrBadAudio.
func post(ctx context.Context, ep Endpoints, url, authHeader, auth, contentType string, body io.Reader, out any) error {
	ctx, cancel := context.WithTimeout(ctx, timeLimit(ctx, ep.Timeout))
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, body)
	if err != nil {
		return err
	}
	req.Header.Set(authHeader, auth)
	req.Header.Set("Content-Type", contentType)
	resp, err := ep.Client.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", unwrapURL(err))
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		switch resp.StatusCode {
		case http.StatusBadRequest, http.StatusRequestEntityTooLarge, http.StatusUnsupportedMediaType, http.StatusUnprocessableEntity:
			return fmt.Errorf("%w: status %d", ErrBadAudio, resp.StatusCode)
		}
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(out); err != nil {
		return fmt.Errorf("unreadable answer: %w", err)
	}
	return nil
}

// unwrapURL drops the URL a client error carries; the cause is enough.
func unwrapURL(err error) error {
	if u, ok := err.(interface{ Unwrap() error }); ok && u.Unwrap() != nil {
		return u.Unwrap()
	}
	return err
}

func baseMime(mime string) string {
	base, _, _ := strings.Cut(mime, ";")
	return strings.TrimSpace(base)
}

// extension is the file extension that tells the service the format of a sniffed audio type.
func extension(mime string) string {
	sub := strings.TrimPrefix(strings.TrimPrefix(baseMime(mime), "audio/"), "video/")
	switch sub {
	case "mp4", "x-m4a", "m4a", "aac":
		return "m4a"
	case "mpeg", "mp3":
		return "mp3"
	case "ogg", "wav", "webm", "flac":
		return sub
	case "x-wav", "wave":
		return "wav"
	}
	return "webm"
}
