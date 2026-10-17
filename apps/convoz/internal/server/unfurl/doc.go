// Package unfurl is a server module (design §4.2). Unfurl owns unfurls: link preview cards fetched by a worker that never reaches
// a private address.
//
// Queue records the first link of a message; the worker (run by the composition root) takes
// Due jobs, calls Fetcher.Fetch outside any transaction and records the outcome with Settle; Find reads the card back. The
// fetcher resolves a host once, checks every answer with Public and connects to the address it checked, and checks each redirect
// the same way. Agents get the address only: nothing here is ever sent to an agent.
package unfurl
