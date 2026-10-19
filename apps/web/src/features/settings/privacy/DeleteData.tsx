import { List, ListRow } from "@convoz/ui/ListRow";

/**
 * DeleteData is /settings/delete: what deleting leaves behind, said before anything is deleted (design §14, "residue").
 * The v1 delete is the owner's purge and `convoz workspace destroy`; the numbers here are the ones the design states.
 */
export function DeleteData() {
  return (
    <>
      <p className="text-15 text-muted">Delete my data</p>
      <p className="text-muted">Deleting removes a message or a whole workspace. Some traces fade on a schedule, and some cannot be called back.</p>
      <List aria-label="What stays after a delete">
        <ListRow>
          <span className="min-w-0 grow">
            Search index
            <br />
            <span className="text-13 text-muted">The search index is cleaned within 24 hours of a delete.</span>
          </span>
        </ListRow>
        <ListRow>
          <span className="min-w-0 grow">
            Backups
            <br />
            <span className="text-13 text-muted">Backups age out within 35 days. A restored backup brings back what it held.</span>
          </span>
        </ListRow>
        <ListRow>
          <span className="min-w-0 grow">
            Notifications
            <br />
            <span className="text-13 text-muted">A notification already shown on a device cannot be recalled.</span>
          </span>
        </ListRow>
      </List>
      <p className="text-muted">To destroy the whole workspace, run convoz workspace destroy on the server box.</p>
    </>
  );
}
