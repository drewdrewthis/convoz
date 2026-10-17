package testroutes

// Maintenance runs the nightly clean-up jobs of conversations at once (empty conversations, the trash purge).
const Maintenance = "/__test/maintenance"

func init() { All = append(All, Maintenance) }
