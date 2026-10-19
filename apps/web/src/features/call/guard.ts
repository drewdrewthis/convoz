/**
 * OwnerIntent is the browser's rule that only the owner's own voice may make the call post (design: a model that reads an agent's
 * words can be talked into asking for things). The model's transcription of the microphone sets it; sending the model an agent's
 * words clears it. A tool call that comes while it is clear is refused, whatever the model says it was asked.
 */
export class OwnerIntent {
  private spoke = false;

  /** The model heard the owner (its input transcription of the microphone). */
  heard(): void {
    this.spoke = true;
  }

  /** An agent's words went to the model: what it does next is not the owner's order until the owner speaks again. */
  quoted(): void {
    this.spoke = false;
  }

  allows(): boolean {
    return this.spoke;
  }
}
