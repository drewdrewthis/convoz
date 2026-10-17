/**
 * DeleteData is /settings/delete: what deleting leaves behind, said before anything is deleted (design §14, "residue").
 * The v1 delete is the owner's purge and `convoz workspace destroy`; the numbers here are the ones the design states.
 */
export function DeleteData() {
  return (
    <>
      <p className="lead">Delete my data</p>
      <p className="muted">Deleting removes a message or a whole workspace. Some traces fade on a schedule, and some cannot be called back.</p>
      <ul className="group" aria-label="What stays after a delete">
        <li className="row">
          <span className="grow">
            Search index
            <br />
            <span className="sub">The search index is cleaned within 24 hours of a delete.</span>
          </span>
        </li>
        <li className="row">
          <span className="grow">
            Backups
            <br />
            <span className="sub">Backups age out within 35 days. A restored backup brings back what it held.</span>
          </span>
        </li>
        <li className="row">
          <span className="grow">
            Notifications
            <br />
            <span className="sub">A notification already shown on a device cannot be recalled.</span>
          </span>
        </li>
      </ul>
      <p className="muted">To destroy the whole workspace, run convoz workspace destroy on the server box.</p>
    </>
  );
}
