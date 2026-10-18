package transcript_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	pdb "github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/db"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/platform/dbtest"
	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/transcript"
)

// fake is an httptest stand-in for one provider: it counts calls, records what it was sent and answers with status or text.
type fake struct {
	*httptest.Server
	calls  atomic.Int32
	status atomic.Int32
	hang   atomic.Bool
	auth   atomic.Value // the credential header of the last call
	body   atomic.Value // the last request body
	ctype  atomic.Value
}

func newFake(t *testing.T, authHeader string, answer string) *fake {
	f := &fake{}
	f.status.Store(200)
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.calls.Add(1)
		raw, _ := io.ReadAll(r.Body)
		f.auth.Store(r.Header.Get(authHeader))
		f.body.Store(string(raw))
		f.ctype.Store(r.Header.Get("Content-Type"))
		if f.hang.Load() {
			<-r.Context().Done()
			return
		}
		if st := int(f.status.Load()); st != 200 {
			w.WriteHeader(st)
			_, _ = w.Write([]byte(`{"error":"the words of the note"}`))
			return
		}
		_, _ = w.Write([]byte(answer))
	}))
	t.Cleanup(f.Close)
	return f
}

func endpoints(groq, openai, gem *fake) transcript.Endpoints {
	ep := transcript.Endpoints{Timeout: 200 * time.Millisecond, Client: &http.Client{}}
	if groq != nil {
		ep.Groq = groq.URL
	}
	if openai != nil {
		ep.OpenAI = openai.URL
	}
	if gem != nil {
		ep.Gemini = gem.URL
	}
	return ep
}

const whisperAnswer = `{"text":"hello there"}`

func run(t *testing.T, c *transcript.Chain) (string, string, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return c.TranscribeAs(ctx, strings.NewReader("AUDIOBYTES"), "audio/webm;codecs=opus")
}

func TestPrimaryAnswersAndIsNamed(t *testing.T) {
	groq, openai := newFake(t, "Authorization", whisperAnswer), newFake(t, "Authorization", whisperAnswer)
	c := transcript.NewChain(transcript.Keys{Groq: "TESTONLY-g", OpenAI: "TESTONLY-o"}, endpoints(groq, openai, nil))
	text, engine, err := run(t, c)
	if err != nil || text != "hello there" || engine != "groq" {
		t.Fatalf("got %q %q %v", text, engine, err)
	}
	if openai.calls.Load() != 0 {
		t.Fatal("the fallback was called although the primary answered")
	}
	if groq.auth.Load() != "Bearer TESTONLY-g" {
		t.Fatalf("auth %v", groq.auth.Load())
	}
	body := groq.body.Load().(string)
	for _, want := range []string{"whisper-large-v3-turbo", `name="response_format"`, "json", `filename="audio.webm"`, "AUDIOBYTES"} {
		if !strings.Contains(body, want) {
			t.Errorf("request lacks %q", want)
		}
	}
	if !strings.HasPrefix(groq.ctype.Load().(string), "multipart/form-data") {
		t.Fatal("not multipart")
	}
}

func TestFallsThroughOnRateLimitServerErrorAndTimeout(t *testing.T) {
	for name, trouble := range map[string]func(*fake){
		"429":     func(f *fake) { f.status.Store(429) },
		"500":     func(f *fake) { f.status.Store(503) },
		"timeout": func(f *fake) { f.hang.Store(true) },
		"key":     func(f *fake) { f.status.Store(401) },
	} {
		t.Run(name, func(t *testing.T) {
			groq, openai := newFake(t, "Authorization", whisperAnswer), newFake(t, "Authorization", `{"text":"from openai"}`)
			trouble(groq)
			c := transcript.NewChain(transcript.Keys{Groq: "TESTONLY-g", OpenAI: "TESTONLY-o"}, endpoints(groq, openai, nil))
			text, engine, err := run(t, c)
			if err != nil || text != "from openai" || engine != "openai" {
				t.Fatalf("got %q %q %v", text, engine, err)
			}
			if !strings.Contains(openai.body.Load().(string), "whisper-1") {
				t.Fatal("the fallback did not ask for whisper-1")
			}
		})
	}
}

func TestGeminiStandsInOnlyWithoutAnOpenAIKey(t *testing.T) {
	groq := newFake(t, "Authorization", whisperAnswer)
	groq.status.Store(500)
	gem := newFake(t, "x-goog-api-key", `{"candidates":[{"content":{"parts":[{"text":"from "},{"text":"gemini"}]}}]}`)
	c := transcript.NewChain(transcript.Keys{Groq: "TESTONLY-g", Gemini: "TESTONLY-m"}, endpoints(groq, nil, gem))
	text, engine, err := run(t, c)
	if err != nil || text != "from gemini" || engine != "gemini" {
		t.Fatalf("got %q %q %v", text, engine, err)
	}
	if gem.auth.Load() != "TESTONLY-m" {
		t.Fatal("the key must go in the header")
	}
	body := gem.body.Load().(string)
	var req struct {
		Contents []struct {
			Parts []map[string]any `json:"parts"`
		} `json:"contents"`
	}
	if json.Unmarshal([]byte(body), &req) != nil || req.Contents[0].Parts[0]["text"] != "Transcribe verbatim" {
		t.Fatalf("prompt: %s", body)
	}
	if got := transcript.NewChain(transcript.Keys{OpenAI: "TESTONLY-o", Gemini: "TESTONLY-m"}, endpoints(nil, groq, gem)).Names(); len(got) != 1 || got[0] != "openai" {
		t.Fatalf("with an OpenAI key gemini must stay out: %v", got)
	}
}

func TestEveryEngineFailingIsAnErrorWithoutContent(t *testing.T) {
	groq, openai := newFake(t, "Authorization", whisperAnswer), newFake(t, "Authorization", whisperAnswer)
	groq.status.Store(429)
	openai.status.Store(500)
	c := transcript.NewChain(transcript.Keys{Groq: "TESTONLY-g", OpenAI: "TESTONLY-o"}, endpoints(groq, openai, nil))
	_, _, err := run(t, c)
	if err == nil || errors.Is(err, transcript.ErrBadAudio) {
		t.Fatalf("got %v", err)
	}
	for _, leak := range []string{"the words of the note", "TESTONLY", "AUDIOBYTES", groq.URL} {
		if strings.Contains(err.Error(), leak) {
			t.Errorf("error leaks %q: %v", leak, err)
		}
	}
	if !strings.Contains(err.Error(), "groq") || !strings.Contains(err.Error(), "openai") {
		t.Fatalf("error names no engines: %v", err)
	}
}

func TestABadFileIsFinal(t *testing.T) {
	groq, openai := newFake(t, "Authorization", whisperAnswer), newFake(t, "Authorization", whisperAnswer)
	groq.status.Store(400)
	c := transcript.NewChain(transcript.Keys{Groq: "TESTONLY-g", OpenAI: "TESTONLY-o"}, endpoints(groq, openai, nil))
	_, _, err := run(t, c)
	if !errors.Is(err, transcript.ErrBadAudio) {
		t.Fatalf("got %v", err)
	}
	if openai.calls.Load() != 0 {
		t.Fatal("the fallback must not see a file the primary refused")
	}
}

func TestNoKeyMeansNoEngine(t *testing.T) {
	if transcript.NewChain(transcript.Keys{}, transcript.DefaultEndpoints()) != nil {
		t.Fatal("a chain without keys")
	}
}

func TestACanceledCallDoesNotFallThrough(t *testing.T) {
	groq, openai := newFake(t, "Authorization", whisperAnswer), newFake(t, "Authorization", whisperAnswer)
	groq.hang.Store(true)
	c := transcript.NewChain(transcript.Keys{Groq: "TESTONLY-g", OpenAI: "TESTONLY-o"}, endpoints(groq, openai, nil))
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(30*time.Millisecond, cancel)
	if _, _, err := c.TranscribeAs(ctx, strings.NewReader("x"), "audio/ogg"); err == nil {
		t.Fatal("no error")
	}
	if openai.calls.Load() != 0 {
		t.Fatal("a canceled call went on to the next engine")
	}
}

func TestADefaultEngineStandsInForTheUnsetSetting(t *testing.T) {
	if transcript.Default() != transcript.None {
		t.Fatal("default is not none")
	}
	transcript.SetDefault("auto")
	defer transcript.SetDefault(transcript.None)
	if transcript.Default() != "auto" {
		t.Fatal("default not set")
	}
}

func TestGiveUpFailsAtOnceAndFinishStoresTheEngineName(t *testing.T) {
	s := seeded(t)
	for _, finish := range []bool{false, true} {
		dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error { return transcript.Enqueue(ctx, d, t0, 7, "auto") })
		var job transcript.Job
		dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) (err error) {
			job, _, err = transcript.Next(ctx, d, t0)
			return err
		})
		dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
			if finish {
				return transcript.Finish(ctx, d, t0, 7, "groq", "words")
			}
			return transcript.GiveUp(ctx, d, t0, job)
		})
		want := transcript.Failed
		if finish {
			want = transcript.Done
		}
		dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
			got, err := transcript.ForUploads(ctx, d, []int64{7})
			if got[7].State != want || got[7].Attempts > 1 {
				t.Fatalf("finish=%v got %+v", finish, got)
			}
			return err
		})
		if !finish {
			dbtest.Exec(t, s, `DELETE FROM transcripts`)
		}
	}
	var engine string
	dbtest.Tx(t, s, func(ctx context.Context, d pdb.DBTX) error {
		return d.QueryRowContext(ctx, `SELECT engine FROM transcripts WHERE upload_id = 7`).Scan(&engine)
	})
	if engine != "groq" {
		t.Fatalf("stored engine %q", engine)
	}
}
