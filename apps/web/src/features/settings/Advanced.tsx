import { useEffect, useState } from "react";
import { effectiveType, median, useConnection } from "../../shared/connection.ts";
import { chooseMedia, mediaSetting, type MediaAutoload } from "../../shared/media.ts";
import { ping } from "../../shared/ping.ts";

const MEDIA: [MediaAutoload, string][] = [
  ["auto", "Automatic"],
  ["on", "Always"],
  ["off", "Never"],
];
/** Pings taken as the view opens (so the median means something at once), then one every few seconds while it stays open. */
const FIRST_PINGS = 3;
const EVERY_MS = 5_000;

/** Connection is Settings → Advanced → Connection: how the link to the server behaves from this device (design §12.3). */
export function Connection() {
  const samples = useConnection((s) => s.samples);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      void ping().then(() => {
        if (!stopped) timer = setTimeout(tick, EVERY_MS);
      });
    };
    void (async () => {
      for (let n = 0; n < FIRST_PINGS && !stopped; n++) await ping();
      if (!stopped) timer = setTimeout(tick, EVERY_MS);
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  return (
    <>
      <h2>Connection</h2>
      <ul className="group" aria-label="Connection">
        <li className="row">
          <span>Median round trip</span>
          <span>{samples.length ? `${median(samples)} ms` : "measuring"}</span>
        </li>
        <li className="row">
          <span>Connection type</span>
          <span>{effectiveType()}</span>
        </li>
      </ul>
      <h2>Last {samples.length === 1 ? "sample" : `${samples.length || 20} samples`}</h2>
      <ol className="group" aria-label="Samples">
        {[...samples].reverse().map((ms, i) => (
          <li className="row" key={samples.length - i}>
            {ms} ms
          </li>
        ))}
      </ol>
    </>
  );
}

/** Advanced is Settings → Advanced: how media loads on this device, and the way to the connection details. */
export function Advanced({ onConnection }: { onConnection: () => void }) {
  const [media, setMedia] = useState(mediaSetting);
  return (
    <>
      <h2 id="media-title">Load media automatically</h2>
      <p className="sub">Images, voice notes, link cards and app previews. Automatic waits for a tap on a slow link or when Save-Data is on. This device only.</p>
      <div className="group" role="radiogroup" aria-labelledby="media-title">
        {MEDIA.map(([value, name]) => (
          <label className="row" key={value}>
            <span>{name}</span>
            <input type="radio" name="media_autoload" value={value} checked={media === value} onChange={() => (chooseMedia(value), setMedia(value))} />
          </label>
        ))}
      </div>
      <div className="group">
        <button className="row" type="button" onClick={onConnection}>
          <span>Connection</span>
          <span className="chev" aria-hidden="true" />
        </button>
      </div>
    </>
  );
}
