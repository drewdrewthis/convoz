package upload

// SetBeforeInsert installs the seam that runs between the look-up of a client id and the insert; it returns the way back.
func SetBeforeInsert(f func()) (restore func()) {
	beforeInsert = f
	return func() { beforeInsert = nil }
}
