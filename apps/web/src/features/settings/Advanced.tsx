import { Field } from "@convoz/ui/Field";
import { List, ListRow } from "@convoz/ui/ListRow";
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
      <List aria-label="Connection">
        <ListRow title="Median round trip" trailing={<span>{samples.length ? `${median(samples)} ms` : "measuring"}</span>} />
        <ListRow title="Connection type" trailing={<span>{effectiveType()}</span>} />
      </List>
      <h2>Last {samples.length === 1 ? "sample" : `${samples.length || 20} samples`}</h2>
      <List as="ol" aria-label="Samples">
        {[...samples].reverse().map((ms, i) => (
          <ListRow key={samples.length - i}>{ms} ms</ListRow>
        ))}
      </List>
    </>
  );
}

/** Advanced is Settings → Advanced: how media loads on this device, and the way to the connection details. */
export function Advanced({ onConnection }: { onConnection: () => void }) {
  const [media, setMedia] = useState(mediaSetting);
  return (
    <>
      <h2 id="media-title">Load media automatically</h2>
      <p className="text-13 text-muted">Images, voice notes, link cards and app previews. Automatic waits for a tap on a slow link or when Save-Data is on. This device only.</p>
      <List as="div" role="radiogroup" aria-labelledby="media-title">
        {MEDIA.map(([value, name]) => (
          <Field key={value} type="radio" label={name} name="media_autoload" value={value} checked={media === value} onChange={() => (chooseMedia(value), setMedia(value))} />
        ))}
      </List>
      <List as="div">
        <ListRow as="button" title="Connection" chevron onClick={onConnection} />
      </List>
    </>
  );
}
