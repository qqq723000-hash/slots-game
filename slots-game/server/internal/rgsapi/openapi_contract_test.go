package rgsapi

import (
	"os"
	"strings"
	"testing"
)

func TestOpenAPIAuthenticationAndClientAdmissionResponses(t *testing.T) {
	t.Parallel()
	contents, err := os.ReadFile("../../openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	document := string(contents)

	// 这些路由都会在访问令牌验证后进入同一个 clientAdmission；规范必须同时
	// 描述 JSON 401 与 429，否则生成的 SDK/网关会遗漏真实的失败闭合响应。
	for _, path := range []string{
		"/client/v1/sessions/refresh",
		"/client/v1/sessions/status",
		"/client/v1/spins",
		"/client/v1/rounds/status",
		"/client/v1/results/pending",
		"/client/v1/results/acknowledgements",
	} {
		section := openAPIPathSection(t, document, path)
		if !strings.Contains(section, "'401':\n          $ref: '#/components/responses/ClientUnauthorized'") {
			t.Errorf("%s does not declare the client JSON 401 response", path)
		}
		if !strings.Contains(section, "'429':\n          $ref: '#/components/responses/RateLimited'") {
			t.Errorf("%s does not declare authenticated client admission rejection", path)
		}
	}

	// 运维承载令牌失败由独立监听器返回 text/plain 和 WWW-Authenticate，不能复用客户端 JSON 契约。
	for _, path := range []string{"/readyz", "/metrics"} {
		section := openAPIPathSection(t, document, path)
		if !strings.Contains(section, "'401':\n          $ref: '#/components/responses/OperationsUnauthorized'") {
			t.Errorf("%s does not declare the operations Bearer 401 response", path)
		}
	}

	// 一次性启动码兑换没有已验证令牌身份，不创建 clientAdmission 限流桶；
	// 其预认证资源保护是进程级 503 容量闸门，规范不能遗留旧的 IP 限流 429。
	exchange := openAPIPathSection(t, document, "/client/v1/sessions/exchange")
	if strings.Contains(exchange, "#/components/responses/RateLimited") {
		t.Error("session exchange still declares the removed pre-authentication client rate limiter")
	}

	for _, path := range []string{
		"/operator/v1/launches", "/operator/v1/rounds/status", "/operator/v1/risk-decisions",
	} {
		section := openAPIPathSection(t, document, path)
		if !strings.Contains(section, "'405':\n          $ref: '#/components/responses/SignedMethodNotAllowed'") {
			t.Errorf("%s does not declare its signed JSON method error", path)
		}
	}
	for _, path := range []string{
		"/client/v1/sessions/exchange",
		"/client/v1/sessions/refresh",
		"/client/v1/sessions/status",
		"/client/v1/spins",
		"/client/v1/rounds/status",
		"/client/v1/results/pending",
		"/client/v1/results/acknowledgements",
	} {
		section := openAPIPathSection(t, document, path)
		if !strings.Contains(section, "#/components/parameters/TraceParent") {
			t.Errorf("%s does not declare optional W3C browser trace correlation", path)
		}
		if !strings.Contains(section, "'405':\n          $ref: '#/components/responses/ClientMethodNotAllowed'") {
			t.Errorf("%s does not declare its JSON method error and Allow header", path)
		}
	}
	for _, path := range []string{"/healthz", "/readyz", "/metrics"} {
		section := openAPIPathSection(t, document, path)
		if !strings.Contains(section, "'405':\n          $ref: '#/components/responses/OperationsMethodNotAllowed'") {
			t.Errorf("%s does not declare its operations text method error", path)
		}
		if !strings.Contains(section, "'400':\n          $ref: '#/components/responses/OperationsBadRequest'") {
			t.Errorf("%s does not declare body-bearing GET rejection", path)
		}
	}
	health := openAPIPathSection(t, document, "/healthz")
	if strings.Contains(health, "https://rgs.example.invalid") ||
		!strings.Contains(health, "http://127.0.0.1:8081") ||
		!strings.Contains(health, "the public RGS listener returns 404") {
		t.Error("liveness is not restricted to the private operations listener")
	}
	for _, expectation := range []struct {
		name        string
		contentType string
		signed      bool
	}{
		{name: "SignedMethodNotAllowed", contentType: "application/json", signed: true},
		{name: "ClientMethodNotAllowed", contentType: "application/json"},
		{name: "OperationsMethodNotAllowed", contentType: "text/plain"},
	} {
		section := openAPIResponseSection(t, document, expectation.name)
		if !strings.Contains(section, "Allow:") || !strings.Contains(section, expectation.contentType+":") {
			t.Errorf("%s does not preserve its Allow header and %s body", expectation.name, expectation.contentType)
		}
		if expectation.signed && (!strings.Contains(section, "Content-Digest:") ||
			!strings.Contains(section, "Signature-Input:") || !strings.Contains(section, "Signature:")) {
			t.Errorf("%s does not preserve all response-signature headers", expectation.name)
		}
	}
	badRequest := openAPIResponseSection(t, document, "OperationsBadRequest")
	for _, expectation := range []string{"Cache-Control:", "Connection:", "text/plain:"} {
		if !strings.Contains(badRequest, expectation) {
			t.Errorf("OperationsBadRequest is missing %s", expectation)
		}
	}

	launch := openAPIPathSection(t, document, "/operator/v1/launches")
	if !strings.Contains(launch, "'410':\n          $ref: '#/components/responses/SignedError'") {
		t.Error("operator launch does not declare expired durable-session replay")
	}
	if !strings.Contains(exchange, "'423':\n          $ref: '#/components/responses/Error'") {
		t.Error("session exchange does not declare quarantined-session manual review")
	}
	status := openAPIPathSection(t, document, "/client/v1/sessions/status")
	for _, expectation := range []string{
		"operationId: getClientSessionStatus",
		"#/components/schemas/SessionStatusRequest",
		"#/components/schemas/SessionStatusSuccessEnvelope",
		"stable error code SESSION_TIMEOUT",
		"never rotates the token, extends the idle deadline, changes economic",
	} {
		if !strings.Contains(status, expectation) {
			t.Errorf("session status contract is missing %q", expectation)
		}
	}
	for _, expectation := range []string{
		"bearerFormat: RGS-ACCESS-v3",
		"required: [accessToken, session, serverTime]",
		"required: [operatorId, sessionId, status, idleDisconnectAt, serverTime]",
		"required: [idleDisconnectAt]",
		"idleDisconnectSeconds:",
	} {
		if !strings.Contains(document, expectation) {
			t.Errorf("idle transport OpenAPI contract is missing %q", expectation)
		}
	}
}

func TestOpenAPISpinWinsSeparateNominalAndPaidAmounts(t *testing.T) {
	t.Parallel()
	contents, err := os.ReadFile("../../openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	document := string(contents)

	spinResult := openAPISchemaSection(t, document, "SpinResult")
	normalizedSpinResult := strings.Join(strings.Fields(spinResult), " ")
	for _, expectation := range []string{
		"ResultSchemaPaidFactsV1",
		"rgs-spin-result-paid-facts-v1",
		"intentionally not an HTTP response property",
		"historical pre-marker replays retain their legacy hash projection",
	} {
		if !strings.Contains(normalizedSpinResult, expectation) {
			t.Errorf("SpinResult result-schema contract is missing %q", expectation)
		}
	}

	for _, expectation := range []struct {
		name          string
		required      string
		nominalSchema string
	}{
		{
			name:          "PathAward",
			required:      "required: [cells, multiplier, baseAmountMinor, nominalAmountMinor, amountMinor]",
			nominalSchema: "#/components/schemas/MoneyMinor",
		},
		{
			name:          "Win",
			required:      "required: [id, symbol, ways, nominalAmountMinor, amountMinor, cells, pathAwards]",
			nominalSchema: "#/components/schemas/PositiveMoneyMinor",
		},
	} {
		schema := openAPISchemaSection(t, document, expectation.name)
		if !strings.Contains(schema, expectation.required) {
			t.Errorf("%s does not require both nominal and paid amounts", expectation.name)
		}
		nominal := openAPIPropertySection(t, schema, expectation.name, "nominalAmountMinor")
		if !strings.Contains(nominal, expectation.nominalSchema) {
			t.Errorf("%s nominal amount schema = %s, want %s", expectation.name, nominal, expectation.nominalSchema)
		}
		if expectation.name == "PathAward" &&
			strings.Contains(nominal, "#/components/schemas/PositiveMoneyMinor") {
			t.Errorf("PathAward nominal amount rejects legal zero after minor-unit rounding: %s", nominal)
		}
		paid := openAPIPropertySection(t, schema, expectation.name, "amountMinor")
		if !strings.Contains(paid, "#/components/schemas/MoneyMinor") ||
			strings.Contains(paid, "#/components/schemas/PositiveMoneyMinor") {
			t.Errorf("%s paid amount does not permit canonical zero: %s", expectation.name, paid)
		}
		if !strings.Contains(paid, "Zero is valid") {
			t.Errorf("%s paid amount does not document why zero is valid", expectation.name)
		}
	}
}

func TestOpenAPIExchangeSessionRequiresEngineRulesVersion(t *testing.T) {
	t.Parallel()
	contents, err := os.ReadFile("../../openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	document := string(contents)

	exchange := openAPISchemaSection(t, document, "ExchangeResponse")
	if !strings.Contains(exchange, "required: [accessToken, session, serverTime]") {
		t.Error("ExchangeResponse no longer requires its session credential bundle")
	}
	sessionProjection := openAPIPropertySection(t, exchange, "ExchangeResponse", "session")
	if !strings.Contains(sessionProjection, "#/components/schemas/SessionResponse") {
		t.Errorf("ExchangeResponse session does not use SessionResponse: %s", sessionProjection)
	}
	normalizedExchange := strings.Join(strings.Fields(exchange), " ")
	if !strings.Contains(normalizedExchange, "required engineRulesVersion") ||
		!strings.Contains(normalizedExchange, "clients must validate it before accepting the session") {
		t.Error("ExchangeResponse does not document mandatory engine-rules validation")
	}

	session := openAPISchemaSection(t, document, "SessionResponse")
	if !strings.Contains(session, "\n        - engineRulesVersion\n") {
		t.Error("SessionResponse does not require engineRulesVersion")
	}
	engineRules := openAPIPropertySection(t, session, "SessionResponse", "engineRulesVersion")
	if !strings.Contains(engineRules, "#/components/schemas/Identifier") {
		t.Errorf("SessionResponse engineRulesVersion is not a constrained identifier: %s", engineRules)
	}
	normalizedEngineRules := strings.Join(strings.Fields(engineRules), " ")
	for _, expectation := range []string{
		"Server-authoritative engine semantics identity",
		"client must match this value exactly",
		"before accepting the session",
	} {
		if !strings.Contains(normalizedEngineRules, expectation) {
			t.Errorf("engineRulesVersion contract is missing %q", expectation)
		}
	}
}

func openAPIPathSection(t *testing.T, document, path string) string {
	t.Helper()
	marker := "\n  " + path + ":\n"
	start := strings.Index(document, marker)
	if start < 0 {
		t.Fatalf("OpenAPI path %s is missing", path)
	}
	remaining := document[start+len(marker):]
	if end := strings.Index(remaining, "\n  /"); end >= 0 {
		return remaining[:end]
	}
	if end := strings.Index(remaining, "\ncomponents:\n"); end >= 0 {
		return remaining[:end]
	}
	return remaining
}

func openAPIResponseSection(t *testing.T, document, name string) string {
	t.Helper()
	responses := strings.Index(document, "\n  responses:\n")
	if responses < 0 {
		t.Fatal("OpenAPI response components are missing")
	}
	marker := "\n    " + name + ":\n"
	startOffset := strings.Index(document[responses:], marker)
	if startOffset < 0 {
		t.Fatalf("OpenAPI response component %s is missing", name)
	}
	remaining := document[responses+startOffset+len(marker):]
	lines := strings.Split(remaining, "\n")
	for index := 1; index < len(lines); index++ {
		line := lines[index]
		if strings.HasPrefix(line, "    ") && len(line) > 4 && line[4] != ' ' {
			return strings.Join(lines[:index], "\n")
		}
	}
	return remaining
}

func openAPISchemaSection(t *testing.T, document, name string) string {
	t.Helper()
	schemas := strings.Index(document, "\n  schemas:\n")
	if schemas < 0 {
		t.Fatal("OpenAPI schema components are missing")
	}
	marker := "\n    " + name + ":\n"
	startOffset := strings.Index(document[schemas:], marker)
	if startOffset < 0 {
		t.Fatalf("OpenAPI schema component %s is missing", name)
	}
	remaining := document[schemas+startOffset+len(marker):]
	lines := strings.Split(remaining, "\n")
	for index := 1; index < len(lines); index++ {
		line := lines[index]
		if strings.HasPrefix(line, "    ") && len(line) > 4 && line[4] != ' ' {
			return strings.Join(lines[:index], "\n")
		}
	}
	return remaining
}

func openAPIPropertySection(t *testing.T, schema, schemaName, property string) string {
	t.Helper()
	marker := "\n        " + property + ":\n"
	start := strings.Index(schema, marker)
	if start < 0 {
		t.Fatalf("OpenAPI schema %s property %s is missing", schemaName, property)
	}
	remaining := schema[start+len(marker):]
	lines := strings.Split(remaining, "\n")
	for index := 1; index < len(lines); index++ {
		line := lines[index]
		if strings.HasPrefix(line, "        ") && len(line) > 8 && line[8] != ' ' {
			return strings.Join(lines[:index], "\n")
		}
	}
	return remaining
}
