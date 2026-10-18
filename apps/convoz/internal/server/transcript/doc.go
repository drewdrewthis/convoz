// Package transcript is a server module (design §4.2). Transcript owns transcripts: voice transcription behind an engine interface.
//
// The workspace setting transcription.engine names the engine: "auto" (the default) is the engine the server was started with (--transcribe: Groq, then OpenAI or
// Gemini, by the keys it has), "none" is off and sends no audio anywhere, and any other name is that engine. A voice note posted while an engine is set gets a
// pending row; a worker takes it, hands the decrypted audio to the engine, and stores the words. The composition root then re-indexes
// the message for search and releases the inbox items that were held for the words (E-5). With no engine there is no row at all: the
// note shows no transcript and no error.
package transcript
