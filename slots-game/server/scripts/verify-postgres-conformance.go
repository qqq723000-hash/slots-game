//go:build ignore

// verify-postgres-conformance 命令验证严格 PostgreSQL 一致性测试输出的逐行 JSON。
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
)

var expectedTests = []string{
	"TestPostgresProductionRoundAndCredentialConcurrency",
	"TestPostgresFeatureRoundInputStateRecovery",
	"TestPostgresOutboxConcurrentClaimsOrderingAndFencing",
	"TestPostgresConcurrentSessionIntegrityQuarantinePreservesEconomicEvidence",
}

type testEvent struct {
	Action  string `json:"Action"`
	Package string `json:"Package"`
	Test    string `json:"Test"`
}

type testCount struct {
	run  int
	pass int
}

func main() {
	if len(os.Args) != 2 {
		fatalf("usage: verify-postgres-conformance <go-test-json-file>")
	}

	evidence, err := os.Open(os.Args[1])
	if err != nil {
		fatalf("open conformance evidence: %v", err)
	}
	defer evidence.Close()

	expected := make(map[string]*testCount, len(expectedTests))
	for _, name := range expectedTests {
		expected[name] = &testCount{}
	}

	var rejected []string
	scanner := bufio.NewScanner(evidence)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	line := 0
	for scanner.Scan() {
		line++
		if strings.TrimSpace(scanner.Text()) == "" {
			continue
		}

		var event testEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			fatalf("invalid JSON evidence at line %d: %v", line, err)
		}

		if event.Action == "skip" || event.Action == "fail" {
			scope := event.Package
			if event.Test != "" {
				scope = event.Test
			}
			rejected = append(rejected, fmt.Sprintf("%s: %s", event.Action, scope))
		}

		count, isExpected := expected[event.Test]
		if event.Action == "run" && event.Test != "" &&
			!strings.Contains(event.Test, "/") && !isExpected {
			rejected = append(rejected, fmt.Sprintf("unexpected root test: %s", event.Test))
		}
		if !isExpected {
			continue
		}
		switch event.Action {
		case "run":
			count.run++
		case "pass":
			count.pass++
		}
	}
	if err := scanner.Err(); err != nil {
		fatalf("read conformance evidence: %v", err)
	}

	for _, name := range expectedTests {
		count := expected[name]
		if count.run != 1 || count.pass != 1 {
			rejected = append(rejected,
				fmt.Sprintf("%s: run=%d pass=%d, want run=1 pass=1", name, count.run, count.pass))
		}
	}
	if len(rejected) != 0 {
		sort.Strings(rejected)
		for _, reason := range rejected {
			fmt.Fprintf(os.Stderr, "postgres conformance rejected: %s\n", reason)
		}
		os.Exit(1)
	}

	fmt.Printf("verified %d exact PostgreSQL conformance tests\n", len(expectedTests))
}

func fatalf(format string, arguments ...any) {
	fmt.Fprintf(os.Stderr, "postgres conformance rejected: "+format+"\n", arguments...)
	os.Exit(1)
}
