package testroutes

// Voice sets the voice key of the test server (the fake token service of Google answers with it) and lists what that service was asked.
const Voice = "/__test/voice"

func init() { All = append(All, Voice) }
