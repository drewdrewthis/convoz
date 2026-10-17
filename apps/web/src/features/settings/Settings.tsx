import { useState } from "react";
import { humanError } from "../../shared/api.ts";
import { useNotice } from "../../shared/notice.tsx";
import { NotificationSettings } from "../notifications/index.ts";
import { Advanced, Connection } from "./Advanced.tsx";
import { PALETTES, TEXT_SIZES, THEMES, type Look } from "./appearance.ts";
import { useSettings } from "./store.ts";

const label = (v: string): string => (v.length <= 2 ? v.toUpperCase() : v[0]!.toUpperCase() + v.slice(1));

/** Choice is one radio group, laid out as a row list. A choice applies at once. */
function Choice<K extends keyof Look>({ name, field, options, hint }: { name: string; field: K; options: readonly Look[K][]; hint: string }) {
  const { fail } = useNotice();
  const current = useSettings((s) => s[field]);
  const choose = useSettings((s) => s.choose);
  return (
    <>
      <h2 id={`${field}-title`}>{name}</h2>
      <p className="sub">{hint}</p>
      <div className="group" role="radiogroup" aria-labelledby={`${field}-title`}>
        {options.map((o) => (
          <label className="row" key={o}>
            <span>{label(o)}</span>
            <input type="radio" name={field} value={o} checked={current === o} onChange={() => void choose(field, o).catch((err) => fail(humanError(err)))} />
          </label>
        ))}
      </div>
    </>
  );
}

type View = "settings" | "notifications" | "advanced" | "connection";

function Row({ name, to, go }: { name: string; to: View; go: (view: View) => void }) {
  return (
    <button className="row" type="button" onClick={() => go(to)}>
      <span>{name}</span>
      <span className="chev" aria-hidden="true" />
    </button>
  );
}

/** Settings is /settings: how the app looks on this device, notifications, advanced options, and the way to Privacy & security. */
export function Settings() {
  const [view, setView] = useState<View>("settings");
  if (view === "notifications") return <NotificationSettings />;
  if (view === "advanced") return <Advanced onConnection={() => setView("connection")} />;
  if (view === "connection") return <Connection />;
  return (
    <>
      <Choice name="Theme" field="theme" options={THEMES} hint="This device only. System follows your phone or computer." />
      <Choice name="Palette" field="palette" options={PALETTES} hint="The same on every device you sign in on." />
      <Choice name="Text size" field="text_size" options={TEXT_SIZES} hint="This device only." />
      <NotificationSettings />
      <div className="group">
        <Row name="Notifications" to="notifications" go={setView} />
        <Row name="Advanced" to="advanced" go={setView} />
        <a className="row" href="/settings/privacy">
          <span>Privacy &amp; security</span>
          <span className="chev" aria-hidden="true" />
        </a>
      </div>
    </>
  );
}
