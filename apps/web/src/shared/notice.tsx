// Messages in the page, never alert(): the status banner under the heading and one error (role=alert) after it.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

export interface Notice {
  /** say puts a note in the status banner ("" clears it). */
  say(text: string): void;
  /** fail shows the page's error ("" clears it). */
  fail(text: string): void;
}

const NoticeContext = createContext<Notice>({ say() {}, fail() {} });

/** useNotice is the banner and error of the page this component is on. */
export const useNotice = (): Notice => useContext(NoticeContext);

/** useNoticeState holds a page's banner and error; a frame renders them with <Banners> and provides the Notice. */
export function useNoticeState() {
  const [status, say] = useState("");
  const [alert, setAlert] = useState("");
  const fail = useCallback((text: string) => setAlert(text), []);
  const notice = useMemo<Notice>(() => ({ say, fail }), [fail]);
  return { status, alert, notice, Provider: NoticeContext.Provider };
}

/** Banners are the status line and the error, in that order (the error follows the banner, as in the console). */
export function Banners({ status, alert }: { status: string; alert: string }) {
  const box = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView({ block: "nearest" });
  }, [alert]);
  return (
    <>
      <p id="status" className="banner" role="status" hidden={!status}>
        {status}
      </p>
      {alert ? (
        <p ref={box} role="alert">
          {alert}
        </p>
      ) : null}
    </>
  );
}
