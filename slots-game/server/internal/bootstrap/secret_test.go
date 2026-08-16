package bootstrap

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadLaunchHMACKey(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "launch-hmac.key")
	want := []byte(strings.Repeat("k", 32))
	if err := os.WriteFile(path, []byte(base64.StdEncoding.EncodeToString(want)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := LoadLaunchHMACKey(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatal("loaded launch HMAC key differs")
	}
}

func TestLoadLaunchHMACKeyRejectsBroadPermissions(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "launch-hmac.key")
	if err := os.WriteFile(path, []byte(base64.StdEncoding.EncodeToString(make([]byte, 32))), 0o604); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o604); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadLaunchHMACKey(path); err == nil {
		t.Fatal("world-readable launch HMAC key unexpectedly accepted")
	}
}
