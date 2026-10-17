import type { Upload } from "@convoz/api-client";
import { FileIcon } from "@convoz/ui/icons";
import { Suspense } from "react";
import { fileSize, fileUrl } from "../../../shared/uploads.ts";
import { VoiceNote } from "../../voice/index.ts";

const inlineImage = (u: Upload) => u.kind === "image" && u.inline;

/**
 * Uploads draws the files of a message after its body: a voice note as its bubble, safe images in the page, any other file as a card
 * that downloads it. A file the markdown body already shows (/api/files/<id>) is not drawn twice.
 */
export function Uploads({ uploads, body }: { uploads: Upload[]; body: string }) {
  if (uploads.length === 1 && uploads[0]!.kind === "audio") {
    return (
      <Suspense fallback={null}>
        <VoiceNote upload={uploads[0]!} />
      </Suspense>
    );
  }
  const shown = uploads.filter((u) => !body.includes(fileUrl(u.id)));
  const images = shown.filter(inlineImage);
  const files = shown.filter((u) => !inlineImage(u));
  return (
    <>
      {images.length ? (
        <div className="mimgs">
          {images.map((u) => (
            <span key={u.id} className="mimg">
              <img src={fileUrl(u.id)} alt={u.name} loading="lazy" width={u.width} height={u.height} />
            </span>
          ))}
        </div>
      ) : null}
      {files.length ? (
        <div className="mfiles">
          {files.map((u) => (
            <a key={u.id} className="mfile" href={fileUrl(u.id)} download={u.name}>
              <span className="fic" aria-hidden="true">
                <FileIcon />
              </span>
              <span className="fmeta">
                <span className="fname">{u.name}</span>
                <span className="fsize">{fileSize(u.size)}</span>
              </span>
            </a>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** PendingFiles names the files of a message still being sent. */
export function PendingFiles({ files }: { files: Upload[] }) {
  return (
    <div className="pfiles">
      {files.map((f) => (
        <span key={f.id}>{f.name}</span>
      ))}
    </div>
  );
}
