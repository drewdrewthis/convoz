import { useEffect } from "react";
import { humanError, signOut } from "../../shared/api.ts";
import { useNotice } from "../../shared/notice.tsx";
import { data, useData } from "../../shared/data.ts";

/** Account is /account: who is signed in, the settings, and Sign out. */
export function Account() {
  const { fail } = useNotice();
  const me = useData((s) => s.me);
  useEffect(() => {
    data.loadMe().catch((err) => fail(humanError(err)));
  }, [fail]);
  return (
    <>
      <p id="who" className="lead">
        {me ? `${me.identity.display_name} (@${me.identity.handle})` : ""}
      </p>
      <div className="group">
        <a className="row" href="/settings/passkeys">
          <span>Passkeys</span>
          <span className="chev" aria-hidden="true" />
        </a>
        <a className="row" href="/settings/recovery">
          <span>Recovery codes</span>
          <span className="chev" aria-hidden="true" />
        </a>
        <a className="row" href="/crew/machines">
          <span>Machines</span>
          <span className="chev" aria-hidden="true" />
        </a>
        <a className="row" href="/trash">
          <span>Trash</span>
          <span className="chev" aria-hidden="true" />
        </a>
        <button className="row danger" type="button" id="signout-row" onClick={() => void signOut(fail)}>
          Sign out
        </button>
      </div>
    </>
  );
}
