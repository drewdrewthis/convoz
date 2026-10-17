import type { Upload } from "@convoz/api-client";
import { ChevronIcon, PauseIcon, PlayIcon } from "@convoz/ui/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMediaAutoLoads } from "../../shared/media.ts";
import { fileSize, fileUrl } from "../../shared/uploads.ts";
import { mmss } from "./mmss.ts";

const BARS = 30;
/** The height of every bar when the note has no waveform. */
const LOW = 0.15;

/** One note plays at a time: starting one pauses the other. */
let playing: HTMLAudioElement | null = null;

/** bars resamples the note's peaks (0..255) to 30 heights of 0..1, the loudest of each stretch. */
function bars(peaks: number[] | undefined): number[] {
  if (!peaks?.length) return Array<number>(BARS).fill(LOW);
  return Array.from({ length: BARS }, (_, i) => {
    const from = Math.floor((i * peaks.length) / BARS);
    const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / BARS));
    return Math.max(...peaks.slice(from, to)) / 255;
  });
}

/** VoiceNote is the voice bubble of the prototype: play, the waveform as the playback progress, the length, and the transcript once there is one. */
export function VoiceNote({ upload }: { upload: Upload }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [on, setOn] = useState(false);
  const [pct, setPct] = useState(0);
  const [open, setOpen] = useState(false);
  const auto = useMediaAutoLoads();
  const [tapped, setTapped] = useState(false);
  // Where media waits for a tap the audio is not fetched, not even its header; the first tap on play loads it and plays.
  const loaded = auto || tapped;
  const heights = useMemo(() => bars(upload.waveform), [upload.waveform]);
  const total = upload.duration_ms ?? 0;
  const words = upload.transcript?.state === "done" ? (upload.transcript.text ?? "") : null;

  const follow = () => {
    const a = audio.current!;
    // a recorded webm often reports an Infinite duration: the server's length is the fallback
    const length = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : total / 1000;
    setPct(length ? Math.min(100, Math.round((a.currentTime / length) * 100)) : 0);
  };
  useEffect(() => {
    const a = audio.current;
    if (!tapped || !a) return;
    if (playing && playing !== a) playing.pause();
    playing = a;
    a.play().catch(() => setOn(false));
  }, [tapped]);
  const toggle = () => {
    if (!loaded) {
      setTapped(true); // the effect below plays once the element has its source
      return;
    }
    const a = audio.current!;
    if (!a.paused) {
      a.pause();
      return;
    }
    if (playing && playing !== a) playing.pause();
    playing = a;
    a.play().catch(() => setOn(false));
  };

  return (
    <div className="voice">
      <div className="vbubble">
        <button type="button" className="vplay" aria-label={on ? "Pause voice message" : "Play voice message"} onClick={toggle}>
          {on ? <PauseIcon /> : <PlayIcon />}
        </button>
        <span className="vbars" role="progressbar" aria-label="Playback progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          {heights.map((h, i) => (
            <i key={i} className={(i + 0.5) / BARS <= pct / 100 ? "on" : undefined} style={{ height: `${Math.round(4 + h * 22)}px` }} />
          ))}
        </span>
        <span className="vtime">{mmss(Math.round(total / 1000))}</span>
        {loaded ? null : <span className="vsize">{`${fileSize(upload.size)} · tap to load`}</span>}
        <audio
          ref={audio}
          src={loaded ? fileUrl(upload.id) : undefined}
          preload={loaded ? "metadata" : "none"}
          onPlay={() => setOn(true)}
          onPause={() => setOn(false)}
          onTimeUpdate={follow}
          onEnded={() => {
            setOn(false);
            setPct(100);
          }}
        />
      </div>
      {words !== null ? (
        <>
          <button type="button" className="vtx" aria-expanded={open} onClick={() => setOpen((x) => !x)}>
            Transcript <ChevronIcon />
          </button>
          {open ? <p className="vwords">{words}</p> : null}
        </>
      ) : null}
    </div>
  );
}
