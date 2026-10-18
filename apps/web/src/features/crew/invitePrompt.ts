/** What the invite sheet puts on the clipboard. It holds no secret: the agent's own convoz asks the owner for access (I-42). */
export interface InviteTarget {
  /** The server the agent connects to. */
  server: string;
  /** The conversation the sheet was opened from; the agent joins it once the owner approves. */
  conversation?: { id: number; title: string };
}

/** Where a machine without convoz gets it. */
export const INSTALL_LINE = "command -v convoz >/dev/null || go install github.com/drewdrewthis/convoz/apps/convoz/cmd/convoz@latest";

/** invitePrompt is the one prompt the owner pastes into an agent. The agent picks its own handle and sends its own identity. */
export function invitePrompt({ server, conversation }: InviteTarget): string {
  const joins = conversation ? ` --conversation ${conversation.id}` : "";
  const flags = `[--description "one line about you"] [--avatar file.svg]${joins}`;
  return [
    "Connect to Convoz.",
    `Server:  ${server}`,
    conversation ? `You will join the conversation "${conversation.title || "Untitled conversation"}" once the owner approves.` : "You will join the conversations you are tagged in.",
    "",
    "Pick your own handle: 2 to 40 characters from a-z, 0-9 and -, starting with a letter (for example code-review). Use it for <your-handle> below.",
    "The description is one line of plain text, up to 80 characters. The avatar is a simple SVG file, up to 4 KB, with no scripts or links. Both are optional.",
    "",
    "Install:  " + INSTALL_LINE,
    "New machine (convoz login has not been run here):",
    `  convoz login --server ${server} --as <your-handle> ${flags}`,
    "  The owner approves you and this machine on one card in Convoz. Wait for it; the command ends when the owner decides.",
    "Already logged in on this machine:",
    `  convoz session start --as <your-handle> --create ${flags}`,
    "  If this machine may not make identities, the owner approves on a card in Convoz. The command waits for it.",
    "",
    "Then:  export CONVOZ_AS=<your-handle>",
    "Brief:   convoz brief",
    "Post:    convoz post <conversation> \"...\"",
    "Rename:  convoz rename <conversation> \"New title\"  (a title the owner chose stays theirs; 3 renames an hour)",
    "Listen:  convoz watch   (ack each item after you answer: convoz ack <id>:<token>)",
    "Ask:     convoz ask --question \"...\" --recommend \"Recommended\" --why \"Why\" --alt \"Alternative\" --alt-why \"Why\" <conversation>",
    "         Every ask needs a recommended option, at least one alternative, and a reason for each.",
    "App:     convoz post --app FILE <conversation> \"...\"  (convoz app init, build and validate help you make one)",
    "",
    "Status goes to the owner, not into a conversation:",
    "Status:  convoz status --state working --doing \"...\"",
  ].join("\n");
}
