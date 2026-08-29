// @ts-expect-error Vitest 在 Node 中运行；浏览器 tsconfig 故意不声明 Node 内置模块。 / English: @ts-expect-error Vitest runs in Node; the browser tsconfig intentionally does not declare Node built-in modules.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const overlaySource = readFileSync(
  new URL("../src/ui/DomOverlay.ts", import.meta.url),
  "utf8",
);
const controllerSource = readFileSync(
  new URL("../src/app/AppController.ts", import.meta.url),
  "utf8",
);
const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");

describe("operator-approved Game Rules integration", () => {
  it("mounts packaged gameplay behind the same approved-definition gate as PAYTABLE", () => {
    const panel = overlaySource.match(
      /id="game-menu-rules"[\s\S]*?<\/section>\s*<\/div>\s*<\/section>/,
    )?.[0] ?? "";

    expect(overlaySource).toContain('from "./packagedPrimalGameRules"');
    expect(panel).toContain('class="game-rules-document" data-role="game-rules-document" hidden');
    expect(panel).toContain('data-role="packaged-primal-game-rules-title"');
    expect(panel).toContain('data-role="packaged-primal-game-rules-sections"');
    expect(panel).toContain('data-role="operator-approved-game-rules"');
    expect(panel).toContain('data-role="game-rules-unavailable"');
    expect(panel).toContain("session definition explicitly approved by this client build");
    expect(panel).not.toMatch(/\bRGS\b|SHA-256|allow-list|presentationRules|definition hash/i);
  });

  it("mounts the packaged document with text nodes and structured action rows", () => {
    const method = overlaySource.match(
      /function mountPackagedPrimalGameRules[\s\S]*?\n}\n\nfunction bindStaticShellContent/,
    )?.[0] ?? "";

    expect(method).toContain("PACKAGED_PRIMAL_GAME_RULES_EN_GB.pageTitle");
    expect(method).toContain("heading.textContent = ruleSection.title");
    expect(method).toContain("paragraph.textContent = copy");
    expect(method).toContain("description.textContent = `- ${entry.description}`");
    expect(method).toContain("mount.replaceChildren(fragment)");
    expect(method).not.toContain("innerHTML");
  });

  it("validates first and commits external copy only through DOM text nodes", () => {
    const method = overlaySource.match(
      /setOperatorApprovedGameRules\([\s\S]*?\n  }\n\n  \/\*\*/,
    )?.[0] ?? overlaySource.slice(overlaySource.indexOf("setOperatorApprovedGameRules"));

    expect(method).toContain("validateOperatorApprovedGameRulesBundle(input)");
    expect(method).toContain("sections.replaceChildren()");
    expect(method).toContain('documentValue.createElement("section")');
    expect(method).toContain("heading.textContent = ruleSection.title");
    expect(method).toContain("paragraph.textContent = copy");
    expect(method).not.toContain("innerHTML");
  });

  it("uses one presentation-definition decision for PAYTABLE and packaged Game Rules", () => {
    const bindingMethod = overlaySource.slice(
      overlaySource.indexOf("private bindSessionPresentationRules"),
      overlaySource.indexOf("private bindSessionMoneyFormatter"),
    );
    expect(bindingMethod).toContain('setHidden("presentation-rules-content", !bound)');
    expect(bindingMethod).toContain('setHidden("presentation-rules-unavailable", bound)');
    expect(bindingMethod).toContain('setHidden("game-rules-document", !bound)');
    expect(bindingMethod).toContain('setHidden("game-rules-unavailable", bound)');
    expect(bindingMethod).toContain('menu.dataset.gameRulesStatus = bound');
    expect(bindingMethod).not.toContain("presentation-rules-summary");
    expect(controllerSource).toContain(
      "readonly operatorApprovedGameRules?: Readonly<OperatorApprovedGameRulesBundleInput>;",
    );
    expect(controllerSource).toContain(
      "this.ui.setOperatorApprovedGameRules(dependencies.operatorApprovedGameRules);",
    );
  });

  it("uses the captured white document surface and hides absent supplemental terms", () => {
    expect(css).toContain(".game-rules-document {");
    expect(css).toContain("background: #fff;");
    expect(css).toContain("color: #111;");
    expect(css).toContain(".game-rules-document[hidden]");
    expect(css).toContain(".operator-approved-game-rules[hidden]");
    expect(css).toContain(".operator-approved-game-rules__section h4");
    expect(css).toContain(".operator-approved-game-rules__section p");
  });

  it("does not expose unimplemented Auto adjust bet controls", () => {
    expect(overlaySource).not.toContain('data-setting="auto-adjust-bet"');
    expect(overlaySource).not.toContain("private autoAdjustBet");
    expect(overlaySource).not.toContain('case "auto-adjust-bet"');
  });
});
