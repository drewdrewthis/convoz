package testroutes

// Push is the fake push service of the test build: GET lists every push it received, POST scripts its answers (a status per
// endpoint), holds or releases the sender, and rewinds the push worker's offset to replay the whole event log.
const Push = "/__test/push"

func init() { All = append(All, Push) }
