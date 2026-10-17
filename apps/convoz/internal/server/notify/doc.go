// Package notify is a server module (design §4.2, §10). Notify owns push_subscriptions, notifications and push_deliveries: web
// push, the consumer C2 of the event log.
//
// The pipeline has three steps. The worker reads the events after its offset (Source.Events), turns each into the triggers it
// causes (Source.Triggers) and decides every trigger once: sent, or suppressed for a named reason (Decide, AC-7). The decision
// and its queued deliveries commit with the new offset, so a replay changes nothing. The sender then reads what is due, checks
// again that the person may still see what the push is about (I-28), builds the payload from the person's preview setting,
// encrypts it (RFC 8291, by webpush-go), pads it to a 512-byte bucket and posts it to the push service with retries.
//
// The module reads no other module's tables. The composition root (httpapi) implements Source over the event, message,
// conversation, ask, prefs, settings and identity modules.
package notify
