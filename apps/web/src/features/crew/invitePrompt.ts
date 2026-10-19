/**
 * What the invite sheet puts on the clipboard. A prompt for a server on the tailnet holds no secret: the agent's own convoz asks the
 * owner for access (I-42). A prompt for the agents-only address carries one invite, which works once and ends after 24 hours.
 */
export interface InviteTarget {
  /** The server the agent connects to: the main address, which the tailnet reaches. */
  server: string;
  /** The agents-only address for the open internet, when the server has one. The prompt then gives both doors, tailnet first. */
  agentServer?: string;
  /** The one-use invite an agent outside the tailnet needs (cvz_i_…). Left out for a server on the tailnet. */
  invite?: string;
  /** The conversation the sheet was opened from; the agent joins it once the owner approves. */
  conversation?: { id: number; title: string };
}

/** Where a machine without convoz gets it: from the server it connects to, so the CLI is the version of that server. */
export const installLine = (server: string): string => `command -v convoz >/dev/null || curl -fsSL ${server}/install | sh`;

/** A code fence keeps `||`, `*` and `_` as typed when the prompt is pasted into Discord, Slack or any markdown field. */
const fenced = (command: string): string[] => ["```", command, "```"];

/** The lesson every agent gets once. Each line is true of the CLI: the thread_root_id field is in `convoz watch --json`. */
const HOW_CONVOZ_WORKS = [
  "How Convoz works:",
  "- Post is a normal answer in the conversation. Use it by default.",
  "- Reply is a thread under one message. Use it only when the watch item has a thread_root_id (the owner wrote inside a thread): convoz reply <thread_root_id> \"...\". Otherwise post.",
  "- An ask is a question that shows as a card in the owner's feed. Send one only when it is the owner's call: a one-way door, a taste or values choice, or scope the owner must own. Say which with --owners-call and --owners-call-why, or the ask is refused. Otherwise weigh the options, decide, and tell the owner in a post. An ask needs a recommended option and a reason, so the owner can answer in one tap.",
  "- An app is a small card that carries context, such as a plan or a design. Attach it with --app.",
  "- Attach files with --file.",
  "- Ack every watch item once you have answered it: convoz ack <ack>.",
  "- Status goes to the owner, not to the chat.",
];

/** invitePrompt is the one prompt the owner pastes into an agent. The agent picks its own handle and sends its own identity. */
export function invitePrompt({ server, agentServer, invite, conversation }: InviteTarget): string {
  const joins = conversation ? ` --conversation ${conversation.id}` : "";
  const flags = `[--description "one line about you"] [--avatar file.svg]${joins}`;
  const invited = invite ? ` --invite ${invite}` : "";
  // The export comes first so the install script, which sees it, can print the login line, and so does every convoz run in this shell.
  const installFor = (s: string) => (invite ? `export CONVOZ_INVITE=${invite}; ${installLine(s)}` : installLine(s));
  // One labeled block per door: each block runs as pasted, with no shell variable to keep between commands.
  const doors: [string, string][] = agentServer ? [["on the tailnet", server], ["from the open internet", agentServer]] : [["", server]];
  const perDoor = (heading: string, command: (s: string) => string): string[] =>
    doors.flatMap(([label, s]) => [label ? `${heading} ${label}:` : `${heading}:`, ...fenced(command(s))]);
  return [
    "Connect to Convoz.",
    ...(agentServer
      ? [`On the tailnet: use ${server}`, `From the open internet: use ${agentServer}`, "Use the one that works from this machine. The invite works on both."]
      : [`Server:  ${server}`]),
    ...(invite ? [`Invite:  ${invite}  (works once, for 24 hours)`] : []),
    conversation ? `You will join the conversation "${conversation.title || "Untitled conversation"}" once the owner approves.` : "You will join the conversations you are tagged in.",
    "",
    "Pick your own handle: 2 to 40 characters from a-z, 0-9 and -, starting with a letter (for example code-review). Use it for <your-handle> below.",
    "The description is one line of plain text, up to 80 characters. The avatar is a simple SVG file, up to 4 KB, with no scripts or links. Both are optional.",
    "",
    ...perDoor("Install (copy the whole block)", installFor),
    ...perDoor("New machine (convoz login has not been run here)", (s) => `convoz login --server ${s}${invited} --as <your-handle> ${flags}`),
    "The owner approves you and this machine on one card in Convoz. Wait for it; the command ends when the owner decides.",
    // No door here: a logged-in machine already holds the address it logged in at.
    "Already logged in on this machine:",
    ...fenced(`convoz session start --as <your-handle> --create${invited} ${flags}`),
    "If this machine may not make identities, the owner approves on a card in Convoz. The command waits for it.",
    "",
    "Right after you connect, start `convoz watch --json` and keep it running in the background: it prints one line per message or ask for you. Answer, then `convoz ack <ack>`.",
    "",
    "Then:  export CONVOZ_AS=<your-handle>",
    "Brief:   convoz brief",
    "Post:    convoz post <conversation> \"...\"  (your normal answer)",
    "Reply:   convoz reply <message> \"...\"  (inside a thread only)",
    "Rename:  convoz rename <conversation> \"New title\"  (a title the owner chose stays theirs; 3 renames an hour)",
    "Listen:  convoz watch   (ack each item after you answer: convoz ack <id>:<token>)",
    "Ask:     convoz ask --question \"...\" --recommend \"Recommended\" --why \"Why\" --alt \"Alternative\" --alt-why \"Why\" --owners-call <one-way|taste|values|scope> --owners-call-why \"Why only the owner can decide\" <conversation>",
    "         Every ask needs a recommended option, at least one alternative, a reason for each, and why it is the owner's call. Without that, decide it yourself.",
    "Files:   convoz post --file report.pdf --file notes.md <conversation> \"...\"  (up to 10 files; the text is optional; convoz reply takes --file too)",
    "App:     convoz post --app FILE <conversation> \"...\"  (convoz app init, build and validate help you make one)",
    "",
    "Status goes to the owner, not into a conversation:",
    "Status:  convoz status --state working --doing \"...\"",
    "",
    ...HOW_CONVOZ_WORKS,
  ].join("\n");
}

/** fetchAgentUrl is the address agents outside the tailnet connect to (the server's agent_url), or null when it has none. */
export async function fetchAgentUrl(): Promise<string | null> {
  const res = await fetch("/api/version");
  if (!res.ok) return null;
  const body: { agent_url?: unknown } = await res.json();
  return typeof body.agent_url === "string" && body.agent_url !== "" ? body.agent_url : null;
}
