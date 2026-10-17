// The two page frames around the features: a focused flow (the wordmark and one task) and the signed-in shell (app bar,
// account menu, floating tab bar). A conversation draws its own full-screen frame (features/conversations).
import { AccountIcon, BackIcon, ChatIcon, CrewIcon, NowIcon, PlusIcon } from "@convoz/ui/icons";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { signOut } from "../shared/api.ts";
import { Banners, useNoticeState } from "../shared/notice.tsx";
import { PageHeadContext, type PageHead } from "../shared/page-head.tsx";
import { useNow } from "../features/now/index.ts";
import type { PageDef } from "./routes.tsx";

export function FocusFrame({ def, children }: { def: PageDef; children: ReactNode }) {
  const { status, alert, notice, Provider } = useNoticeState();
  const [heading, setHeadingText] = useState(def.heading);
  const [shown, setShown] = useState(!def.hideHeading);
  const [step, setStep] = useState("");
  const [head] = useState<PageHead>(() => ({
    setHeading(text) {
      setHeadingText(text);
      setShown(text !== "");
      if (text) document.title = `${text} - Convoz`;
    },
    setStep,
  }));
  return (
    <Provider value={notice}>
      <PageHeadContext.Provider value={head}>
        <header className="appbar">
          <a className="brand" href="/">
            Convoz
          </a>
        </header>
        <main>
          {step ? <p className="step">{step}</p> : null}
          <h1 id="heading" hidden={!shown}>
            {heading}
          </h1>
          <Banners status={status} alert={alert} />
          <div id="view">{children}</div>
        </main>
      </PageHeadContext.Provider>
    </Provider>
  );
}

const TABS = [
  { tab: "now", href: "/", label: "Now", Icon: NowIcon, badge: true },
  { tab: "chats", href: "/chats", label: "Conversations", Icon: ChatIcon, badge: false },
  { tab: "crew", href: "/crew", label: "Crew", Icon: CrewIcon, badge: false },
] as const;

export function ShellFrame({ def, children }: { def: PageDef; children: ReactNode }) {
  const { status, alert, notice, Provider } = useNoticeState();
  const requests = useNow((s) => s.machineRequests);
  const loadRequests = useNow((s) => s.loadMachineRequests);
  // The Now tab counts what waits for the owner on every signed-in page; Now loads it for itself.
  useEffect(() => {
    if (def.name !== "now") loadRequests().catch(() => {});
  }, [def.name, loadRequests]);
  const count = requests?.length ?? null;
  const account = useAccountMenu(notice.fail);
  return (
    <Provider value={notice}>
      <header className="appbar">
        <div className="appbar-lead">
          {def.back ? (
            <a className="iconbtn" href={def.back} aria-label="Back">
              <BackIcon />
            </a>
          ) : null}
          <h1 id="heading">{def.heading}</h1>
        </div>
        <div className="appbar-end">
          {def.open ? (
            <span id="open-count" className="open" hidden={count === null}>
              {count === null ? "" : `${count} open`}
            </span>
          ) : null}
          {account.button}
        </div>
      </header>
      {account.menu}
      <div className="screen">
        <main>
          <Banners status={status} alert={alert} />
          <div id="view">{children}</div>
        </main>
        {def.newChat ? (
          <a className="fab" href="/chats/new">
            <PlusIcon />
            New conversation
          </a>
        ) : null}
      </div>
      <nav className="tabbar glass" aria-label="Main">
        {TABS.map(({ tab, href, label, Icon, badge }) => (
          <a key={tab} href={href} aria-current={def.tab === tab ? "page" : undefined}>
            <span className="ico">
              <Icon />
              {badge ? (
                <span id="now-badge" className="badge" hidden={!count}>
                  {count ? String(count) : ""}
                </span>
              ) : null}
            </span>
            <span>{label}</span>
          </a>
        ))}
      </nav>
    </Provider>
  );
}

/** useAccountMenu is the menu button of the top bar and its menu (a sibling of the bar): arrows move between the items,
 *  Escape closes it, Tab leaves it. */
function useAccountMenu(fail: (message: string) => void) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];

  useEffect(() => {
    if (open) items()[0]?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      const list = items();
      const at = list.indexOf(document.activeElement as HTMLElement);
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      } else if (event.key === "Tab") {
        setOpen(false); // focus goes on to the next control as usual
      } else if (at >= 0 && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: list.length - 1 }[event.key]!;
        list[(next + list.length) % list.length]!.focus();
      }
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return {
    button: (
      <button
        ref={button}
        id="account-button"
        className="avatar"
        type="button"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="account-menu"
        onClick={(event) => {
          event.nativeEvent.stopPropagation(); // the document listener must not close what this click opens
          setOpen((o) => !o);
        }}
      >
        <AccountIcon />
      </button>
    ),
    menu: (
      <div ref={menu} id="account-menu" className="menu" role="menu" aria-label="Account" hidden={!open}>
        <a role="menuitem" tabIndex={-1} href="/settings/passkeys">
          Passkeys
        </a>
        <a role="menuitem" tabIndex={-1} href="/settings/recovery">
          Recovery codes
        </a>
        <button role="menuitem" tabIndex={-1} type="button" id="signout" onClick={() => void signOut(fail)}>
          Sign out
        </button>
      </div>
    ),
  };
}
