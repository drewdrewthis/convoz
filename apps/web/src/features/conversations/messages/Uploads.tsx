import type { Upload } from "@convoz/api-client";
import { DownloadIcon } from "@convoz/ui/icons";
import { Suspense, useState } from "react";
import { FileGlyph } from "../../../shared/FileGlyph.tsx";
import { useMediaAutoLoads } from "../../../shared/media.ts";
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
            <MessageImage key={u.id} upload={u} />
          ))}
        </div>
      ) : null}
      {files.length ? (
        <div className="mfiles">
          {files.map((u) => (
            <a key={u.id} className="mfile" href={fileUrl(u.id)} download={u.name}>
              <span className="fic" aria-hidden="true">
                <FileGlyph name={u.name} />
              </span>
              <span className="fmeta">
                <span className="fname">{u.name}</span>
                <span className="fsize">{fileSize(u.size)}</span>
              </span>
              <span className="fdl" aria-hidden="true">
                <DownloadIcon />
              </span>
            </a>
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * MessageImage is a safe image of a message, at most 240 px high; a tap opens it whole in its own tab. Where media auto-loads it is
 * drawn at once, else a placeholder with its size stands in and loads on a tap.
 */
function MessageImage({ upload: u }: { upload: Upload }) {
  const auto = useMediaAutoLoads();
  const [tapped, setTapped] = useState(false);
  if (auto || tapped) {
    return (
      <a className="mimg" href={fileUrl(u.id)} target="_blank" rel="noopener" aria-label={`View image ${u.name}`}>
        <img src={fileUrl(u.id)} alt={u.name} loading="lazy" width={u.width} height={u.height} />
      </a>
    );
  }
  return (
    <span className="mimg">
      <button type="button" className="mwait" onClick={() => setTapped(true)}>
        <span className="mname">{u.name}</span>
        <span className="msize">{`${fileSize(u.size)} · tap to load`}</span>
      </button>
    </span>
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
