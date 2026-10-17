// Package search is a server module (design §4.2). Search owns messages_fts, conversations_fts and search_entries: full-text
// search over messages, indexed inside the message transaction by the Index port (httpapi/ports_search.go) and removed
// inside the delete and purge transactions, so no copy of a message outlives it (I-49).
//
// It takes no other module's table. What a query needs from the others (the conversations a viewer may see and their
// titles, the people behind a handle, the viewer's pins and stars, the messages that carry a file) reaches it as a Scope
// the composition root builds, so visibility (I-6) is decided by the owners of those tables and applied here in the same
// statement as the match.
//
// Results are newest first (rowid = message id, which only grows). conversations_fts is not written: a title is matched in
// Go against the viewer's visible conversations, which a rename keeps current without a hook in this module.
package search
