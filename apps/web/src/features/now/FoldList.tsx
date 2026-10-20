import type { ReactNode } from "react";
import { List } from "@convoz/ui/ListRow";

/** FoldList is the raised list under a fold chip (and the list of plan lines that wait on the owner). `foldrows` is the hook of the e2e specs. */
export function FoldList({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <List flush id={id} className="foldrows mt-8">
      {children}
    </List>
  );
}

/** FoldRow is one row of a FoldList: lines one under the other. */
export function FoldRow({ children }: { children: ReactNode }) {
  return <li className="flex flex-col items-start gap-2 px-14 py-10">{children}</li>;
}
