package cli

import (
	"flag"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/drewdrewthis/convoz/apps/convoz/internal/wire"
)

// handleRE is the shape of an agent handle; the server checks the rest (reserved, taken, look-alike).
var handleRE = regexp.MustCompile(`^[a-z][a-z0-9-]{1,39}$`)

// maxAvatarFile is how much of an SVG file the CLI sends; the server cleans it down to 4096 characters.
const maxAvatarFile = 16 << 10

// introFlags are the flags with which an agent says who it is: --description, --avatar and --conversation.
type introFlags struct {
	description  *string
	avatar       *string
	conversation *int64
}

func addIntroFlags(fs *flag.FlagSet) introFlags {
	return introFlags{
		description:  fs.String("description", "", "one line about this agent, up to 80 characters"),
		avatar:       fs.String("avatar", "", "a simple SVG file for the avatar, up to 4 KB"),
		conversation: fs.Int64("conversation", 0, "the conversation the owner opened this from; the agent joins it once approved"),
	}
}

// intro builds the identity an agent sends: handle plus the flags. An error is a usage error.
func (f introFlags) intro(handle, displayName string) (*wire.IdentityIntro, error) {
	handle = strings.ToLower(handle)
	if !handleRE.MatchString(handle) {
		return nil, fmt.Errorf("--as %q is not a handle: 2 to 40 characters from a-z, 0-9 and -, starting with a letter", handle)
	}
	out := &wire.IdentityIntro{Handle: handle, DisplayName: displayName, Description: *f.description, ConversationID: *f.conversation}
	if *f.avatar != "" {
		svg, err := readAvatar(*f.avatar)
		if err != nil {
			return nil, fmt.Errorf("--avatar: %w", err)
		}
		out.AvatarSVG = svg
	}
	return out, nil
}

// readAvatar reads an SVG file for an avatar. The server cleans it (I-32); this only refuses a file that is too big or is no SVG
// at all, so the agent hears it before anything is sent.
func readAvatar(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if len(raw) > maxAvatarFile {
		return "", fmt.Errorf("%s is bigger than %d KB", path, maxAvatarFile>>10)
	}
	if !strings.Contains(strings.ToLower(string(raw)), "<svg") {
		return "", fmt.Errorf("%s is not an SVG file", path)
	}
	return string(raw), nil
}

// given reports whether any identity flag was set.
func (f introFlags) given() bool {
	return *f.description != "" || *f.avatar != "" || *f.conversation != 0
}
