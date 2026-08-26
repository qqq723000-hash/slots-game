import { describe, expect, it } from "vitest";
import demoHtml from "../demo/index.html?raw";
import productionHtml from "../index.html?raw";
import packageMetadata from "../package.json";
import demoConfig from "../vite.demo.config.ts?raw";
import productionBootstrap from "../src/bootstrap.ts?raw";
import demoMain from "../src/demo/staticDemoMain.ts?raw";
import demoGatewayBoundary from "../src/demo/staticDemoConfiguredGateway.ts?raw";
import publicDemoGateway from "../src/demo/PublicStaticDemoGateway.ts?raw";
import finalizer from "../scripts/finalize-static-demo.mjs?raw";
import publicAssetAllowList from "../demo/static-demo-public-assets.json";
import verifier from "../scripts/verify-static-demo-build.mjs?raw";
import { createConfiguredGameGateway } from "../src/demo/staticDemoConfiguredGateway";

describe("static GitHub Pages demo contract", () => {
  it("keeps the production entry isolated and fail-closed", () => {
    expect(productionHtml).toContain('/src/bootstrap.ts');
    expect(productionHtml).not.toMatch(/staticDemo|data-static-demo|VisualFixture/i);
    expect(productionBootstrap).not.toMatch(/staticDemo|VisualFixture|sessionCurrency|loop:\s*true/i);
    expect(() => createConfiguredGameGateway({})).toThrow(
      "RGS transport is unavailable in the static demo build",
    );
  });

  it("uses a dedicated build, repository base path, and compile-time RGS replacement", () => {
    expect(demoConfig).toContain('const DEMO_BASE_PATH = "/slots-game/"');
    expect(demoConfig).toContain('mode !== "demo"');
    expect(demoConfig).toContain('__PRIMAL_STATIC_DEMO__');
    expect(demoConfig).toContain('"import.meta.env.VITE_ASSET_STREAMING_MODE"');
    expect(demoConfig).toContain('JSON.stringify("off")');
    expect(demoConfig).toContain('find: "../protocol/configuredGateway"');
    expect(demoConfig).toContain("staticDemoConfiguredGateway.ts");
    expect(demoConfig).toContain("static-demo-module-boundary");
    expect(demoConfig).toContain("FORBIDDEN_DEMO_MODULE");
    expect(demoConfig).toContain("testing");
    expect(demoConfig).toContain("dist-demo");
    expect(packageMetadata.scripts["build:demo"]).toContain("--mode demo");
    expect(packageMetadata.scripts["build:demo"]).toContain("verify-static-demo-build.mjs");
  });

  it("publishes a prominent non-economic notice and a self-only CSP", () => {
    expect(demoHtml).toContain('data-role="static-demo-disclaimer"');
    expect(demoHtml).toContain("Predetermined simulated credits (XTS)");
    expect(demoHtml).toContain("No real money");
    expect(demoHtml).toContain("No wallet");
    expect(demoHtml).toContain("No economic value");
    expect(demoHtml).toContain("Not odds or RTP");
    expect(demoHtml).toContain("No project analytics or personal-data submission");
    expect(demoHtml).toContain("Independent educational recreation");
    expect(demoHtml).toContain("Not affiliated with or endorsed by Play'n GO");
    expect(demoHtml).toContain("default-src 'none'");
    expect(demoHtml).toContain("connect-src 'self'");
    expect(demoHtml).not.toMatch(/connect-src[^;]*https?:/);
    expect(demoHtml).not.toContain("favicon.ico");
  });

  it("uses only the explicit deterministic fixture with no launch handoff", () => {
    expect(demoMain).toContain("new PublicStaticDemoGateway()");
    expect(demoMain).not.toContain("VisualFixtureGateway");
    expect(publicDemoGateway).toContain('currency: "XTS"');
    expect(publicDemoGateway).toContain("const PUBLIC_ROUNDS");
    expect(publicDemoGateway).toContain('publicFeatureTriggerRound("EXPANSION")');
    expect(publicDemoGateway).toContain('publicFeatureTriggerRound("OVERDRIVE")');
    expect(publicDemoGateway).toContain("publicBaseVaultRound()");
    expect(publicDemoGateway).toContain("publicKingVaultRound()");
    expect(publicDemoGateway).not.toMatch(/king-flow|kong-flow|cap-summary|rgs-recovered/i);
    expect(demoMain).toContain("characterCollectRandomSource: () => 0");
    expect(demoMain).not.toMatch(/createConfiguredGameGateway|RgsGateway|rgsLaunchCode|fetch\(|WebSocket/);
    expect(demoGatewayBoundary).not.toMatch(/RgsGateway|rgsLaunchCode|sessionStorage\./);
    expect(demoMain).toContain("skipFeaturePreview: false");
  });

  it("prunes production-only upstream assets and verifies the deployable output", () => {
    for (const path of [
      "favicon.ico",
      "powered-by-playngo.png",
      "runtime-manifest.json",
      "streaming-packages.desktop.json",
      "streaming-packages.mobile.json",
    ]) {
      expect(finalizer).toContain(path);
      expect(verifier).toContain(path);
    }
    expect(finalizer).toContain("external-exact-hash-approval-required");
    expect(finalizer).toContain('outcomeSelection: "fixed-public-showcase-loop"');
    expect(finalizer).toContain("roundCount: 23");
    expect(finalizer).toContain("approvedRuntimePaths");
    expect(finalizer).toContain("positive allow-list");
    expect(finalizer).toContain('runtimeManifest.schemaVersion !== 3');
    expect(publicAssetAllowList.brand).toEqual([
      "assets/brand/powered-by-gm-go.png",
      "assets/brand/statusbar-gm-go.png",
    ]);
    expect(publicAssetAllowList.primalReference).toContain(
      "assets/primal-reference/primal-rampage-logo.png",
    );
    expect(verifier).toContain("repositoryAssetRightsEvidence");
    expect(verifier).toContain("forbiddenBundlePatterns");
    expect(verifier).toContain("MAX_SINGLE_FILE_BYTES = 5 * 1024 * 1024");
    expect(verifier).toContain("allowedNonProtectedPaths");
  });
});
