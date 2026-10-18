/**
 * What the invite sheet puts on the clipboard. A prompt for a server on the tailnet holds no secret: the agent's own convoz asks the
 * owner for access (I-42). A prompt for the agents-only address carries one invite, which works once and ends after 24 hours.
 */
export interface InviteTarget {
  /** The server the agent connects to. */
  server: string;
  /** The one-use invite an agent outside the tailnet needs (cvz_i_…). Left out for a server on the tailnet. */
  invite?: string;
  /** The conversation the sheet was opened from; the agent joins it once the owner approves. */
  conversation?: { id: number; title: string };
}

/** Where a machine without convoz gets it: from the server it connects to, so the CLI is the version of that server. */
export const installLine = (server: string): string => `command -v convoz >/dev/null || curl -fsSL ${server}/install | sh`;

/** invitePrompt is the one prompt the owner pastes into an agent. The agent picks its own handle and sends its own identity. */
export function invitePrompt({ server, invite, conversation }: InviteTarget): string {
  const joins = conversation ? ` --conversation ${conversation.id}` : "";
  const flags = `[--description "one line about you"] [--avatar file.svg]${joins}`;
  const invited = invite ? ` --invite ${invite}` : "";
  // The export comes first so the install script, which sees it, can print the login line, and so does every convoz run in this shell.
  const install = invite ? `export CONVOZ_INVITE=${invite}; ${installLine(server)}` : installLine(server);
  return [
    "Connect to Convoz.",
    `Server:  ${server}`,
    ...(invite ? [`Invite:  ${invite}  (works once, for 24 hours)`] : []),
    conversation ? `You will join the conversation "${conversation.title || "Untitled conversation"}" once the owner approves.` : "You will join the conversations you are tagged in.",
    "",
    "Pick your own handle: 2 to 40 characters from a-z, 0-9 and -, starting with a letter (for example code-review). Use it for <your-handle> below.",
    "The description is one line of plain text, up to 80 characters. The avatar is a simple SVG file, up to 4 KB, with no scripts or links. Both are optional.",
    "",
    "Install:  " + install,
    "New machine (convoz login has not been run here):",
    `  convoz login --server ${server}${invited} --as <your-handle> ${flags}`,
    "  The owner approves you and this machine on one card in Convoz. Wait for it; the command ends when the owner decides.",
    "Already logged in on this machine:",
    `  convoz session start --as <your-handle> --create${invited} ${flags}`,
    "  If this machine may not make identities, the owner approves on a card in Convoz. The command waits for it.",
    "",
    "Right after you connect, start `convoz watch --json` and keep it running in the background: it prints one line per message or ask for you. Answer, then `convoz ack <ack>`.",
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

/** fetchAgentUrl is the address agents outside the tailnet connect to (the server's agent_url), or null when it has none. */
export async function fetchAgentUrl(): Promise<string | null> {
  const res = await fetch("/api/version");
  if (!res.ok) return null;
  const body: { agent_url?: unknown } = await res.json();
  return typeof body.agent_url === "string" && body.agent_url !== "" ? body.agent_url : null;
}
