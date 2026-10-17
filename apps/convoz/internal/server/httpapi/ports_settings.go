package httpapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"sync"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/server/settings"
)

// themeBoot is the boot script's ETag, built once: the script is embedded in the binary and never changes while it runs.
var themeBoot = sync.OnceValue(func() string {
	sum := sha256.Sum256(settings.BootScript)
	return `"` + hex.EncodeToString(sum[:]) + `"`
})

func themeBootReader() *bytes.Reader { return bytes.NewReader(settings.BootScript) }
