package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

const (
	policySchemaVersion = 1
	policyRelativePath  = "third-party-licenses/policy.json"
	noticeRelativePath  = "THIRD_PARTY_NOTICES.txt"
)

var productionTargets = []string{"./cmd/rgs-server", "./cmd/rgs-migrator"}

type approvalPolicy struct {
	SchemaVersion int              `json:"schemaVersion"`
	Modules       []approvedModule `json:"modules"`
}

type approvedModule struct {
	Path              string         `json:"path"`
	Version           string         `json:"version"`
	ModuleSum         string         `json:"moduleSum"`
	LicenseExpression string         `json:"licenseExpression"`
	Files             []approvedFile `json:"files"`
}

type approvedFile struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
}

type listedPackage struct {
	Standard bool          `json:"Standard"`
	Module   *listedModule `json:"Module"`
}

type listedModule struct {
	Path    string        `json:"Path"`
	Version string        `json:"Version"`
	Sum     string        `json:"Sum"`
	Dir     string        `json:"Dir"`
	Main    bool          `json:"Main"`
	Replace *listedModule `json:"Replace"`
}

type productionModule struct {
	Path    string
	Version string
	Sum     string
	Dir     string
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "Go 第三方许可门禁失败：%v\n", err)
		os.Exit(1)
	}
}

func run(arguments []string) error {
	flags := flag.NewFlagSet("third-party-notices", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	write := flags.Bool("write", false, "生成并写入权威声明")
	check := flags.Bool("check", false, "校验权威声明未漂移")
	if err := flags.Parse(arguments); err != nil {
		return err
	}
	if flags.NArg() != 0 || (*write == *check) {
		return errors.New("必须且只能指定 --write 或 --check")
	}

	serverRoot, err := findServerRoot()
	if err != nil {
		return err
	}
	policy, err := loadPolicy(filepath.Join(serverRoot, policyRelativePath))
	if err != nil {
		return err
	}
	modules, err := collectProductionModules(serverRoot)
	if err != nil {
		return err
	}
	notice, err := renderNotice(policy, modules)
	if err != nil {
		return err
	}

	noticePath := filepath.Join(serverRoot, noticeRelativePath)
	if *write {
		return writeAtomically(noticePath, notice)
	}
	tracked, err := os.ReadFile(noticePath)
	if err != nil {
		return fmt.Errorf("读取权威声明 %s：%w", noticeRelativePath, err)
	}
	if !bytes.Equal(tracked, notice) {
		return errors.New("权威声明已漂移，请先复核依赖许可，再运行 go run ./scripts/third-party-notices --write")
	}
	return nil
}

func findServerRoot() (string, error) {
	current, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("读取当前目录：%w", err)
	}
	for {
		goModPath := filepath.Join(current, "go.mod")
		content, readErr := os.ReadFile(goModPath)
		if readErr == nil && strings.HasPrefix(string(content), "module slots-game/server\n") {
			return current, nil
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", errors.New("未找到 slots-game/server 模块根目录")
		}
		current = parent
	}
}

func loadPolicy(path string) (approvalPolicy, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return approvalPolicy{}, fmt.Errorf("读取许可审批清单：%w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	var policy approvalPolicy
	if err := decoder.Decode(&policy); err != nil {
		return approvalPolicy{}, fmt.Errorf("解析许可审批清单：%w", err)
	}
	if err := ensureJSONEnd(decoder); err != nil {
		return approvalPolicy{}, err
	}
	return policy, nil
}

func ensureJSONEnd(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); errors.Is(err, io.EOF) {
		return nil
	} else if err != nil {
		return fmt.Errorf("许可审批清单尾部包含非法内容：%w", err)
	}
	return errors.New("许可审批清单只能包含一个 JSON 对象")
}

func collectProductionModules(serverRoot string) (map[string]productionModule, error) {
	arguments := []string{"list", "-deps", "-json", "-mod=readonly"}
	arguments = append(arguments, productionTargets...)
	command := exec.Command("go", arguments...)
	command.Dir = serverRoot
	command.Env = append(os.Environ(), "GOWORK=off", "GOOS=linux", "GOARCH=amd64", "CGO_ENABLED=0")
	var standardOutput bytes.Buffer
	var standardError bytes.Buffer
	command.Stdout = &standardOutput
	command.Stderr = &standardError
	if err := command.Run(); err != nil {
		return nil, fmt.Errorf("解析 Linux/AMD64 生产依赖图：%w：%s", err, strings.TrimSpace(standardError.String()))
	}

	modules := make(map[string]productionModule)
	decoder := json.NewDecoder(&standardOutput)
	for {
		var pkg listedPackage
		if err := decoder.Decode(&pkg); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			return nil, fmt.Errorf("解析 go list 输出：%w", err)
		}
		if pkg.Standard || pkg.Module == nil || pkg.Module.Main {
			continue
		}
		if pkg.Module.Replace != nil {
			return nil, fmt.Errorf("生产依赖 %s@%s 使用 replace，必须先完成单独许可复核", pkg.Module.Path, pkg.Module.Version)
		}
		candidate := productionModule{
			Path:    pkg.Module.Path,
			Version: pkg.Module.Version,
			Sum:     pkg.Module.Sum,
			Dir:     pkg.Module.Dir,
		}
		if candidate.Path == "" || candidate.Version == "" || candidate.Sum == "" || candidate.Dir == "" {
			return nil, fmt.Errorf("生产依赖身份不完整：%q@%q", candidate.Path, candidate.Version)
		}
		if previous, exists := modules[candidate.Path]; exists && previous != candidate {
			return nil, fmt.Errorf("生产依赖 %s 出现多个不同身份", candidate.Path)
		}
		modules[candidate.Path] = candidate
	}
	if len(modules) == 0 {
		return nil, errors.New("生产依赖图为空，拒绝生成误导性许可声明")
	}
	return modules, nil
}

func renderNotice(policy approvalPolicy, modules map[string]productionModule) ([]byte, error) {
	approved, err := validatePolicy(policy, modules)
	if err != nil {
		return nil, err
	}

	paths := make([]string, 0, len(modules))
	for path := range modules {
		paths = append(paths, path)
	}
	sort.Strings(paths)

	var output strings.Builder
	output.WriteString("slots-game Go 生产二进制第三方软件声明\n")
	output.WriteString("\n")
	output.WriteString("本文件由 server/scripts/third-party-notices 根据实际编译依赖图自动生成，请勿手工编辑。\n")
	output.WriteString("覆盖目标：rgs-server、rgs-migrator；平台：Linux/AMD64；CGO：关闭。\n")
	output.WriteString("标准库、仓库自有模块、仅测试依赖与仅构建工具不在本声明中。\n")
	fmt.Fprintf(&output, "生产第三方模块数量：%d\n", len(paths))

	for _, path := range paths {
		module := modules[path]
		approval := approved[path]
		output.WriteString("\n================================================================================\n")
		fmt.Fprintf(&output, "模块：%s@%s\n", module.Path, module.Version)
		fmt.Fprintf(&output, "Go 模块校验和：%s\n", module.Sum)
		fmt.Fprintf(&output, "许可证表达式：%s\n", approval.LicenseExpression)
		for _, file := range approval.Files {
			content, readErr := readApprovedFile(module, file)
			if readErr != nil {
				return nil, readErr
			}
			output.WriteString("\n--------------------------------------------------------------------------------\n")
			fmt.Fprintf(&output, "上游文件：%s\n", file.Name)
			fmt.Fprintf(&output, "SHA-256：%s\n", file.SHA256)
			output.WriteString("--------------------------------------------------------------------------------\n")
			output.Write(content)
			if len(content) == 0 || content[len(content)-1] != '\n' {
				output.WriteByte('\n')
			}
		}
	}
	return []byte(output.String()), nil
}

func validatePolicy(policy approvalPolicy, modules map[string]productionModule) (map[string]approvedModule, error) {
	if policy.SchemaVersion != policySchemaVersion {
		return nil, fmt.Errorf("许可审批清单 schemaVersion 必须为 %d", policySchemaVersion)
	}
	approved := make(map[string]approvedModule, len(policy.Modules))
	previousPath := ""
	for _, module := range policy.Modules {
		if module.Path == "" || module.Version == "" || module.ModuleSum == "" {
			return nil, errors.New("许可审批清单存在身份不完整的模块")
		}
		if previousPath != "" && module.Path <= previousPath {
			return nil, errors.New("许可审批清单中的模块必须按路径严格排序")
		}
		previousPath = module.Path
		if _, exists := approved[module.Path]; exists {
			return nil, fmt.Errorf("许可审批清单重复声明模块 %s", module.Path)
		}
		if err := validateLicenseExpression(module.LicenseExpression); err != nil {
			return nil, fmt.Errorf("模块 %s：%w", module.Path, err)
		}
		if len(module.Files) == 0 {
			return nil, fmt.Errorf("模块 %s 没有审批任何许可证文件", module.Path)
		}
		approved[module.Path] = module
	}

	for path, module := range modules {
		approval, exists := approved[path]
		if !exists {
			return nil, fmt.Errorf("发现未审批的生产依赖 %s@%s", module.Path, module.Version)
		}
		if approval.Version != module.Version || approval.ModuleSum != module.Sum {
			return nil, fmt.Errorf("生产依赖 %s 的版本或模块校验和未获审批", path)
		}
		if err := validateApprovedFiles(module, approval.Files); err != nil {
			return nil, err
		}
	}
	for path, module := range approved {
		if _, exists := modules[path]; !exists {
			return nil, fmt.Errorf("许可审批清单包含非生产依赖 %s@%s", path, module.Version)
		}
	}
	return approved, nil
}

func validateLicenseExpression(expression string) error {
	switch expression {
	case "MIT", "Apache-2.0", "BSD-3-Clause":
		return nil
	default:
		return fmt.Errorf("许可证表达式 %q 未经允许", expression)
	}
}

func validateApprovedFiles(module productionModule, approved []approvedFile) error {
	discovered, err := discoverLicenseFiles(module.Dir)
	if err != nil {
		return fmt.Errorf("模块 %s：%w", module.Path, err)
	}
	approvedByName := make(map[string]approvedFile, len(approved))
	for _, file := range approved {
		if file.Name == "" || filepath.Base(file.Name) != file.Name {
			return fmt.Errorf("模块 %s 的许可证文件名非法：%q", module.Path, file.Name)
		}
		if len(file.SHA256) != sha256.Size*2 {
			return fmt.Errorf("模块 %s 的 %s 缺少完整 SHA-256", module.Path, file.Name)
		}
		if _, err := hex.DecodeString(file.SHA256); err != nil || strings.ToLower(file.SHA256) != file.SHA256 {
			return fmt.Errorf("模块 %s 的 %s 使用非法 SHA-256", module.Path, file.Name)
		}
		if _, exists := approvedByName[file.Name]; exists {
			return fmt.Errorf("模块 %s 重复审批文件 %s", module.Path, file.Name)
		}
		approvedByName[file.Name] = file
	}
	if len(discovered) != len(approvedByName) {
		return fmt.Errorf("模块 %s 的上游许可证或 NOTICE 文件集合未完整审批", module.Path)
	}
	for index, name := range discovered {
		if _, exists := approvedByName[name]; !exists {
			return fmt.Errorf("模块 %s 的上游文件 %s 未审批", module.Path, name)
		}
		if approved[index].Name != name {
			return fmt.Errorf("模块 %s 的上游文件必须按名称严格排序", module.Path)
		}
	}
	for _, file := range approved {
		if _, err := readApprovedFile(module, file); err != nil {
			return err
		}
	}
	return nil
}

func discoverLicenseFiles(moduleDirectory string) ([]string, error) {
	entries, err := os.ReadDir(moduleDirectory)
	if err != nil {
		return nil, fmt.Errorf("读取模块目录：%w", err)
	}
	var names []string
	for _, entry := range entries {
		if entry.IsDir() || !isLicenseFileName(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return nil, fmt.Errorf("读取上游文件 %s：%w", entry.Name(), err)
		}
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("上游文件 %s 不是普通文件", entry.Name())
		}
		names = append(names, entry.Name())
	}
	if len(names) == 0 {
		return nil, errors.New("上游模块根目录缺少 LICENSE、LICENCE、COPYING 或 NOTICE 文件")
	}
	sort.Strings(names)
	return names, nil
}

func isLicenseFileName(name string) bool {
	upper := strings.ToUpper(name)
	for _, prefix := range []string{"LICENSE", "LICENCE", "COPYING", "NOTICE"} {
		if upper == prefix || strings.HasPrefix(upper, prefix+".") || strings.HasPrefix(upper, prefix+"-") {
			return true
		}
	}
	return false
}

func readApprovedFile(module productionModule, file approvedFile) ([]byte, error) {
	path := filepath.Join(module.Dir, file.Name)
	info, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("读取模块 %s 的上游文件 %s：%w", module.Path, file.Name, err)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("模块 %s 的上游文件 %s 不是普通文件", module.Path, file.Name)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取模块 %s 的上游文件 %s：%w", module.Path, file.Name, err)
	}
	digest := sha256.Sum256(content)
	if hex.EncodeToString(digest[:]) != file.SHA256 {
		return nil, fmt.Errorf("模块 %s 的上游文件 %s 哈希未获审批", module.Path, file.Name)
	}
	return content, nil
}

func writeAtomically(path string, content []byte) error {
	temporary, err := os.CreateTemp(filepath.Dir(path), ".third-party-notices.*")
	if err != nil {
		return fmt.Errorf("创建临时声明文件：%w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o644); err != nil {
		temporary.Close()
		return fmt.Errorf("设置临时声明文件权限：%w", err)
	}
	if _, err := temporary.Write(content); err != nil {
		temporary.Close()
		return fmt.Errorf("写入临时声明文件：%w", err)
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return fmt.Errorf("同步临时声明文件：%w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("关闭临时声明文件：%w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("替换权威声明文件：%w", err)
	}
	return nil
}
