package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRunMaterializesRestrictedFilesWithoutOverwrite(t *testing.T) {
	directory := t.TempDir()
	source := filepath.Join(directory, "source")
	destination := filepath.Join(directory, "destination")
	if err := os.WriteFile(source, []byte("secret-value"), 0o440); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{source, destination}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(destination)
	if err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o400 || string(contents) != "secret-value" {
		t.Fatalf("destination mode/content = %04o/%q", info.Mode().Perm(), contents)
	}
	if err := run([]string{source, destination}); err == nil {
		t.Fatal("existing destination unexpectedly overwritten")
	}
}
