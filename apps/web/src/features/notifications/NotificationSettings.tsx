import { Field } from "@convoz/ui/Field";
import { List, ListRow } from "@convoz/ui/ListRow";
import { useCallback, useEffect, useState } from "react";
import { call, client, humanError } from "../../shared/api.ts";
import { useNotice } from "../../shared/notice.tsx";
import { CHROME_IOS_HINT, deviceState, onIosThirdPartyBrowser, PushStepError, turnOff, turnOn, type DeviceState } from "./push.ts";

type Values = Record<string, unknown>;
interface Device {
  id: number;
  host: string;
  current: boolean;
  state: "active" | "disabled";
  disabled_reason?: string;
}

const REASONS_WITH_SWITCH: [key: string, name: string][] = [
  ["notify.mentions", "Mentions"],
  ["notify.threads", "Thread replies"],
  ["notify.pending_adds", "Requests to add someone"],
  ["notify.machine_requests", "Machine requests"],
];

const STATE_NAME: Record<DeviceState, string> = { on: "On", off: "Off", blocked: "Blocked", "needs-home-screen": "Needs Home Screen", unsupported: "Not available", "chrome-ios": "Not available" };

const WHY_OFF: Record<string, string> = { gone: "gone", failures: "failing", device_revoked: "signed out", user: "turned off" };

/** NotificationSettings is the Notifications section of /settings: push on this device, what pushes, previews and quiet hours. */
export function NotificationSettings() {
  const { fail } = useNotice();
  const [values, setValues] = useState<Values>({});
  const [devices, setDevices] = useState<Device[]>([]);
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState("");
  const [step, setStep] = useState("");

  const load = useCallback(async () => {
    try {
      const all = await call(client.GET("/api/settings"));
      setValues(Object.fromEntries(all.settings.map((s) => [s.key, s.value])));
      setDevices((await call(client.GET("/api/push/subscriptions"))).subscriptions as Device[]);
    } catch (err) {
      fail(humanError(err));
    }
  }, [fail]);
  useEffect(() => void load(), [load]);

  const save = async (key: string, value: unknown) => {
    setValues((v) => ({ ...v, [key]: value }));
    try {
      await call(client.PATCH("/api/settings", { body: { scope: "user", key, value } }));
    } catch (err) {
      fail(humanError(err));
      void load();
    }
  };

  const here = devices.find((d) => d.current && d.state === "active");
  const state = deviceState(Boolean(here));
  const togglePush = async () => {
    setBusy(true);
    fail("");
    try {
      if (here) await turnOff();
      else await turnOn(setStep);
      await load();
    } catch (err) {
      fail(err instanceof PushStepError ? err.message : humanError(err));
    } finally {
      setStep("");
      setBusy(false);
    }
  };
  const test = async () => {
    try {
      const { delivered } = await call(client.POST("/api/push/test"));
      setTested(delivered ? "Sent. It should show up now." : "The push service did not take it.");
    } catch (err) {
      fail(humanError(err));
    }
  };

  const quiet = (values["notify.quiet_hours"] ?? null) as { start: string; end: string; tz: string } | null;
  // oxlint-disable-next-line react/capitalized-calls -- Intl.DateTimeFormat() is a plain factory call, not a component
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const flag = (key: string) => values[key] === true;

  return (
    <>
      <h2>Notifications</h2>
      {state === "chrome-ios" ? (
        <List as="div">
          <ListRow as="div" title="This device" trailing={<span className="text-13 text-muted">Chrome on iPhone has no notifications for web apps. {CHROME_IOS_HINT}</span>} />
        </List>
      ) : state === "needs-home-screen" ? (
        <List as="section" aria-label="Add to Home Screen">
          <ListRow as="p" stacked>
            {onIosThirdPartyBrowser()
              ? "Push on iPhone works only for an app added from Safari. Open Convoz in Safari, then Share → Add to Home Screen, and open it from there."
              : "To turn push on, add Convoz to your Home Screen first: Share → Add to Home Screen."}
          </ListRow>
        </List>
      ) : state === "unsupported" ? (
        <p className="text-13 text-muted">This browser cannot receive push.</p>
      ) : (
        <List as="div">
          <Field type="checkbox" role="switch" label="Push on this device" aria-label="Push on this device" checked={Boolean(here)} disabled={busy} onChange={() => void togglePush()} />
          <ListRow
            as="div"
            title="This device"
            trailing={<span className="text-13 text-muted">{step || (state === "blocked" ? "Blocked. Allow notifications for Convoz in the device settings." : STATE_NAME[state])}</span>}
          />
          {here ? <ListRow as="button" title="Send a test push" trailing={<span className="text-13 text-muted">{tested}</span>} onClick={() => void test()} /> : null}
        </List>
      )}
      {devices.length ? (
        <List aria-label="Push devices">
          {devices.map((d) => (
            <ListRow
              key={d.id}
              trailing={<span className="text-13 text-muted">{d.state === "active" ? "On" : `Off · ${WHY_OFF[d.disabled_reason ?? ""] ?? "off"}`}</span>}
            >
              <span className="min-w-0 grow">
                {d.host}
                {d.current ? " (this device)" : ""}
              </span>
            </ListRow>
          ))}
        </List>
      ) : null}

      <List aria-label="Notification reasons">
        <ListRow
          trailing={
            <select id="notify-asks" value={String(values["notify.asks"] ?? "all")} onChange={(e) => void save("notify.asks", e.target.value)}>
              <option value="all">All</option>
              <option value="urgent">Urgent only</option>
              <option value="none">None</option>
            </select>
          }
        >
          <label className="min-w-0 grow text-13 font-semibold text-muted" htmlFor="notify-asks">
            Asks
          </label>
        </ListRow>
        {REASONS_WITH_SWITCH.map(([key, name]) => (
          <Field key={key} as="li" type="checkbox" role="switch" id={key} label={name} checked={flag(key)} onChange={(e) => void save(key, e.target.checked)} />
        ))}
        <ListRow trailing={<span className="text-13 text-muted">Always on</span>}>
          <span className="min-w-0 grow">Security alerts</span>
        </ListRow>
      </List>

      <h2 id="previews-title">Previews</h2>
      <p className="text-13 text-muted">What the lock screen shows.</p>
      <List as="div" role="radiogroup" aria-labelledby="previews-title">
        {(
          [
            ["full", "Sender and text"],
            ["sender", "Sender only"],
            ["none", "Nothing"],
          ] as const
        ).map(([v, name]) => (
          <Field key={v} type="radio" label={name} name="previews" value={v} checked={(values["notify.previews"] ?? "full") === v} onChange={() => void save("notify.previews", v)} />
        ))}
      </List>

      <h2>Quiet hours</h2>
      <List as="div">
        <Field
          type="checkbox"
          role="switch"
          label="Quiet hours"
          aria-label="Quiet hours"
          checked={quiet !== null}
          onChange={(e) => void save("notify.quiet_hours", e.target.checked ? { start: "22:00", end: "07:00", tz: zone } : null)}
        />
        {quiet ? (
          <>
            <Field type="time" label="From" value={quiet.start} onChange={(e) => e.target.value && void save("notify.quiet_hours", { ...quiet, start: e.target.value })} />
            <Field type="time" label="Until" value={quiet.end} onChange={(e) => e.target.value && void save("notify.quiet_hours", { ...quiet, end: e.target.value })} />
          </>
        ) : null}
        <Field type="checkbox" role="switch" label="Let urgent asks through" aria-label="Let urgent asks through" checked={flag("notify.urgent_bypass")} onChange={(e) => void save("notify.urgent_bypass", e.target.checked)} />
      </List>
    </>
  );
}
