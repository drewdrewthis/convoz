import { humanError } from "../../shared/api.ts";
import { setStar, StarIcon } from "../rail/index.ts";
import { toast } from "./toast.ts";

/** StarButton stars or unstars the open conversation from its title bar; a toast says what happened. */
export function StarButton({ id, starred }: { id: number; starred: boolean }) {
  const label = starred ? "Unstar conversation" : "Star conversation";
  return (
    <button
      type="button"
      className="iconbtn starbtn"
      aria-label={label}
      aria-pressed={starred}
      title={label}
      onClick={() => setStar(id, !starred).then(() => toast(starred ? "Unstarred" : "Starred"), (err) => toast(humanError(err)))}
    >
      <StarIcon filled={starred} size={20} />
    </button>
  );
}
