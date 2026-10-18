import { CloseIcon, FileIcon } from "@convoz/ui/icons";
import { fileSize } from "../../shared/uploads.ts";
import type { Attachments } from "./attachments.ts";

/** AttachmentList shows the files a message will carry, each with its upload progress, and the note about files left out. */
export function AttachmentList({ attachments }: { attachments: Attachments }) {
  return (
    <>
      {attachments.items.length ? (
        <div role="list" aria-label="Files to send" className="tosend">
          {attachments.items.map((f) => (
            <span key={f.key} role="listitem" className={`fin${f.state === "failed" ? " bad" : ""}`}>
              <span className="fic" aria-hidden="true">
                <FileIcon />
              </span>
              <span className="fname">{f.file.name}</span>
              <span className="fsize">{fileSize(f.file.size)}</span>
              {f.state === "uploading" ? <Progress name={f.file.name} pct={f.file.size ? Math.round((f.sent / f.file.size) * 100) : 0} /> : null}
              {f.state === "failed" ? (
                <>
                  <span className="fbad">Upload failed</span>
                  <button type="button" className="fretry" onClick={() => attachments.retry(f.key)}>
                    Retry
                  </button>
                </>
              ) : null}
              <button type="button" className="fx" aria-label={`Remove ${f.file.name}`} title="Remove" onClick={() => attachments.remove(f.key)}>
                <CloseIcon />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {attachments.note ? (
        <p role="status" className="fnote">
          {attachments.note}
        </p>
      ) : null}
    </>
  );
}

function Progress({ name, pct }: { name: string; pct: number }) {
  return (
    <span className="fbar" role="progressbar" aria-label={`Uploading ${name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <i style={{ width: `${pct}%` }} />
    </span>
  );
}
