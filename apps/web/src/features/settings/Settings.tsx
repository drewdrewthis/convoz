import { Field } from "@convoz/ui/Field";
import { List, ListRow } from "@convoz/ui/ListRow";
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
      <p className="text-13 text-muted">{hint}</p>
      <List as="div" role="radiogroup" aria-labelledby={`${field}-title`}>
        {options.map((o) => (
          <Field key={o} type="radio" label={label(o)} name={field} value={o} checked={current === o} onChange={() => void choose(field, o).catch((err) => fail(humanError(err)))} />
        ))}
      </List>
    </>
  );
}

type View = "settings" | "notifications" | "advanced" | "connection";

function Row({ name, to, go }: { name: string; to: View; go: (view: View) => void }) {
  return (
    <ListRow as="button" title={name} chevron onClick={() => go(to)} />
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
      <List as="div">
        <Row name="Notifications" to="notifications" go={setView} />
        <Row name="Advanced" to="advanced" go={setView} />
        <ListRow as="a" href="/settings/privacy" title="Privacy & security" chevron />
      </List>
    </>
  );
}
