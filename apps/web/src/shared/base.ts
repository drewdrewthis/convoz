// Where this build of the app is served. The real build (vite build) is at the root; the owner's dev build (vite build --mode dev)
// is at /dev/ on the same server (design: the /dev route), so DEV and BASE are build-time constants and the real build keeps none
// of the dev code. Code that reads the browser's path or sends the browser to a path goes through appPath and withBase.
import { addBase, stripBase } from "./basePath.ts";

/** DEV is true in the owner's dev build. */
export const DEV = import.meta.env.MODE === "dev";
/** BASE is the folder the build is served from, without its last slash: "" for the real app, "/dev" for the dev build. */
export const BASE = DEV ? "/dev" : "";

/** appPath is the app path of the open page (or of pathname): the browser's path without the base. */
export const appPath = (pathname: string = location.pathname): string => stripBase(BASE, pathname);

/** withBase is the browser URL of an app URL: what location.assign, an href or a history entry needs. */
export const withBase = (to: string): string => addBase(BASE, to);
