// @ts-expect-error Vitest 在 Node 中运行，而浏览器 tsconfig 故意不声明 Node 全局类型。
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { computeResponsiveLayoutSnapshot } from "../src/renderer/ResponsiveLayout";
import {
  DomOverlay,
  mobileDomLayoutGeometry,
  mobileStatusMoneyDensity,
  officialHelpProjectionGeometry,
} from "../src/ui/DomOverlay";

const MOBILE_VIEWPORTS = [
  [320, 568],
  [360, 640],
  [375, 812],
  [393, 852],
  [412, 915],
  [600, 960],
  [768, 1_024],
  [800, 1_280],
  [1_024, 768],
  [1_366, 1_024],
] as const;

const MAX_INT64_FORMATTED = "92233720368547758.07";

describe("fluid mobile DOM layout", () => {
  it("synchronously refreshes HUD and help projection from one responsive commit", () => {
    const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
    const syncMobileDomLayout = vi.fn();
    const syncOfficialHelpProjection = vi.fn();
    Object.assign(overlay as unknown as Record<string, unknown>, {
      syncMobileDomLayout,
      syncOfficialHelpProjection,
    });
    const snapshot = computeResponsiveLayoutSnapshot(393, 852, { channel: "mobile" });

    overlay.setResponsiveLayout(snapshot);

    expect(syncMobileDomLayout).toHaveBeenCalledExactlyOnceWith(snapshot);
    expect(syncOfficialHelpProjection).toHaveBeenCalledTimes(1);
  });

  it("coalesces observed and window resize notifications without writing in the callback", () => {
    const queuedFrames: FrameRequestCallback[] = [];
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      queuedFrames.push(callback);
      return 41;
    });
    const syncMobileDomLayout = vi.fn();
    const syncOfficialHelpProjection = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    try {
      const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
      Object.assign(overlay as unknown as Record<string, unknown>, {
        destroyed: false,
        officialHelpResizeFrameHandle: null,
        officialHelpResizeGeneration: 0,
        syncMobileDomLayout,
        syncOfficialHelpProjection,
      });
      const schedule = (overlay as unknown as {
        scheduleObservedLayoutSync: () => void;
      }).scheduleObservedLayoutSync.bind(overlay);

      // ResizeObserver 与 window.resize 共用此路径；两种通知都不能在回调中
      // 同步修改任一被观察的布局表面。
      schedule();
      schedule();

      expect(requestFrame).toHaveBeenCalledTimes(1);
      expect(syncMobileDomLayout).not.toHaveBeenCalled();
      expect(syncOfficialHelpProjection).not.toHaveBeenCalled();

      const frame = queuedFrames[0];
      if (!frame) throw new Error("Expected one queued layout frame");
      frame(16);

      expect(syncMobileDomLayout).toHaveBeenCalledTimes(1);
      expect(syncOfficialHelpProjection).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("cancels the queued resize frame on destroy and makes a late callback inert", () => {
    const queuedFrames: FrameRequestCallback[] = [];
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      queuedFrames.push(callback);
      return 73;
    });
    const cancelFrame = vi.fn();
    const syncMobileDomLayout = vi.fn();
    const syncOfficialHelpProjection = vi.fn();
    const removeEventListener = vi.fn();
    const eventTarget = { removeEventListener };
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelFrame);
    vi.stubGlobal("document", { removeEventListener: vi.fn() });
    vi.stubGlobal("window", { removeEventListener: vi.fn() });
    try {
      const overlay = Object.create(DomOverlay.prototype) as DomOverlay;
      Object.assign(overlay as unknown as Record<string, unknown>, {
        destroyed: false,
        officialHelpResizeFrameHandle: null,
        officialHelpResizeGeneration: 0,
        syncMobileDomLayout,
        syncOfficialHelpProjection,
        cancelWinCounter: vi.fn(),
        clearAutoplayTimer: vi.fn(),
        wheelHyperspinEffect: { destroy: vi.fn() },
        betChoices: eventTarget,
        gameMenu: eventTarget,
        autoplayOptions: eventTarget,
        autoplayStopToggle: eventTarget,
        autoplayStopConditions: eventTarget,
        officialHelpResizeObserver: { disconnect: vi.fn() },
        toastTimer: null,
      });
      const schedule = (overlay as unknown as {
        scheduleObservedLayoutSync: () => void;
      }).scheduleObservedLayoutSync.bind(overlay);

      schedule();
      const staleFrame = queuedFrames[0];
      if (!staleFrame) throw new Error("Expected one queued layout frame");

      overlay.destroy();

      expect(cancelFrame).toHaveBeenCalledExactlyOnceWith(73);
      staleFrame(32);
      schedule();
      expect(requestFrame).toHaveBeenCalledTimes(1);
      expect(syncMobileDomLayout).not.toHaveBeenCalled();
      expect(syncOfficialHelpProjection).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(MOBILE_VIEWPORTS)(
    "keeps HUD controls inside the gameplay region without overlap at %sx%s",
    (physicalWidth, physicalHeight) => {
      const snapshot = computeResponsiveLayoutSnapshot(physicalWidth, physicalHeight, {
        channel: "mobile",
      });
      const geometry = mobileDomLayoutGeometry(
        snapshot.viewportRegion.width,
        snapshot.viewportRegion.height,
        snapshot.gameplayRegion.height,
        snapshot.statusRegion.height,
        snapshot.frame.scale,
      );
      const width = snapshot.viewportRegion.width;
      const height = snapshot.viewportRegion.height;
      const gameplayHeight = snapshot.gameplayRegion.height;

      expect(geometry.edge).toBeGreaterThan(0);
      expect(geometry.utilityWidth).toBeLessThanOrEqual(width - geometry.edge * 2);
      expect(geometry.spinSize).toBeLessThanOrEqual(width - geometry.edge * 2);
      expect(geometry.utilityControlSize * snapshot.frame.scale).toBeGreaterThanOrEqual(44);

      if (geometry.orientation === "portrait") {
        const utilityTop = height - geometry.utilityBottom - geometry.utilityHeight;
        const spinTop = height - geometry.spinBottom - geometry.spinSize;
        const spinBottom = spinTop + geometry.spinSize;
        const roundTop = height - geometry.roundBottom - geometry.roundHeight;
        const roundBottom = roundTop + geometry.roundHeight;

        expect(roundTop).toBeGreaterThanOrEqual(geometry.edge);
        expect(roundBottom).toBeLessThanOrEqual(spinTop - geometry.gap + 0.001);
        expect(spinBottom).toBeLessThanOrEqual(utilityTop - geometry.gap + 0.001);
        expect(utilityTop + geometry.utilityHeight).toBeLessThanOrEqual(gameplayHeight);
      } else {
        const utilityTop = gameplayHeight / 2 - geometry.utilityHeight / 2;
        const spinTop = gameplayHeight / 2 - geometry.spinSize / 2;
        const utilityRight = geometry.edge + geometry.utilityWidth;
        const spinLeft = width - geometry.edge - geometry.spinSize;

        expect(utilityTop).toBeGreaterThanOrEqual(geometry.edge - 0.001);
        expect(utilityTop + geometry.utilityHeight)
          .toBeLessThanOrEqual(gameplayHeight - geometry.edge + 0.001);
        expect(spinTop).toBeGreaterThanOrEqual(geometry.edge - 0.001);
        expect(spinTop + geometry.spinSize)
          .toBeLessThanOrEqual(gameplayHeight - geometry.edge + 0.001);
        expect(utilityRight + geometry.gap).toBeLessThanOrEqual(geometry.roundInlineStart);
        expect(width - geometry.roundInlineEnd + geometry.gap).toBeLessThanOrEqual(spinLeft);
        expect(geometry.roundInlineStart).toBeLessThan(width - geometry.roundInlineEnd);
      }
    },
  );

  it.each(MOBILE_VIEWPORTS)(
    "keeps three maximum int64 money values complete and disjoint at %sx%s",
    (physicalWidth, physicalHeight) => {
      const snapshot = computeResponsiveLayoutSnapshot(physicalWidth, physicalHeight, {
        channel: "mobile",
      });
      const geometry = mobileDomLayoutGeometry(
        snapshot.viewportRegion.width,
        snapshot.viewportRegion.height,
        snapshot.gameplayRegion.height,
        snapshot.statusRegion.height,
        snapshot.frame.scale,
      );
      const strings = [
        `Balance: ${MAX_INT64_FORMATTED}`,
        `Bet: ${MAX_INT64_FORMATTED}`,
        `Win: ${MAX_INT64_FORMATTED}`,
      ];

      expect(mobileStatusMoneyDensity(strings.map((value) => value.split(": ")[1] ?? "")))
        .toBe("extreme");

      if (geometry.orientation === "portrait") {
        const slotWidth = snapshot.viewportRegion.width - geometry.edge * 2;
        const fontSize = Math.min(14, snapshot.viewportRegion.width * 0.036);
        for (const value of strings) {
          expect(value.length * fontSize * 0.62).toBeLessThanOrEqual(slotWidth);
        }
        return;
      }

      const slotWidth = (
        snapshot.viewportRegion.width - geometry.edge * 2 - geometry.gap * 2
      ) / 3;
      const fontSize = Math.max(9, Math.min(
        12,
        snapshot.statusRegion.height * 0.67,
        snapshot.viewportRegion.width * 0.0145,
      ));
      for (const value of strings) {
        expect(value.length * fontSize * 0.62).toBeLessThanOrEqual(slotWidth);
      }
    },
  );

  it.each(MOBILE_VIEWPORTS)(
    "projects the authored help surface isotropically without horizontal scroll at %sx%s",
    (physicalWidth, physicalHeight) => {
      const snapshot = computeResponsiveLayoutSnapshot(physicalWidth, physicalHeight, {
        channel: "mobile",
      });
      const availableWidth = Math.max(0, snapshot.viewportRegion.width - 32);
      const projection = officialHelpProjectionGeometry(availableWidth, 4_800);

      expect(projection.scaleX).toBe(projection.scaleY);
      expect(projection.projectedWidthPx).toBeLessThanOrEqual(availableWidth);
      expect(projection.scrollWidthPx).toBeLessThanOrEqual(projection.availableWidthPx);
    },
  );

  it("uses one continuous mobile CSS contract instead of preset surface dimensions", () => {
    const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
    const contractStart = css.indexOf("/* 任意移动视口 DOM 合约 */");
    const contract = contractStart >= 0 ? css.slice(contractStart) : "";

    expect(contractStart).toBeGreaterThan(-1);
    expect(contract).not.toMatch(/data-surface-profile/);
    expect(contract).not.toMatch(/(?:390|633|844)px/);
    expect(contract).not.toContain("244px");
    expect(contract).toContain("--mobile-hud-edge");
    expect(contract).toContain("--mobile-utility-width");
    expect(contract).toContain("--mobile-spin-size");
    expect(contract).toMatch(/\.game-menu__content\s*\{[^}]*overflow-x:\s*hidden;/s);
    expect(contract).toMatch(/\.official-help-viewport\s*\{[^}]*overflow-x:\s*clip;/s);
    expect(contract).toMatch(/\.compact-modal,[\s\S]*?\.bet-popover\s*\{[^}]*max-width:\s*calc\(100cqw -/);
    expect(contract).toMatch(
      /\[data-mobile-layout="ls"\] \.status-metric\s*\{[^}]*max-height:\s*calc\(var\(--status-height\) - 2px\);[^}]*padding-top:\s*0;[^}]*padding-bottom:\s*0;[^}]*line-height:\s*1\.15;/s,
    );
    expect(contract).toMatch(
      /\.status-panel\[data-money-density="extreme"\] \.status-metric strong\s*\{[^}]*overflow:\s*visible;[^}]*text-overflow:\s*clip;/s,
    );
    expect(contract).toMatch(
      /\.status-panel\[data-money-density="extreme"\] \.status-panel__provider,[\s\S]*?display:\s*none;/,
    );
    expect(contract).toMatch(
      /\.round-state\[data-variant="win-counting"\]\s*\{[^}]*bottom:\s*var\(--mobile-round-bottom\);/s,
    );
    expect(contract).toMatch(
      /\.round-state\[data-variant="win-settled"\],[\s\S]*?\.round-state\[data-variant="wheel-bonus"\]\s*\{[^}]*bottom:\s*var\(--mobile-round-bottom\);/s,
    );
  });
});
