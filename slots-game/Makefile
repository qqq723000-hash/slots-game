.PHONY: bootstrap web smoke-runtime-operations smoke-runtime-production test test-postgres test-race benchmark-engine profile-http-high-concurrency profile-postgres-high-concurrency profile-valkey-high-concurrency vet build migrate-postgres verify-postgres-schema verify-web-container-contract verify-web-browser-bootstrap verify-observability-contract test-observability-rendered-contract test-vector-bounded-flush test-local-web-candidate-payload verify-observability-release verify-supply-chain-contract verify-backend-licenses verify-chinese-comments verify-personal-project-docs verify-hardening-checklist verify-hardening-stability-contract verify-hardening-stability-50 verify-cluster-production verify-aws-production verify-terraform verify-cluster-image-contract verify-cluster-prometheus-rules verify-deployment-contracts build-runtime-image build-migrator-image build-web-release-image verify verify-backend

BROWSER_SMOKE_ENV := VITE_RGS_BASE_URL=https://rgs.ci.invalid VITE_RGS_BET_OPTIONS_MINOR=100,200,500 VITE_RGS_DEFAULT_BET_MINOR=200 VITE_RGS_HOST_ORIGIN=https://operator.ci.invalid

bootstrap:
	cd web && npm ci

web:
	cd web && npm run dev

smoke-runtime-operations: verify-supply-chain-contract
	./deploy/observability/ci-runtime-smoke.sh

smoke-runtime-production: verify-supply-chain-contract
	./deploy/observability/ci-runtime-production-smoke.sh

test:
	cd server && go test ./...
	# 发布聚合门禁串行执行 Vitest，避免大型素材 fixture 争用 CPU/内存造成非确定性超时。
	cd web && npm test -- --run --fileParallelism=false

test-postgres:
	./server/scripts/postgres-conformance.sh

benchmark-engine:
	cd server && go test ./internal/game -run '^$$' -bench '^BenchmarkEngineSpinRepresentative$$' -benchmem -count=5

# 高并发 profile 必须显式提供隔离环境/批准阈值；生成物写入 ignored .artifacts，
# 不属于普通快速单测，也不能替代 AWS、第三方钱包或长时间 soak 认证。
profile-http-high-concurrency:
	./server/scripts/http-high-concurrency.sh

profile-postgres-high-concurrency:
	./server/scripts/postgres-high-concurrency.sh

profile-valkey-high-concurrency:
	./server/scripts/valkey-high-concurrency.sh

migrate-postgres:
	cd server && go run ./cmd/rgs-migrator up

verify-postgres-schema:
	cd server && go run ./cmd/rgs-migrator verify

build-runtime-image: verify-supply-chain-contract verify-backend-licenses
	docker build --file deploy/Dockerfile --target runtime --tag slots-rgs-runtime:local .

build-migrator-image: verify-supply-chain-contract verify-backend-licenses
	docker build --file deploy/Dockerfile --target migrator --tag slots-rgs-migrator:local .

# 生产发布构建必须使用仓库外管理的审批文件；严禁提交该文件。
build-web-release-image: verify-supply-chain-contract
	test -n "$${RELEASE_ASSET_APPROVAL_FILE:-}" || { echo "RELEASE_ASSET_APPROVAL_FILE is required" >&2; exit 2; }
	test -r "$${RELEASE_ASSET_APPROVAL_FILE}" || { echo "RELEASE_ASSET_APPROVAL_FILE must name a readable approval file" >&2; exit 2; }
	test -n "$${VITE_RGS_BASE_URL:-}" || { echo "VITE_RGS_BASE_URL is required" >&2; exit 2; }
	test -n "$${VITE_RGS_BET_OPTIONS_MINOR:-}" || { echo "VITE_RGS_BET_OPTIONS_MINOR is required" >&2; exit 2; }
	test -n "$${VITE_RGS_DEFAULT_BET_MINOR:-}" || { echo "VITE_RGS_DEFAULT_BET_MINOR is required" >&2; exit 2; }
	test -n "$${VITE_RGS_HOST_ORIGIN:-}" || { echo "VITE_RGS_HOST_ORIGIN is required" >&2; exit 2; }
	test -n "$${WEB_RELEASE_VERSION:-}" || { echo "WEB_RELEASE_VERSION is required" >&2; exit 2; }
	test -n "$${WEB_RELEASE_REVISION:-}" || { echo "WEB_RELEASE_REVISION is required" >&2; exit 2; }
	DOCKER_BUILDKIT=1 docker build --file deploy/web/Dockerfile --target runtime \
		--build-arg VITE_RGS_BASE_URL="$${VITE_RGS_BASE_URL}" \
		--build-arg VITE_RGS_BET_OPTIONS_MINOR="$${VITE_RGS_BET_OPTIONS_MINOR}" \
		--build-arg VITE_RGS_DEFAULT_BET_MINOR="$${VITE_RGS_DEFAULT_BET_MINOR}" \
		--build-arg VITE_RGS_HOST_ORIGIN="$${VITE_RGS_HOST_ORIGIN}" \
		--build-arg WEB_RELEASE_VERSION="$${WEB_RELEASE_VERSION}" \
		--build-arg WEB_RELEASE_REVISION="$${WEB_RELEASE_REVISION}" \
		--secret id=release_asset_approval,src="$${RELEASE_ASSET_APPROVAL_FILE}" \
		--tag slots-web-runtime:local .

verify-web-container-contract: verify-supply-chain-contract
	./deploy/web/verify-static-contract.sh

verify-web-browser-bootstrap:
	cd web && $(BROWSER_SMOKE_ENV) npm run build:browser-smoke

verify-observability-contract:
	./deploy/observability/verify-static-contract.sh
	$(MAKE) test-observability-rendered-contract

test-observability-rendered-contract:
	./deploy/observability/test-rendered-contract.sh

# VECTOR_IMAGE 必须已由调用方按 digest 预载；行为门禁自身禁止访问镜像仓库。
test-vector-bounded-flush:
	@./deploy/observability/test-vector-bounded-flush.sh

# 固定基础镜像必须已预载；该真实构建门禁不读取或修改本机生产部署状态。
test-local-web-candidate-payload:
	@./deploy/local-production/test-web-candidate-payload.sh

verify-observability-release:
	test -n "$${OBSERVABILITY_RENDERED_DIR:-}" || { echo "OBSERVABILITY_RENDERED_DIR is required" >&2; exit 2; }
	./deploy/observability/verify-static-contract.sh --rendered-dir "$${OBSERVABILITY_RENDERED_DIR}"

verify-supply-chain-contract: verify-hardening-checklist verify-hardening-stability-contract verify-personal-project-docs
	node --test deploy/supply-chain/verify-codeql-sarif.test.mjs
	node --test deploy/supply-chain/verify-release-version.test.mjs
	node deploy/supply-chain/verify-release-version.mjs
	./deploy/supply-chain/verify-contract.sh
	./deploy/supply-chain/test-contract.sh
	sh ./deploy/verify-supply-chain-contract.sh
	$(MAKE) verify-observability-contract

verify-backend-licenses:
	cd server && go run ./scripts/third-party-notices --check
	cd server && go test ./scripts/third-party-notices

verify-chinese-comments:
	node --test scripts/verify-chinese-comments.test.mjs
	node scripts/verify-chinese-comments.mjs

verify-personal-project-docs:
	node --test scripts/verify-personal-project-docs.test.mjs
	node scripts/verify-personal-project-docs.mjs

verify-hardening-checklist:
	node --test scripts/verify-hardening-checklist.test.mjs
	node scripts/verify-hardening-checklist.mjs

verify-hardening-stability-contract:
	sh -n scripts/verify-hardening-stability-50.sh
	node --test scripts/summarize-go-test-json.test.mjs

# 修改关键资金、恢复、资源租约或平台契约后手动执行；失败修复后必须重新从第 1 轮计数。
verify-hardening-stability-50: verify-hardening-stability-contract
	HARDENING_STABILITY_ROUNDS=50 ./scripts/verify-hardening-stability-50.sh

verify-cluster-production:
	HELM_BIN="$${HELM_BIN:-helm}" ./deploy/cluster-production/verify-static-contract.sh
	HELM_BIN="$${HELM_BIN:-helm}" KUBECONFORM_BIN="$${KUBECONFORM_BIN:-kubeconform}" ./deploy/cluster-production/verify-kubeconform.sh

verify-aws-production:
	HELM_BIN="$${HELM_BIN:-helm}" KUBECONFORM_BIN="$${KUBECONFORM_BIN:-kubeconform}" ./deploy/aws-production/verify-static-contract.sh

verify-terraform:
	TERRAFORM_BIN="$${TERRAFORM_BIN:-terraform}" ./infra/terraform/scripts/verify.sh

verify-cluster-image-contract:
	./deploy/cluster-production/verify-image-runtime-contract.sh

verify-cluster-prometheus-rules:
	HELM_BIN="$${HELM_BIN:-helm}" ./deploy/cluster-production/verify-prometheus-rule-contract.sh

verify-deployment-contracts: verify-cluster-production verify-terraform
	$(MAKE) verify-aws-production
	./deploy/local-production/verify-static-contract.sh

test-race:
	cd server && go test -race ./...

vet:
	cd server && go vet ./...

build:
	cd server && go build ./...
	cd web && $(BROWSER_SMOKE_ENV) npm run build

verify-backend: verify-supply-chain-contract verify-backend-licenses
	# 全新数据库必须先完成迁移、并发幂等校验和模式验证，才能运行会自动发现 PostgreSQL 的完整测试集。
	$(MAKE) test-postgres
	cd server && go test ./...
	cd server && go test -race ./...
	cd server && go vet ./...
	cd server && go build ./...

verify: verify-supply-chain-contract verify-backend-licenses verify-chinese-comments verify-hardening-checklist verify-hardening-stability-contract test test-race vet build
	# Node 模拟测试无法发现跨生产分块的浏览器求值错误，必须再执行真实 Chrome 门禁。
	$(MAKE) verify-web-browser-bootstrap
