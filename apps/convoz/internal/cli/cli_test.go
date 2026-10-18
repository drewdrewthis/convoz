package cli

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidServer(t *testing.T) {
	for in, want := range map[string]bool{
		"https://convoz.testonly.ts.net":      true,
		"https://convoz.testonly.ts.net:8473": true,
		"http://localhost:8080":               true,
		"http://127.0.0.1:8080":               true,
		"http://convoz.testonly.ts.net":       false,
		"http://10.0.0.5:8080":                false,
		"ftp://localhost":                     false,
		"https://":                            false,
		"https://user:pw@convoz.testonly":     false,
		"https://convoz.testonly/path":        false,
	} {
		if _, err := validServer(in); (err == nil) != want {
			t.Errorf("%s: err=%v want ok=%v", in, err, want)
		}
	}
}

func TestConfigDirPrefersXDG(t *testing.T) {
	env := map[string]string{"HOME": "/home/u"}
	get := func(k string) string { return env[k] }
	if d, _ := configDir(get); d != "/home/u/.config/convoz" {
		t.Errorf("default: %s", d)
	}
	env["XDG_CONFIG_HOME"] = "/x"
	if d, _ := configDir(get); d != "/x/convoz" {
		t.Errorf("xdg: %s", d)
	}
}

type fakeKeychain map[string]string

func (k fakeKeychain) Set(server, secret string) error { k[server] = secret; return nil }
func (k fakeKeychain) Get(server string) (string, error) {
	if v, ok := k[server]; ok {
		return v, nil
	}
	return "", errors.New("not found")
}

type brokenKeychain struct{}

func (brokenKeychain) Set(string, string) error   { return errNoKeychain }
func (brokenKeychain) Get(string) (string, error) { return "", errNoKeychain }

const testKey = "cvz_m_TESTONLYabcdefghijklmnop"

func TestCredentialsStoreAndLoad(t *testing.T) {
	c := Credentials{Server: "http://localhost:1", Machine: "box-2", Key: testKey}

	file := filepath.Join(t.TempDir(), "convoz")
	if err := saveCredentials(file, brokenKeychain{}, c, storeAuto); err != nil {
		t.Fatalf("auto must fall back to the file: %v", err)
	}
	got, err := loadCredentials(file, brokenKeychain{})
	if err != nil || got.Key != testKey || got.Store != storeFile {
		t.Fatalf("file store: %+v %v", got, err)
	}
	for _, p := range []string{file, filepath.Join(file, credentialsFile)} {
		info, _ := os.Stat(p)
		if info.Mode().Perm()&0o077 != 0 {
			t.Errorf("%s is %v", p, info.Mode().Perm())
		}
	}

	if err := saveCredentials(filepath.Join(t.TempDir(), "convoz"), brokenKeychain{}, c, storeKeychain); err == nil {
		t.Error("--store keychain must fail when there is no keychain")
	}

	kc := fakeKeychain{}
	dir := filepath.Join(t.TempDir(), "convoz")
	if err := saveCredentials(dir, kc, c, storeAuto); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, credentialsFile))
	if strings.Contains(string(raw), testKey) {
		t.Error("with the keychain store the key must not be in the file")
	}
	if got, err := loadCredentials(dir, kc); err != nil || got.Key != testKey {
		t.Fatalf("keychain store: %+v %v", got, err)
	}
}

func TestLooseModesAreRefusedWithThePathAndTheMode(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "convoz")
	if err := saveCredentials(dir, brokenKeychain{}, Credentials{Server: "http://localhost:1", Machine: "m", Key: testKey}, storeFile); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, credentialsFile)
	for _, c := range []struct {
		path string
		mode os.FileMode
		need string
	}{{file, 0o644, "0600"}, {file, 0o640, "0600"}, {dir, 0o755, "0700"}} {
		if err := os.Chmod(c.path, c.mode); err != nil {
			t.Fatal(err)
		}
		_, err := loadCredentials(dir, brokenKeychain{})
		var perm *permError
		if !errors.As(err, &perm) || !strings.Contains(err.Error(), c.path) || !strings.Contains(err.Error(), c.need) {
			t.Errorf("%s at %v: %v", c.path, c.mode, err)
		}
		_ = os.Chmod(file, 0o600)
		_ = os.Chmod(dir, 0o700)
	}
}

func TestSessionIDsCannotEscapeTheSessionsDirectory(t *testing.T) {
	for _, bad := range []string{"", "../credentials", "ABCDEF", "abc", "a1b2c3/../x"} {
		if _, ok := sessionPath("/cfg", bad); ok {
			t.Errorf("%q must not be a session id", bad)
		}
	}
	if p, ok := sessionPath("/cfg", "a1b2c3"); !ok || p != "/cfg/sessions/a1b2c3" {
		t.Errorf("%q %v", p, ok)
	}
}

func TestSessionFilesAreReplacedPerClient(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "convoz")
	first, err := saveSession(dir, sessionFile{Lease: "cvz_s_a", Identity: "devtool", Machine: "box-2", ClientID: "claude-1234"})
	if err != nil {
		t.Fatal(err)
	}
	other, _ := saveSession(dir, sessionFile{Lease: "cvz_s_b", Identity: "devtool", Machine: "box-2", ClientID: "claude-9999"})
	if findSession(dir, "devtool", "claude-1234") != first {
		t.Fatal("the session of the client id is found")
	}
	forgetSessions(dir, sessionFile{Identity: "devtool"}, "claude-1234")
	if findSession(dir, "devtool", "claude-1234") != "" {
		t.Error("the replaced client's file must be gone")
	}
	if findSession(dir, "devtool", "claude-9999") != other {
		t.Error("another client's file must stay")
	}
}
