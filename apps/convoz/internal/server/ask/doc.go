// Package ask is a server module (design §4.2). Ask owns asks, ask_options, ask_snoozes and ask_transitions: an agent's
// question with a recommendation and alternatives, the state machine of design §8.1 (every change a compare-and-swap on the
// version, every change one history row), answers, and the per-person snooze that never touches the ask.
//
// The module writes nothing outside its tables. What a change also does elsewhere (the ask message and the answer message,
// the open-ask counter, the asker's inbox item, the thin event, the snooze-wake notification) goes through the ports the
// caller declares in Ports, inside the caller's transaction.
package ask
