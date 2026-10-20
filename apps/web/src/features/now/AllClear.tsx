import { Wordmark } from "@convoz/ui/Wordmark";
import { Tick } from "./Tick.tsx";

/** AllClear is Now with nothing waiting (owner, msg 275): the wordmark, the "All clear" line where the first item would be, and the fold chips under them, all centred. */
export function AllClear({ hidden }: { hidden: boolean }) {
  return (
    <div id="allclear" hidden={hidden}>
      {/* wordmark and allclear are the hooks of the e2e specs that measure the centring. */}
      <div className="wordmark flex justify-center pt-48 pb-8 [&_svg]:flex-none [&_svg]:[display:block]">
        <Wordmark />
      </div>
      <div className="allclear flex items-center justify-center gap-10 px-4 py-12">
        <Tick />
        <span className="text-14 font-semibold">All clear. Nothing needs you.</span>
      </div>
    </div>
  );
}

/** NoDecisions is the plain, left-aligned line above the unread digest. With something unread the wordmark would push the digest below the fold on a phone (owner, conv 1, msg 562). */
export function NoDecisions() {
  return (
    <p id="nodecisions" className="m-0 flex items-center gap-10 px-4 pt-12 pb-4 text-14 font-semibold">
      <Tick />
      <span>No decisions waiting</span>
    </p>
  );
}
