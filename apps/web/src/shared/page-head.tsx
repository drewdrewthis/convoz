import { createContext, useContext } from "react";

/** What a focused page may change about its frame: the heading (it also names the tab; "" hides it) and the step line. */
export interface PageHead {
  setHeading(text: string): void;
  setStep(text: string): void;
}

export const PageHeadContext = createContext<PageHead>({ setHeading() {}, setStep() {} });

export const usePageHead = (): PageHead => useContext(PageHeadContext);
