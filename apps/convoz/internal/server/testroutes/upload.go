package testroutes

// The test routes of the transcript module (testhooks build only; scripts/release_guard.py checks a release binary has none).
const (
	// Transcriber sets what the fake transcription engine answers: {"text": "...", "fail": false}.
	Transcriber = "/__test/transcriber"
)

func init() { All = append(All, Transcriber) }
