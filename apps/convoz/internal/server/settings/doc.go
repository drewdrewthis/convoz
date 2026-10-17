// Package settings is a server module (design §4.2, §11). It owns workspace_settings and user_settings: the settings registry.
// Every key, its scope, type, range and default live in registry.go, and Set checks a write against it (I-29). Device-scope
// settings (theme, text size, ...) live on the device and never reach this module.
package settings
