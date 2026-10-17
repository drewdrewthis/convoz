// The files a message will carry. Each starts uploading the moment it is chosen or dropped, so Send only waits for the last bytes.
import type { Upload } from "@convoz/api-client";
import { useEffect, useReducer, useRef } from "react";
import { asUpload, uploadFile } from "../../shared/uploads.ts";

/** The most files one message carries (the server refuses more). */
const MOST_FILES = 10;
const TOO_MANY = "10 is the most per message.";

/** One file to send: uploading, failed, or done with its upload. */
export interface Attachment {
  key: string;
  file: File;
  state: "uploading" | "failed" | "done";
  /** Bytes the server holds. */
  sent: number;
  upload?: Upload;
}

export interface Attachments {
  items: Attachment[];
  /** "10 is the most per message." after files were left out, until the list next changes. */
  note: string;
  add(files: File[]): void;
  /** Forget a file. Its upload is left unfinished; the server deletes it after 24 hours. */
  remove(key: string): void;
  retry(key: string): void;
  /** Empty the list (the message was sent). */
  clear(): void;
}

let n = 0;

/**
 * useAttachments holds the files of the composer. The page owns it, so a drop anywhere on the conversation adds to the same list.
 * With no conversation yet (a new one) nothing can be attached: an upload belongs to a conversation.
 */
export function useAttachments(conversationId: number): Attachments {
  const list = useRef<Attachment[]>([]);
  const note = useRef("");
  const jobs = useRef(new Map<string, AbortController>());
  const conv = useRef(conversationId);
  conv.current = conversationId;
  const [, render] = useReducer((x: number) => x + 1, 0);

  const put = (next: Attachment[], text = note.current) => {
    list.current = next;
    note.current = text;
    render();
  };
  const update = (key: string, change: Partial<Attachment>) => put(list.current.map((a) => (a.key === key ? { ...a, ...change } : a)));
  const start = (key: string, file: File) => {
    jobs.current.get(key)?.abort();
    const ctl = new AbortController();
    jobs.current.set(key, ctl);
    uploadFile(conv.current, file, { signal: ctl.signal, onProgress: (sent) => update(key, { sent }) }).then(
      (done) => update(key, { state: "done", sent: file.size, upload: asUpload(done) }),
      () => {
        if (!ctl.signal.aborted) update(key, { state: "failed" });
      },
    );
  };
  const forget = (key: string) => {
    jobs.current.get(key)?.abort();
    jobs.current.delete(key);
  };

  useEffect(() => {
    const running = jobs.current;
    return () => running.forEach((job) => job.abort());
  }, []);

  return {
    items: list.current,
    note: note.current,
    add: (files) => {
      if (!conv.current || !files.length) return;
      const taken = files.slice(0, Math.max(0, MOST_FILES - list.current.length)).map((file): Attachment => ({ key: `f${++n}`, file, state: "uploading", sent: 0 }));
      put([...list.current, ...taken], taken.length < files.length ? TOO_MANY : "");
      for (const a of taken) start(a.key, a.file);
    },
    remove: (key) => {
      forget(key);
      put(
        list.current.filter((a) => a.key !== key),
        "",
      );
    },
    retry: (key) => {
      const a = list.current.find((x) => x.key === key);
      if (!a) return;
      update(key, { state: "uploading", sent: 0 });
      start(key, a.file);
    },
    clear: () => {
      for (const a of list.current) forget(a.key);
      put([], "");
    },
  };
}
