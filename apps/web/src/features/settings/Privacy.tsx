import { List, ListRow } from "@convoz/ui/ListRow";
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
      <List aria-label="Privacy and security">
        {ITEMS.map((i) => {
          const available = Boolean(i.href) || i.name === SIGN_OUT_ALL;
          const body = (
            <span className="min-w-0 grow">
              {i.name}
              <br />
              <span className="text-13 text-muted">{available ? i.note : `${i.note}. Not available yet.`}</span>
            </span>
          );
          if (i.name === SIGN_OUT_ALL) {
            return (
              <li key={i.name}>
                <ListRow as="button" onClick={signOutAll}>
                  {body}
                </ListRow>
              </li>
            );
          }
          return (
            <li key={i.name}>
              {i.href ? (
                <ListRow as="a" href={i.href} chevron>
                  {body}
                </ListRow>
              ) : (
                <ListRow as="div">{body}</ListRow>
              )}
            </li>
          );
        })}
      </List>
      {sheet}
    </>
  );
}
