import { afterEach, describe, expect, it, vi } from "vitest";
import controllerSource from "../src/app/AppController.ts?raw";
import overlaySource from "../src/ui/DomOverlay.ts?raw";
import * as controllerApi from "../src/app/AppController";
import * as overlayApi from "../src/ui/DomOverlay";
import { DomOverlay } from "../src/ui/DomOverlay";

afterEach(() => {
  vi.unstubAllGlobals();
});

function forgedTemplateStringsArray(source: string): TemplateStringsArray {
  const raw = Object.freeze([source]);
  const cooked = [source] as string[] & { raw: readonly string[] };
  Object.defineProperty(cooked, "raw", {
    value: raw,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(cooked) as unknown as TemplateStringsArray;
}

function recordingHost(assignments: unknown[]): HTMLElement {
  const host = {
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return Object.defineProperty(host, "innerHTML", {
    configurable: true,
    set(value: unknown) {
      assignments.push(value);
    },
  }) as unknown as HTMLElement;
}

describe("fixed DOM shell security boundary", () => {
  it("keeps the AppController shell on DOM APIs and the only HTML sink lexical to DomOverlay", () => {
    expect(controllerSource).not.toMatch(/\.innerHTML\s*=/);
    expect(controllerSource).not.toContain("staticHtml");
    expect(controllerSource).not.toContain("mountStaticHtml");
    expect(controllerSource).toContain("root.replaceChildren(viewport)");

    expect(overlaySource.match(/\.innerHTML\s*=/g)).toHaveLength(1);
    expect(overlaySource).toContain("mountReviewedDomOverlayShell(host, `");
    const templateStart = overlaySource.indexOf("mountReviewedDomOverlayShell(host, `");
    const templateEnd = overlaySource.indexOf("\n    `);", templateStart);
    expect(templateStart).toBeGreaterThanOrEqual(0);
    expect(templateEnd).toBeGreaterThan(templateStart);
    expect(overlaySource.slice(templateStart, templateEnd)).not.toContain("${");
  });

  it("does not export a registrar, generic HTML mounter, policy, or caster", () => {
    const publicApis = { ...controllerApi, ...overlayApi } as Record<string, unknown>;
    const forbiddenNames = [
      "staticHtml",
      "mountStaticHtml",
      "mountReviewedDomOverlayShell",
      "trustedDomOverlayHtml",
      "DOM_OVERLAY_STATIC_HTML_POLICY_NAME",
      "domOverlayPolicy",
      "domOverlayPolicyFactory",
    ];

    for (const name of forbiddenNames) expect(publicApis[name]).toBeUndefined();
    expect(Object.keys(publicApis).filter((name) => /trusted|static.?html|html.?policy/i.test(name)))
      .toEqual([]);
    expect(overlaySource).not.toMatch(/export\s+(?:const|function|let|var)\s+(?:mountReviewedDomOverlayShell|trustedDomOverlayHtml|DOM_OVERLAY_STATIC_HTML_POLICY_NAME)/);
  });

  it("cannot register a forged frozen TemplateStringsArray or forged source object through public imports", () => {
    const attack = '<img src=x onerror="globalThis.compromised=true">';
    const forgedTemplate = forgedTemplateStringsArray(attack);
    const forgedObject = Object.freeze({ source: attack });

    expect(Object.isFrozen(forgedTemplate)).toBe(true);
    expect(Object.isFrozen(forgedTemplate.raw)).toBe(true);
    for (const candidate of [forgedTemplate, forgedObject]) {
      expect(() => Reflect.apply(
        Reflect.get(overlayApi, "staticHtml") as never,
        undefined,
        [candidate],
      )).toThrow(TypeError);
      expect(() => Reflect.apply(
        Reflect.get(overlayApi, "mountStaticHtml") as never,
        undefined,
        [recordingHost([]), candidate],
      )).toThrow(TypeError);
    }
  });

  it("creates one named policy locally and ignores forged extra constructor inputs", () => {
    const attack = '<img src=x onerror="globalThis.compromised=true">';
    const forgedTemplate = forgedTemplateStringsArray(attack);
    const forgedObject = Object.freeze({ source: attack });
    const assignments: unknown[] = [];
    const createHTML = vi.fn((source: string) => Object.freeze({ trustedHTML: source }));
    const createPolicy = vi.fn((_name: string, rules: { createHTML(input: string): string }) => ({
      createHTML: (source: string) => createHTML(rules.createHTML(source)),
    }));
    const trustedTypesFactory = { createPolicy };
    vi.stubGlobal("trustedTypes", trustedTypesFactory);
    vi.stubGlobal("window", { location: { search: "" } });
    vi.stubGlobal("document", { documentElement: { lang: "en" } });

    expect(() => Reflect.construct(DomOverlay, [recordingHost(assignments), forgedTemplate]))
      .toThrow("Missing static UI mount point: jackpot-levels");
    expect(() => Reflect.construct(DomOverlay, [recordingHost(assignments), forgedObject]))
      .toThrow("Missing static UI mount point: jackpot-levels");

    expect(createPolicy).toHaveBeenCalledOnce();
    expect(createPolicy).toHaveBeenCalledWith("slots-game-static-html", expect.any(Object));
    expect(createHTML).toHaveBeenCalledTimes(2);
    expect(assignments).toHaveLength(2);
    for (const assignment of assignments) {
      expect(assignment).toMatchObject({ trustedHTML: expect.stringContaining("launch-loading") });
      expect(JSON.stringify(assignment)).not.toContain(attack);
    }
    expect(trustedTypesFactory).not.toHaveProperty("policy");
    expect(trustedTypesFactory).not.toHaveProperty("createHTML");
    expect(Reflect.get(globalThis, Symbol.for("slots-game.static-html-policy.v1"))).toBeUndefined();
  });

  it("has one fixed policy name and no global capability publication", () => {
    expect(overlaySource.match(/"slots-game-static-html"/g)).toHaveLength(1);
    expect(overlaySource.match(/factory\.createPolicy\(/g)).toHaveLength(1);
    expect(overlaySource).not.toContain("Symbol.for(");
    expect(overlaySource).not.toContain("defineProperty(globalThis");
    expect(overlaySource).not.toMatch(/Reflect\.set\(globalThis|globalThis\s*\[/);
  });
});
