import { IconButton } from "@convoz/ui/IconButton";
import { CloseIcon } from "@convoz/ui/icons";
import { FileGlyph } from "../../shared/FileGlyph.tsx";
import { fileSize, fileUrl } from "../../shared/uploads.ts";
import type { Attachment, Attachments } from "./attachments.ts";

/**
 * AttachmentList shows the files a message will carry as a row of chips that scrolls sideways: a safe image as a 56 px thumbnail, any
 * other file as a chip with its icon, name and size, each with its upload progress and an x, and the note about files left out.
 */
export function AttachmentList({ attachments }: { attachments: Attachments }) {
  return (
    <>
      {attachments.items.length ? (
        <div role="list" aria-label="Files to send" className="tosend">
          {attachments.items.map((f) => (
            <span key={f.key} role="listitem" className={`fin${f.state === "failed" ? " bad" : ""}`}>
              <Chip file={f} />
              {f.state === "failed" ? (
                <button type="button" className="fretry" onClick={() => attachments.retry(f.key)}>
                  Retry
                </button>
              ) : null}
              {/* The tap area is 44 px; the dot is 20 px and sits on the corner. */}
              <IconButton variant="muted" glyph="self" className="absolute -top-10 -right-10" label={`Remove ${f.file.name}`} title="Remove" onClick={() => attachments.remove(f.key)}>
                <span aria-hidden="true" className="flex size-20 items-center justify-center rounded-full bg-text text-bg [&_svg]:size-10 [&_svg]:[stroke-width:3]">
                  <CloseIcon />
                </span>
              </IconButton>
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

/** Chip is one file: its thumbnail once the server holds a safe image (the server's own copy, so nothing but the page's origin is loaded), else the file chip. */
function Chip({ file: f }: { file: Attachment }) {
  const name = f.file.name;
  const up = f.upload;
  if (f.state === "done" && up?.kind === "image" && up.inline) {
    return (
      <>
        <img className="fthumb" src={fileUrl(up.id)} alt="" width={56} height={56} />
        <span className="sr">{name}</span>
      </>
    );
  }
  return (
    <span className="fchip">
      <span className="fic" aria-hidden="true">
        <FileGlyph name={name} />
      </span>
      <span className="fmeta">
        <span className="fname">{name}</span>
        {f.state === "failed" ? (
          <span className="fbad">Upload failed</span>
        ) : (
          <span className="fline">
            <span className="fsize">{fileSize(f.file.size)}</span>
            {f.state === "uploading" ? <Progress name={name} pct={f.file.size ? Math.round((f.sent / f.file.size) * 100) : 0} /> : null}
          </span>
        )}
      </span>
    </span>
  );
}

function Progress({ name, pct }: { name: string; pct: number }) {
  return (
    <span className="fbar" role="progressbar" aria-label={`Uploading ${name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <i style={{ width: `${pct}%` }} />
    </span>
  );
}
