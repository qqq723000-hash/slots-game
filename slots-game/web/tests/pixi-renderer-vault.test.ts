import { describe, expect, it, vi } from "vitest";
import type { FeatureState } from "../src/app/state/types";
import {
  PixiRenderer,
  vaultFreeSpinActivationCells,
  vaultJackpotAwardTiers,
  vaultJackpotMutationTiers,
} from "../src/renderer/PixiRenderer";
import { createSpinEnvironmentState } from "../src/renderer/spinEnvironmentMotion";

const BASE_FEATURE: FeatureState = {
  mode: "BASE",
  freeSpinsRemaining: 0,
  rageLevel: 1,
  rageCollected: 0,
};

function rendererHarness(parts: Record<string, unknown>): PixiRenderer {
  const renderer = Object.create(PixiRenderer.prototype) as PixiRenderer;
  Object.defineProperties(renderer, Object.fromEntries(
    Object.entries({
      environmentState: createSpinEnvironmentState(),
      vaultAwardExpectedCount: 0,
      vaultAwardResolvedCount: 0,
      pendingVaultAwardTiers: new Set(),
      vaultMutationPrizeByCell: new Map(),
      pendingWheelAward: null,
      wheelBonusWinLabel: { show: vi.fn(), hide: vi.fn(), cancel: vi.fn() },
      ...parts,
    }).map(([key, value]) => [key, { configurable: true, writable: true, value }]),
  ));
  return renderer;
}

describe("PixiRenderer Vault presentation", () => {
  it("does not alter the independently scheduled character body at ordinary spin start", () => {
    const resumeCharacterPersistentBody = vi.fn();
    const renderer = rendererHarness({
      launchScene: {
        resumeCharacterPersistentBody,
      },
      jackpotTower: { resetPanelAnimations: vi.fn() },
      gameLogo: { setIdleAllowed: vi.fn() },
      reels: { beginSpin: vi.fn() },
    });

    renderer.beginSpinPresentation(false);

    expect(resumeCharacterPersistentBody).not.toHaveBeenCalled();
    expect(renderer.reels.beginSpin).toHaveBeenCalledWith(false);
  });

  it("keeps only addressed Free Spin Vault activations", () => {
    expect(vaultFreeSpinActivationCells([
      { type: "free_spin.awarded", count: 1, reel: 1, row: 0 },
      { type: "free_spin.awarded", count: 1 },
      { type: "free_spin.awarded", count: 1, reel: 1, row: 2 },
    ])).toEqual([{ reel: 1, row: 0 }, { reel: 1, row: 2 }]);
  });

  it("runs every Vault extra-spin activation before HUD update and trails", async () => {
    const order: string[] = [];
    const events = [
      { type: "free_spin.awarded", count: 1, reel: 1, row: 0 },
      { type: "free_spin.awarded", count: 1, reel: 1, row: 2 },
    ] as const;
    const target = { id: "fs-counter" };
    const presentFreeSpinAwardTrails = vi.fn(async () => {
      order.push("trails");
    });
    const renderer = rendererHarness({
      reels: {
        playVaultFreeSpinActivation: ({ row }: { row: number }) => {
          order.push(`activate:${row}`);
          return true;
        },
      },
      freeSpinHud: {
        applyFreeSpinAwardBatch: () => order.push("hud"),
        getCollectTarget: () => target,
      },
      featureEffects: { view: {}, presentFreeSpinAwardTrails },
      jackpotTower: { highlightAwards: vi.fn() },
    });

    await renderer.presentFreeSpinAwardBatch(events, BASE_FEATURE, false);

    expect(order).toEqual(["activate:0", "activate:2", "hud", "trails"]);
    expect(presentFreeSpinAwardTrails).toHaveBeenCalledWith(events, target, false);
  });

  it("highlights the complete current Vault target set once per mutation stage", () => {
    const finalAwards = [
      {
        type: "vault.awarded", reel: 1, row: 0,
        prize: "MINI", multiplier: 10, amountMinor: "1000",
      },
      {
        type: "vault.awarded", reel: 1, row: 1,
        prize: "GRAND", multiplier: 1_000, amountMinor: "100000",
      },
      {
        type: "vault.awarded", reel: 1, row: 2,
        prize: "MINI_2X", multiplier: 20, amountMinor: "2000",
      },
    ] as const;
    expect(vaultJackpotAwardTiers(finalAwards)).toEqual(["mini", "grand"]);
    expect(vaultJackpotMutationTiers(finalAwards)).toEqual(["mini", "grand"]);

    const highlightAwards = vi.fn();
    const highlightAward = vi.fn();
    const playCharacterAnimation = vi.fn();
    const playAuthoredFrame = vi.fn();
    const renderer = rendererHarness({
      jackpotTower: { highlightAwards, highlightAward },
      launchScene: { playCharacterAnimation },
      reels: { playAuthoredFrame },
    });

    renderer.cueFeatureEnvironment({
      type: "vaults.unlock.started",
      count: 3,
      cells: [{ reel: 1, row: 0 }, { reel: 1, row: 1 }, { reel: 1, row: 2 }],
    }, true);
    expect(playCharacterAnimation).toHaveBeenCalledWith("vault");
    expect(playAuthoredFrame).toHaveBeenCalledWith("vault_lvl3");
    renderer.highlightVaultMutationBatch([
      {
        type: "vault.unlocked", reel: 1, row: 0,
        prize: "MINI", multiplier: 10,
      },
      {
        type: "vault.unlocked", reel: 1, row: 1,
        prize: "GRAND", multiplier: 1_000,
      },
      {
        type: "vault.unlocked", reel: 1, row: 2,
        prize: "X9", multiplier: 9,
      },
    ]);
    expect(highlightAwards).toHaveBeenLastCalledWith(["mini", "grand"]);

    // 下一阶段将 MINI 改为 MINOR，同时保留未改动的 GRAND 单元格；完整目标投影 / English: Next stage changes MINI to MINOR while leaving the GRAND cells unchanged; full target projection
    // 不得再点亮 MINI。 / English: The MINI must no longer be illuminated.
    renderer.highlightVaultMutationBatch([{
      type: "vault.upgraded", reel: 1, row: 0,
      fromMultiplier: 10, toMultiplier: 30, prize: "MINOR", step: 1,
    }]);
    expect(highlightAwards.mock.calls).toEqual([
      [["mini", "grand"]],
      [["minor", "grand"]],
    ]);

    // 最终可支付事件只负责结束记账；不会重放已在变更开始时执行的即时赢分。 / English: The final payable event is only responsible for closing accounting; instant wins that were executed at the start of the change will not be replayed.
    renderer.cueFeatureEnvironment(finalAwards[1], true);
    renderer.cueFeatureEnvironment({ ...finalAwards[0], prize: "MINOR" }, true);
    expect(highlightAwards).toHaveBeenCalledTimes(2);
    expect(highlightAward).not.toHaveBeenCalled();
  });
});

describe("PixiRenderer Wheel result reveal", () => {
  it("emits the semantic milestone from the sole Layer-B label handoff", () => {
    const show = vi.fn(async () => true);
    const milestone = vi.fn();
    const renderer = rendererHarness({
      wheelBonusWinLabel: { show, hide: vi.fn(), cancel: vi.fn() },
      featurePresentationMilestoneListener: milestone,
    });
    const event = {
      type: "wheel.awarded",
      outcome: "INSTANT",
      prize: "MINI",
      multiplier: 10,
      amountMinor: "1000",
    } as const;

    (renderer as unknown as {
      presentWheelBonusLabel(
        award: typeof event,
        reducedMotion: boolean,
      ): void;
    }).presentWheelBonusLabel(event, false);

    expect(show).toHaveBeenCalledWith("1000", false);
    expect(milestone.mock.calls).toEqual([["wheel.bonus-label-ready"]]);
  });

  it("keeps the jackpot tower state through Wheel intro, then resets on real Wheel input", () => {
    const highlightAward = vi.fn();
    const resetPanelAnimations = vi.fn();
    const hideLogo = vi.fn();
    const setCharacterBodyContinuation = vi.fn();
    const playCharacterAnimation = vi.fn(() => true);
    const renderer = rendererHarness({
      jackpotTower: { highlightAward, resetPanelAnimations },
      launchScene: { setCharacterBodyContinuation, playCharacterAnimation },
      reels: {},
      gameLogo: { hide: hideLogo },
    });

    renderer.cueFeatureEnvironment({ type: "wheel.started" }, true);
    renderer.cueFeatureEnvironment({
      type: "wheel.awarded",
      outcome: "INSTANT",
      prize: "MINI",
      multiplier: 10,
      amountMinor: "1000",
    }, true);

    // 权威 Wheel 事件会引入场景，但它并非玩家输入。原始控制器会在整个入场和 / English: The authoritative Wheel event introduces the scene, but it is not player input. The original controller will be present throughout the admission and
    // 等待输入就绪期间保持高亮或变暗的塔不变。 / English: Keep highlighted or dimmed towers unchanged while waiting for input to be ready.
    expect(resetPanelAnimations).not.toHaveBeenCalled();
    expect(hideLogo).toHaveBeenCalledTimes(1);
    expect(highlightAward).not.toHaveBeenCalled();

    (renderer as unknown as { beginWheelSpinPresentation(): void })
      .beginWheelSpinPresentation();
    expect(resetPanelAnimations).toHaveBeenCalledTimes(1);
    expect(setCharacterBodyContinuation).toHaveBeenCalledWith("feature", false);
    expect(playCharacterAnimation).toHaveBeenCalledWith("chest_pound", true);

    (renderer as unknown as { commitPendingWheelAward(): void })
      .commitPendingWheelAward();

    expect(highlightAward).toHaveBeenCalledTimes(1);
    expect(highlightAward).toHaveBeenCalledWith("MINI");
  });

  it("keeps an instant Jackpot highlight through Continue and resets at the next Base spin", () => {
    const highlightAward = vi.fn();
    const resetPanelAnimations = vi.fn();
    const setCharacterPersistentPresentation = vi.fn();
    const setIdleAllowed = vi.fn();
    const beginSpin = vi.fn();
    const renderer = rendererHarness({
      introCompleted: true,
      jackpotTower: { highlightAward, resetPanelAnimations },
      launchScene: { setCharacterPersistentPresentation },
      gameLogo: { show: vi.fn(), hide: vi.fn(), setIdleAllowed },
      reels: { beginSpin },
    });

    renderer.cueFeatureEnvironment({ type: "wheel.started" }, false);
    renderer.cueFeatureEnvironment({
      type: "wheel.awarded",
      outcome: "INSTANT",
      prize: "MINI",
      multiplier: 10,
      amountMinor: "1000",
    }, false);
    (renderer as unknown as { commitPendingWheelAward(): void })
      .commitPendingWheelAward();

    expect(highlightAward).toHaveBeenCalledWith("MINI");
    expect(resetPanelAnimations).not.toHaveBeenCalled();

    // Wheel 摘要的 Continue/outro 会恢复 Base 场景，而不是恢复塔。 / English: The Wheel summary's Continue/outro restores the Base scene, not the Tower.
    renderer.completeWheelPresentation(BASE_FEATURE);
    expect(resetPanelAnimations).not.toHaveBeenCalled();

    // 随后被接受的 Base SPIN_START 才是原始重置边界。 / English: The subsequently accepted Base SPIN_START is the original reset boundary.
    renderer.beginSpinPresentation(false);
    expect(resetPanelAnimations).toHaveBeenCalledTimes(1);
    expect(beginSpin).toHaveBeenCalledWith(false);
  });

  it.each([
    {
      award: { type: "wheel.awarded", outcome: "EXPANSION", prize: "KONG_QUEST" } as const,
      mode: "EXPANSION" as const,
    },
    {
      award: { type: "wheel.awarded", outcome: "OVERDRIVE", prize: "KING_SPIN" } as const,
      mode: "OVERDRIVE" as const,
    },
  ])(
    "keeps every Jackpot panel dark for a $award.outcome Wheel award until the Free Spins intro Spin is confirmed",
    ({ award, mode }) => {
      const darkenAllPanels = vi.fn();
      const highlightAward = vi.fn();
      const resetPanelAnimations = vi.fn();
      const setVisualStripMode = vi.fn();
      const transitionAuthoredPalette = vi.fn();
      const setCharacterPersistentPresentation = vi.fn();
      const hide = vi.fn();
      const renderer = rendererHarness({
        jackpotTower: { darkenAllPanels, highlightAward, resetPanelAnimations },
        reels: { setVisualStripMode },
        backdrop: { transitionAuthoredPalette },
        launchScene: { setCharacterPersistentPresentation },
        gameLogo: { hide },
      });

      renderer.cueFeatureEnvironment({ type: "wheel.started" }, false);
      renderer.cueFeatureEnvironment(award, false);

    // Wheel 结果虽已提前解码，但在真正落定前必须保持不可见；验收基线不会在场景 / English: Although the wheel results are decoded in advance, they must remain invisible until they are actually settled; the acceptance baseline will not be in the scene
    // 进入或就绪时变暗。 / English: Dim when entering or ready.
      expect(darkenAllPanels).not.toHaveBeenCalled();
      expect(highlightAward).not.toHaveBeenCalled();

      (renderer as unknown as { commitPendingWheelAward(): void })
        .commitPendingWheelAward();
      expect(darkenAllPanels).toHaveBeenCalledTimes(1);
      expect(highlightAward).not.toHaveBeenCalled();
      expect(resetPanelAnimations).not.toHaveBeenCalled();

      renderer.cueFeatureEnvironment({
        type: "free_spins.started",
        mode,
        awarded: 8,
      }, false);
    // 此时入场演出可见，且 CONTINUE_SPIN 仍处于活动状态。原始塔会持续变暗， / English: The entry is now visible and CONTINUE_SPIN is still active. The original tower will continue to dim,
    // 直到确认绿色 Spin。 / English: Until the green Spin is confirmed.
      expect(resetPanelAnimations).not.toHaveBeenCalled();
      expect(setVisualStripMode).toHaveBeenCalledWith(mode);
      expect(transitionAuthoredPalette).toHaveBeenCalledWith(
        mode === "OVERDRIVE" ? "snow" : "fire",
      );
      expect(setCharacterPersistentPresentation).toHaveBeenCalledTimes(1);
      expect(hide).toHaveBeenCalled();

      (renderer as unknown as { beginFreeSpinsPlayPresentation(): void })
        .beginFreeSpinsPlayPresentation();
      expect(resetPanelAnimations).toHaveBeenCalledTimes(1);

      renderer.cueFeatureEnvironment({
        type: "free_spins.completed",
        mode,
        awarded: 8,
        cumulativeWinMinor: "0",
      }, false);
    // FREESPIN_END 没有订阅 GameJackpotController 重置事件。 / English: FREESPIN_END is not subscribed to the GameJackpotController reset event.
      expect(resetPanelAnimations).toHaveBeenCalledTimes(1);
    },
  );

  it("restores the Base logo only after a terminal Wheel summary", () => {
    const show = vi.fn();
    const hide = vi.fn();
    const setCharacterPersistentPresentation = vi.fn();
    const renderer = rendererHarness({
      introCompleted: true,
      gameLogo: { show, hide },
      launchScene: { setCharacterPersistentPresentation },
    });

    renderer.completeWheelPresentation(BASE_FEATURE);

    expect(show).toHaveBeenCalledTimes(1);
    expect(hide).not.toHaveBeenCalled();

    renderer.completeWheelPresentation({
      ...BASE_FEATURE,
      mode: "EXPANSION",
      freeSpinsRemaining: 8,
    });

    expect(hide).toHaveBeenLastCalledWith(true);
    expect(setCharacterPersistentPresentation).toHaveBeenCalledTimes(2);
  });

  it("discards an unrevealed Wheel result when presentation is cancelled", () => {
    const highlightAward = vi.fn();
    const cancel = vi.fn();
    const cancelActivePresentation = vi.fn();
    const renderer = rendererHarness({
      pendingWheelAward: {
        type: "wheel.awarded", outcome: "INSTANT", prize: "GRAND",
        multiplier: 1_000, amountMinor: "100000",
      },
      wheelBonusWinLabel: { hide: vi.fn(), cancel },
      featureEffects: {
        cancelActivePresentation,
        cancelRageCascadePresentation: vi.fn(),
        setRageCascadePlaybackPaused: vi.fn(),
      },
      jackpotTower: { highlightAward },
      gameLogo: { setIdleAllowed: vi.fn() },
      reels: { cancelPresentation: vi.fn() },
    });

    renderer.cancelSpinPresentation();
    (renderer as unknown as { commitPendingWheelAward(): void })
      .commitPendingWheelAward();

    expect(highlightAward).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancelActivePresentation).toHaveBeenCalledTimes(1);
  });

  it("restores persistent pixels and discards the hidden award on a pre-landing abort", () => {
    const resumeCharacterPersistentBody = vi.fn();
    const highlightAward = vi.fn();
    const cancel = vi.fn();
    const show = vi.fn();
    const renderer = rendererHarness({
      pendingWheelAward: {
        type: "wheel.awarded", outcome: "INSTANT", prize: "GRAND",
        multiplier: 1_000, amountMinor: "100000",
      },
      wheelBonusWinLabel: { hide: vi.fn(), cancel },
      launchScene: { resumeCharacterPersistentBody },
      jackpotTower: { highlightAward },
      introCompleted: true,
      featureMode: "BASE",
      gameLogo: { show, hide: vi.fn() },
    });

    renderer.abortWheelPresentation();
    (renderer as unknown as { commitPendingWheelAward(): void })
      .commitPendingWheelAward();

    expect(resumeCharacterPersistentBody).toHaveBeenCalledTimes(1);
    expect(highlightAward).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledTimes(1);
  });
});
