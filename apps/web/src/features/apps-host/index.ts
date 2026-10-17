// Apps host: renders app messages (Tier 1 kits from packages/app-kit, Tier 2 sandboxed frames) and the "via app" mark.
// It draws inside a conversation, not at a URL of its own.
export { AppHost, type AppHostProps } from "./AppHost.tsx";
export { ViaAppMark } from "./ViaAppMark.tsx";
import "./apps-host.css";
