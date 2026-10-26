// Events of the web app that carry no content, counted by the server (POST /api/client-events). Only the event's name goes:
// never the message, the conversation or the error. The server counts it in its metrics when telemetry is on; nothing is stored.

/** reportSendFailed tells the server that a send the owner sees as failed has failed (not each retry). Errors are ignored. */
export function reportSendFailed(): void {
  // keepalive, as in clientErrors.ts: the failure is often what makes the owner leave the page.
  fetch("/api/client-events", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json", "X-Convoz": "1" }, body: JSON.stringify({ event: "send_failed" }) }).catch(() => {});
}
