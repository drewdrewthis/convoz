import type { Message, Upload } from "@convoz/api-client";
import { useState } from "react";
import { stripCf } from "../../../shared/chat.ts";
import { fileUrl } from "../../../shared/uploads.ts";
import { readAsText, readSummary } from "./pageRead.ts";
import { PlanNote } from "./PlanNote.tsx";
import { Uploads } from "./Uploads.tsx";

/**
 * NoticeRow is a system line: an icon and muted words, no author and no way to reply (I-8). The owner sees what an agent saw of the
 * shared tab (page-share.feature): under a read, its title and word count, and the exact read on a tap; under a screenshot, the image
 * as a thumbnail that opens full size.
 */
export function NoticeRow({ message, conversation }: { message: Message; conversation: number }) {
  if (message.system?.t === "plan.changed") return <PlanNote message={message} conversation={conversation} />;
  const summary = readSummary(message.system);
  const kept = summary ? message.uploads?.find((u) => u.name === "page-read.json") : undefined;
  const files = message.uploads?.filter((u) => u !== kept) ?? [];
  return (
    <div className="notice-line" role="note" data-t={message.system?.t}>
      <span className="notice-text">{stripCf(message.text ?? message.body)}</span>
      {summary ? <PageRead summary={summary} kept={kept} /> : null}
      {files.length ? (
        <div className="notice-files">
          <Uploads uploads={files} body="" />
        </div>
      ) : null}
    </div>
  );
}

/** PageRead is the summary of an agent's read; when the server kept the read, a tap shows it exactly as the agent got it. */
function PageRead({ summary, kept }: { summary: string; kept: Upload | undefined }) {
  const [text, setText] = useState<string | null>(null);
  if (!kept) return <span className="notice-read">{summary}</span>;
  const load = () => {
    if (text !== null) return;
    setText("Loading…");
    fetch(fileUrl(kept.id))
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((read: unknown) => setText(readAsText(read)))
      .catch(() => setText("The read could not be loaded."));
  };
  return (
    <details className="notice-read" onToggle={(e) => e.currentTarget.open && load()}>
      <summary>{summary}</summary>
      <pre className="notice-readtext">{text}</pre>
    </details>
  );
}
