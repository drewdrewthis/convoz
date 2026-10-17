import { call, client, humanError, stepUp } from "../../shared/api.ts";
import { useNotice } from "../../shared/notice.tsx";
import { StepUpSheet, useSheets } from "../../shared/sheets.tsx";

interface Item {
  name: string;
  note: string;
  /** The page that does it; a row without one is not available yet, and says so. */
  href?: string;
}

// What the owner controls about their data and their sign-ins (design §11). Personal access tokens are gone: there is no row for them.
// "Sign out all other devices" is not a page: it opens a passkey check in place.
const ITEMS: Item[] = [
  { name: "Devices", note: "Where you are signed in" },
  { name: "Passkeys", note: "Add or remove a passkey", href: "/settings/passkeys" },
  { name: "Machines", note: "Computers that run your agents", href: "/crew/machines" },
  { name: "Sessions", note: "Agent sessions that are live", href: "/crew" },
  { name: "Sign out all other devices", note: "Needs a passkey" },
  { name: "Export my data", note: "A copy of everything you wrote", href: "/settings/export" },
  { name: "Delete my data", note: "What stays after you delete", href: "/settings/delete" },
];

const SIGN_OUT_ALL = "Sign out all other devices";

/** Privacy is /settings/privacy: everything the owner controls about sign-ins and their data, in one list. */
export function Privacy() {
  const { fail } = useNotice();
  const { sheet, open } = useSheets();

  const signOutAll = () =>
    open((close) => (
      <StepUpSheet
        title={SIGN_OUT_ALL}
        intro="Every other phone and computer is signed out. This device stays signed in."
        confirm="Sign out"
        tone="danger"
        action="signout.all"
        close={close}
        perform={async (stepId) => {
          await call(client.POST("/api/auth/signout-all", { body: {}, params: { header: stepUp(stepId) } })).catch((err) => fail(humanError(err)));
        }}
      />
    ));

  return (
    <>
      <ul className="group" aria-label="Privacy and security">
        {ITEMS.map((i) => {
          const available = Boolean(i.href) || i.name === SIGN_OUT_ALL;
          const body = (
            <>
              <span className="grow">
                {i.name}
                <br />
                <span className="sub">{available ? i.note : `${i.note}. Not available yet.`}</span>
              </span>
              {i.href ? <span className="chev" aria-hidden="true" /> : null}
            </>
          );
          if (i.name === SIGN_OUT_ALL) {
            return (
              <li key={i.name}>
                <button className="row" type="button" onClick={signOutAll}>
                  {body}
                </button>
              </li>
            );
          }
          return <li key={i.name}>{i.href ? <a className="row" href={i.href}>{body}</a> : <div className="row">{body}</div>}</li>;
        })}
      </ul>
      {sheet}
    </>
  );
}
