package cli

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func init() {
	Register(Command{Name: "upgrade", Summary: "Replace this convoz with the version the server runs, and refresh the skill.", Example: "convoz upgrade", Order: 98, Run: Upgrade,
		Usage: "convoz upgrade"})
}

// downloadTimeout bounds one try of the download of one binary: 15 MB over a relayed link takes 30 to 200 seconds.
var downloadTimeout = 10 * time.Minute

// maxBinaryBytes bounds what a server may send as a binary: far above the real size, far below a full disk.
const maxBinaryBytes = 256 << 20

// Upgrade runs `convoz upgrade`: it downloads the binary of this OS and processor from the server, checks it against the sha256 the
// server publishes, swaps it in for the running file, and refreshes the skill file with the new binary. If it cannot write its own
// path it prints the install line instead and changes nothing.
func Upgrade(args []string, io IO) int {
	fs := flag.NewFlagSet("upgrade", flag.ContinueOnError)
	if !parseNoArgs(fs, args, io) {
		return ExitUsage
	}
	dir, err := configDir(io.Getenv)
	if err != nil {
		return fail(io, err)
	}
	server := credentialsServer(dir)
	if server == "" {
		return fail(io, errNotLoggedIn)
	}
	theirs := fetchServerInfo(server).Version
	if theirs == "" {
		return fail(io, fmt.Errorf("%w: cannot ask %s which version it runs", errUnreachable, server))
	}
	if !outOfDate(Version, theirs) && Version != "dev" {
		fmt.Fprintf(io.Stdout, "convoz %s is the version of the server. Nothing to do.\n", Version)
		return ExitOK
	}
	name := fmt.Sprintf("convoz-%s-%s", runtime.GOOS, runtime.GOARCH)
	sum, err := download(server + "/cli/" + name + ".sha256")
	if err != nil {
		return upgradeFailed(io, server, err)
	}
	body, err := download(server + "/cli/" + name + "?v=" + theirs)
	if err != nil {
		return upgradeFailed(io, server, err)
	}
	if err := verifySHA256(body, string(sum)); err != nil {
		return upgradeFailed(io, server, fmt.Errorf("%s: %w. Nothing was changed", name, err))
	}
	exe, err := os.Executable()
	if err == nil {
		exe, err = filepath.EvalSymlinks(exe)
	}
	if err == nil {
		err = replaceExecutable(exe, body)
	}
	if err != nil {
		fmt.Fprintf(io.Stderr, "convoz: cannot replace this program: %s\nInstall the new one with: curl -fsSL %s/install | sh\n", err, server)
		return ExitFailure
	}
	fmt.Fprintf(io.Stdout, "Upgraded convoz %s → %s\n", Version, theirs)
	return refreshSkill(io, exe)
}

func upgradeFailed(io IO, server string, err error) int {
	fmt.Fprintf(io.Stderr, "convoz: upgrade failed: %s\nInstall the new one with: curl -fsSL %s/install | sh\n", err, server)
	return ExitFailure
}

// refreshSkill rewrites the skill file with the NEW binary (this process still holds the old text), but only where the skill is already
// installed: an upgrade does not put files in the folder of an agent that never had them.
func refreshSkill(io IO, exe string) int {
	home := io.Getenv("HOME")
	if home == "" {
		return ExitOK
	}
	skill := filepath.Join(home, ".claude", "skills", "convoz")
	if _, err := os.Stat(filepath.Join(skill, "SKILL.md")); err != nil {
		return ExitOK
	}
	cmd := exec.Command(exe, "skill", "install", "--dir", skill)
	cmd.Stdout, cmd.Stderr = io.Stdout, io.Stderr
	cmd.Env = append(os.Environ(), "HOME="+home)
	if err := cmd.Run(); err != nil {
		fmt.Fprintf(io.Stderr, "convoz: upgraded, but the skill was not refreshed: %s. Run: convoz skill install\n", err)
		return ExitFailure
	}
	return ExitOK
}

// download reads one file of the server, whole, and tries once more on a network error (no progress output). Anything but a 200 is an
// error that is not tried again; the digest is checked by the caller before the binary is replaced.
func download(url string) ([]byte, error) {
	body, err := downloadOnce(url)
	if errors.Is(err, errUnreachable) {
		return downloadOnce(url)
	}
	return body, err
}

func downloadOnce(url string) ([]byte, error) {
	res, err := (&http.Client{Timeout: downloadTimeout}).Get(url)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errUnreachable, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s answered %d", url, res.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, maxBinaryBytes+1))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", errUnreachable, err)
	}
	if len(body) > maxBinaryBytes {
		return nil, errors.New("the file is larger than any convoz")
	}
	return body, nil
}

// verifySHA256 checks body against a digest file: `<hex>  <name>` as sha256sum writes it, or the bare hex.
func verifySHA256(body []byte, digestFile string) error {
	fields := strings.Fields(digestFile)
	if len(fields) == 0 {
		return errors.New("the server published no checksum")
	}
	want, err := hex.DecodeString(strings.ToLower(fields[0]))
	if err != nil || len(want) != sha256.Size {
		return errors.New("the checksum the server published is not a sha256")
	}
	got := sha256.Sum256(body)
	if subtle.ConstantTimeCompare(want, got[:]) != 1 {
		return errors.New("checksum mismatch")
	}
	return nil
}

// replaceExecutable writes body over path as one rename: a temporary file in the same folder (the same file system), made
// executable, then renamed in. A running program keeps its old inode, so a failure at any step leaves the old binary whole.
func replaceExecutable(path string, body []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".convoz-upgrade-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // a no-op after the rename
	if _, err := tmp.Write(body); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o755); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
