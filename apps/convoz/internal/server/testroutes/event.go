package testroutes

// SeedMessages fills a conversation with plain messages in bulk, for the 1M-message fixture of the start-up scenario.
const SeedMessages = "/__test/seed-messages"

func init() { All = append(All, SeedMessages) }
