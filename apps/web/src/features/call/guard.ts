/**
 * OwnerIntent is the browser's rule that only the owner's own voice may make the call post (design: a model that reads an agent's
 * words can be talked into asking for things). The model's transcription of the microphone sets it; sending the model an agent's
 * words clears it. A tool call that comes while it is clear is refused, whatever the model says it was asked.
 */
export class OwnerIntent {
  private spoke = false;
  private times = 0;

  /** The model heard the owner (its input transcription of the microphone). */
  heard(): void {
    this.spoke = true;
    this.times++;
  }

  /** How often the owner has spoken on this call: a held write notes it, and its yes must come after (writes.ts Held). */
  get spoken(): number {
    return this.times;
  }

  /** An agent's words went to the model: what it does next is not the owner's order until the owner speaks again. */
  quoted(): void {
    this.spoke = false;
  }

  allows(): boolean {
    return this.spoke;
  }

  /**
   * Uses up the owner's words for one write that runs at once: true when they were the latest input to the model. A second write from the
   * same words (or after a read) is not his order, so it is held for his yes instead.
   */
  spend(): boolean {
    const had = this.spoke;
    this.spoke = false;
    return had;
  }
}
