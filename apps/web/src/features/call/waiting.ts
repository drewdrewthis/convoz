/**
 * Waiting is the call's rule that the model speaks once after it passed a question on and then stays silent: no filler while the
 * agent works. The instructions say so too (voice.go), but a model repeats itself anyway, so the page drops the audio of every
 * further turn until the owner speaks, an agent's reply arrives, or the page itself asks for a line (the "no answer yet" notice).
 */
export class Waiting {
  private waiting = false;
  private lineSaid = false;
  private turnHasAudio = false;

  /** A question went to an agent: the turn that speaks next is the one line. */
  begin(): void {
    this.waiting = true;
    this.lineSaid = false;
  }

  /** The owner spoke, or an agent's words were passed on: the model may speak freely again. */
  end(): void {
    this.waiting = false;
  }

  /** The page asks for one more line (the notice that no answer came). */
  allowOneLine(): void {
    if (this.waiting) this.lineSaid = false;
  }

  /** Whether a piece of the model's voice may be played. Call once per piece. */
  allowsAudio(): boolean {
    if (this.waiting && this.lineSaid) return false;
    this.turnHasAudio = true;
    return true;
  }

  /** The model finished a turn. */
  turnDone(): void {
    if (this.waiting && this.turnHasAudio) this.lineSaid = true;
    this.turnHasAudio = false;
  }

  get muting(): boolean {
    return this.waiting && this.lineSaid;
  }
}
