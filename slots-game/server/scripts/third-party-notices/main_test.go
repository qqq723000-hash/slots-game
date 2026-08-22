package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCollectProductionModulesExcludesTestOnlyDependencies(t *testing.T) {
	serverRoot := filepath.Clean(filepath.Join("..", ".."))
	modules, err := collectProductionModules(serverRoot)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := modules["github.com/DATA-DOG/go-sqlmock"]; exists {
		t.Fatal("仅测试依赖 go-sqlmock 被错误列入生产许可声明")
	}
	if len(modules) != 8 {
		t.Fatalf("生产第三方模块数量错误：got %d want 8", len(modules))
	}
}

func TestRenderNoticeRejectsUnknownProductionDependency(t *testing.T) {
	policy, modules := loadCurrentInputs(t)
	modules["example.invalid/unapproved"] = productionModule{
		Path:    "example.invalid/unapproved",
		Version: "v1.0.0",
		Sum:     "h1:unapproved",
		Dir:     t.TempDir(),
	}
	_, err := renderNotice(policy, modules)
	if err == nil || !strings.Contains(err.Error(), "未审批的生产依赖") {
		t.Fatalf("未审批依赖没有失败关闭：%v", err)
	}
}

func TestRenderNoticeRejectsNonProductionApproval(t *testing.T) {
	policy, modules := loadCurrentInputs(t)
	policy.Modules = append(policy.Modules, approvedModule{
		Path:              "zzz.invalid/test-only",
		Version:           "v1.0.0",
		ModuleSum:         "h1:test-only",
		LicenseExpression: "MIT",
		Files: []approvedFile{{
			Name:   "LICENSE",
			SHA256: strings.Repeat("0", 64),
		}},
	})
	_, err := renderNotice(policy, modules)
	if err == nil || !strings.Contains(err.Error(), "非生产依赖") {
		t.Fatalf("非生产依赖审批没有失败关闭：%v", err)
	}
}

func TestRenderNoticeRejectsLicenseHashDrift(t *testing.T) {
	policy, modules := loadCurrentInputs(t)
	policy = clonePolicy(t, policy)
	policy.Modules[0].Files[0].SHA256 = strings.Repeat("0", 64)
	_, err := renderNotice(policy, modules)
	if err == nil || !strings.Contains(err.Error(), "哈希未获审批") {
		t.Fatalf("许可证哈希漂移没有失败关闭：%v", err)
	}
}

func TestRenderNoticeRejectsMissingUpstreamLicense(t *testing.T) {
	module := productionModule{
		Path:    "example.invalid/missing-license",
		Version: "v1.0.0",
		Sum:     "h1:missing-license",
		Dir:     t.TempDir(),
	}
	policy := approvalPolicy{
		SchemaVersion: policySchemaVersion,
		Modules: []approvedModule{{
			Path:              module.Path,
			Version:           module.Version,
			ModuleSum:         module.Sum,
			LicenseExpression: "MIT",
			Files: []approvedFile{{
				Name:   "LICENSE",
				SHA256: strings.Repeat("0", 64),
			}},
		}},
	}
	_, err := renderNotice(policy, map[string]productionModule{module.Path: module})
	if err == nil || !strings.Contains(err.Error(), "缺少 LICENSE") {
		t.Fatalf("缺失上游许可证没有失败关闭：%v", err)
	}
}

func TestTrackedNoticeMatchesProductionGraph(t *testing.T) {
	serverRoot := filepath.Clean(filepath.Join("..", ".."))
	policy, modules := loadCurrentInputs(t)
	generated, err := renderNotice(policy, modules)
	if err != nil {
		t.Fatal(err)
	}
	tracked, err := os.ReadFile(filepath.Join(serverRoot, noticeRelativePath))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(tracked, generated) {
		t.Fatal("权威第三方声明与生产依赖图不一致")
	}
}

func loadCurrentInputs(t *testing.T) (approvalPolicy, map[string]productionModule) {
	t.Helper()
	serverRoot := filepath.Clean(filepath.Join("..", ".."))
	policy, err := loadPolicy(filepath.Join(serverRoot, policyRelativePath))
	if err != nil {
		t.Fatal(err)
	}
	modules, err := collectProductionModules(serverRoot)
	if err != nil {
		t.Fatal(err)
	}
	return policy, modules
}

func clonePolicy(t *testing.T, policy approvalPolicy) approvalPolicy {
	t.Helper()
	content, err := json.Marshal(policy)
	if err != nil {
		t.Fatal(err)
	}
	var cloned approvalPolicy
	if err := json.Unmarshal(content, &cloned); err != nil {
		t.Fatal(err)
	}
	return cloned
}
