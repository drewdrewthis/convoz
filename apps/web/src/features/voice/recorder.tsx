import { IconButton } from "@convoz/ui/IconButton";
import type { Upload } from "@convoz/api-client";
import { ArrowIcon, CloseIcon } from "@convoz/ui/icons";
import { useEffect, useRef, useState } from "react";
import { asUpload, streamUpload } from "../../shared/uploads.ts";
import { mmss } from "./mmss.ts";
import { NoRecorderApiError } from "./micNote.ts";

/** A voice note stops by itself at five minutes. */
const MOST_MS = 300_000;
/** Peaks the server keeps for the waveform. */
const PEAKS = 64;
const SAMPLE_MS = 100;
/** The waveform when the level could not be read (no Web Audio). */
const FLAT = 64;

/** A voice note being recorded. Its upload runs while it records (I-31). */
export interface VoiceRecording {
  /** Milliseconds since the start, frozen once it stopped. */
  elapsed(): number;
  /** Stop and drop everything: nothing is sent and no server route is called. */
  cancel(): void;
  /** Stop, send the rest, and resolve with the finished upload. Can be called again after a failure. */
  finish(): Promise<Upload>;
}

/**
 * startRecording asks for the microphone and starts recording, a piece each second; each piece goes to the upload at once. It
 * throws when there is no microphone, no MediaRecorder, or the person said no.
 */
export async function startRecording(conversationId: number): Promise<VoiceRecording> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new NoRecorderApiError("no microphone");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const release = () => stream.getTracks().forEach((t) => t.stop());
  let recorder: MediaRecorder;
  try {
    const opus = "audio/webm;codecs=opus";
    recorder = new MediaRecorder(stream, MediaRecorder.isTypeSupported(opus) ? { mimeType: opus } : undefined);
  } catch (err) {
    release();
    throw err;
  }
  const upload = streamUpload({ conversation_id: conversationId, kind: "audio", filename: "voice-note.webm" });
  const level = sampler(stream);
  let bytes = 0;
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    bytes += e.data.size;
    upload.push(e.data);
  };
  // the last piece arrives before the stop event
  const ended = new Promise<void>((done) => recorder.addEventListener("stop", () => done(), { once: true }));
  try {
    recorder.start(1000);
  } catch (err) {
    release();
    level.stop();
    throw err;
  }
  const started = performance.now();
  let stoppedAt = 0;
  const stop = () => {
    if (stoppedAt) return;
    stoppedAt = performance.now();
    clearTimeout(limit);
    if (recorder.state !== "inactive") recorder.stop();
    release();
    level.stop();
  };
  const limit = setTimeout(stop, MOST_MS);

  return {
    elapsed: () => Math.min(MOST_MS, (stoppedAt || performance.now()) - started),
    cancel: () => {
      stop();
      upload.abort();
    },
    finish: async () => {
      stop();
      await ended;
      if (!bytes) throw new Error("nothing recorded");
      const duration = Math.min(MOST_MS, Math.max(1, Math.round(stoppedAt - started)));
      const peaks = level.peaks();
      const done = await upload.finish({ "Upload-Duration-Ms": duration, "Upload-Waveform": btoa(String.fromCharCode(...peaks)) });
      return asUpload(done, { duration_ms: done.duration_ms ?? duration, waveform: Array.from(peaks) });
    },
  };
}

/** sampler reads the microphone's level every 100 ms (Web Audio), for the waveform the note keeps. */
function sampler(stream: MediaStream) {
  const levels: number[] = [];
  let ctx: AudioContext | null = null;
  let timer = 0;
  try {
    ctx = new AudioContext();
    void ctx.resume();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const wave = new Uint8Array(analyser.fftSize);
    timer = window.setInterval(() => {
      analyser.getByteTimeDomainData(wave);
      let peak = 0;
      for (const v of wave) peak = Math.max(peak, Math.abs(v - 128));
      levels.push(Math.min(255, peak * 2));
    }, SAMPLE_MS);
  } catch {
    // no Web Audio: the note gets a flat waveform
  }
  return {
    stop: () => {
      clearInterval(timer);
      void ctx?.close().catch(() => {});
    },
    /** The levels as 64 peaks of 0..255, the loudest of each stretch. */
    peaks: (): Uint8Array => {
      const out = new Uint8Array(PEAKS);
      if (!levels.length) return out.fill(FLAT);
      for (let i = 0; i < PEAKS; i++) {
        const from = Math.floor((i * levels.length) / PEAKS);
        const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / PEAKS));
        out[i] = Math.max(...levels.slice(from, to));
      }
      return out;
    },
  };
}

/**
 * RecordingBar takes the composer's place while a voice note records: Cancel, the time, a level display and Send. `onDone` gets
 * the finished upload after Send, nothing after Cancel.
 */
export function RecordingBar({ recording, onDone }: { recording: VoiceRecording; onDone(sent?: Upload): void }) {
  const [secs, setSecs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const send = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    send.current?.focus();
    const timer = setInterval(() => setSecs(Math.floor(recording.elapsed() / 1000)), 250);
    return () => {
      clearInterval(timer);
      recording.cancel(); // the page went away: nothing is sent (after a send this changes nothing)
    };
  }, [recording]);

  const cancel = () => {
    recording.cancel();
    onDone();
  };
  const finish = async () => {
    setBusy(true);
    setFailed(false);
    try {
      onDone(await recording.finish());
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <>
      <div
        role="group"
        aria-label="Recording a voice message"
        className="recin glass"
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          cancel();
        }}
      >
        <IconButton variant="muted" glyph={16} label="Cancel recording" onClick={cancel}>
          <CloseIcon />
        </IconButton>
        <span aria-hidden="true" className="rdot" />
        <span className="rtime">
          <span className="sr">Recording </span>
          {mmss(secs)}
        </span>
        <span aria-hidden="true" className="vlvl">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
        <IconButton ref={send} variant="primary" glyph={16} stroke={2} label="Send voice message" disabled={busy} onClick={() => void finish()}>
          <ArrowIcon />
        </IconButton>
      </div>
      {failed ? (
        <p role="alert" className="micnote">
          Upload failed
        </p>
      ) : null}
    </>
  );
}
