package testroutes

// Notifications reads the notification log, for a scenario that checks a push was suppressed and why.
const Notifications = "/__test/notifications"

func init() { All = append(All, Notifications) }
