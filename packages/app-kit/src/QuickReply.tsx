import { Button } from "@convoz/ui/Button";

export interface QuickReplyProps {
  text: string;
  setText(v: string): void;
  busy?: boolean;
  onSend(): void;
}

/** QuickReply is the one-line reply box under a decision ask: type, Send. */
export function QuickReply({ text, setText, busy, onSend }: QuickReplyProps) {
  return (
    <form
      className="mt-6 flex items-center gap-8"
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
    >
      {/* eslint-disable-next-line convoz/no-raw-input -- a pill with no visible label (aria-label); Field draws a label above its input */}
      <input aria-label="Quick reply" type="text" autoFocus value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} className="h-52 w-full min-w-0 flex-auto rounded-full border border-solid border-edge bg-raised px-16 text-16 text-text [font-family:inherit]" />
      <Button variant="primary" size="inline" type="submit" disabled={busy || !text.trim()}>
        Send
      </Button>
    </form>
  );
}
