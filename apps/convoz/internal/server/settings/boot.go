package settings

import _ "embed"

// BootScript is the classic script every page loads in <head> as /assets/settings/theme-boot.js: it sets the look before the first paint.
//
//go:embed boot.js
var BootScript []byte
