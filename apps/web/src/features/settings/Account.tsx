import { List, ListRow } from "@convoz/ui/ListRow";
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
      <p id="who" className="text-15 text-muted">
        {me ? `${me.identity.display_name} (@${me.identity.handle})` : ""}
      </p>
      <List as="div">
        <ListRow as="a" href="/settings" title="Settings" chevron />
        <ListRow as="a" href="/settings/passkeys" title="Passkeys" chevron />
        <ListRow as="a" href="/settings/recovery" title="Recovery codes" chevron />
        <ListRow as="a" href="/crew/machines" title="Machines" chevron />
        <ListRow as="a" href="/trash" title="Trash" chevron />
        <ListRow as="button" tone="danger" id="signout-row" onClick={() => void signOut(fail)}>
          Sign out
        </ListRow>
      </List>
    </>
  );
}
