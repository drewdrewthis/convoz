import type { ComponentType } from "react";
import { navigate } from "../../shared/navigate.ts";
import { appPath, withBase } from "../../shared/base.ts";
import { Now } from "../now/index.ts";
import type { PanelId } from "./panel.ts";
import { withPanel } from "./panel.ts";

export interface PanelDef {
  title: string;
  /** The body of the drawer. `current` is the conversation open beside it (0: none). */
  Body: ComponentType<{ current: number }>;
}

/** A pick in a panel opens its conversation in the middle and keeps the drawer open, without a page load. */
export function pick(event: { target: EventTarget; defaultPrevented: boolean; button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault(): void }, panel: PanelId): void {
  const href = (event.target as Element).closest("a")?.getAttribute("href");
  if (!href?.startsWith("/chats/") || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(withBase(withPanel(href, panel)));
}

const NowBody = ({ current }: { current: number }) => <Now compact current={current} />;

/** What each panel is called and draws. */
export const PANELS: Record<PanelId, PanelDef> = {
  now: { title: "Now", Body: NowBody },
};

export const openedChat = (): number => Number(/^\/chats\/(\d+)$/.exec(appPath())?.[1] ?? 0);
