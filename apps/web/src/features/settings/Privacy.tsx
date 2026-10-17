interface Item {
  name: string;
  note: string;
  /** The page that does it; a row without one is not available yet, and says so. */
  href?: string;
}

// What the owner controls about their data and their sign-ins (design §11). Personal access tokens are gone: there is no row for them.
const ITEMS: Item[] = [
  { name: "Devices", note: "Where you are signed in" },
  { name: "Passkeys", note: "Add or remove a passkey", href: "/settings/passkeys" },
  { name: "Machines", note: "Computers that run your agents", href: "/crew/machines" },
  { name: "Sessions", note: "Agent sessions that are live", href: "/crew" },
  { name: "Sign out all other devices", note: "Needs a passkey" },
  { name: "Export my data", note: "A copy of everything you wrote" },
  { name: "Delete my data", note: "Removes your account for good" },
];

/** Privacy is /settings/privacy: everything the owner controls about sign-ins and their data, in one list. */
export function Privacy() {
  return (
    <ul className="group" aria-label="Privacy and security">
      {ITEMS.map((i) => {
        const body = (
          <>
            <span className="grow">
              {i.name}
              <br />
              <span className="sub">{i.href ? i.note : `${i.note}. Not available yet.`}</span>
            </span>
            {i.href ? <span className="chev" aria-hidden="true" /> : null}
          </>
        );
        return <li key={i.name}>{i.href ? <a className="row" href={i.href}>{body}</a> : <div className="row">{body}</div>}</li>;
      })}
    </ul>
  );
}
