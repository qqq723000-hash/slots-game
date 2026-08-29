import type { FeatureEvent } from "./state/types";

export type FeatureVisualRoute =
  | "none"
  | "collect"
  | "rage-transform"
  | "wheel"
  | "vault-group"
  | "free-spin-intro"
  | "vault-reveal"
  | "vault-award"
  | "extra-spin"
  | "free-spin-cap"
  | "free-spin-summary";

export interface FeatureEventRoute {
  /** 结构性网格扩展只在停轴前呈现一次。 / English: Structural grid expansion is presented exactly once before the reels stop. */
  readonly beforeReels: boolean;
  /** 此语义事件在停轴后有且只有一个视觉负责人。 / English: This semantic event has exactly one visual owner after the reels stop. */
  readonly visual: FeatureVisualRoute;
  /** AppController 是否应调用渲染器的环境桥接。 / English: Whether the AppController should call the renderer's environment bridge. */
  readonly environment: boolean;
  /** AppController 是否应调用语义音频桥接。 / English: Whether the AppController should call Semantic Audio Bridging. */
  readonly audio: boolean;
  /** 过渡性分组标记在精简 DOM 播报器中保持静默。 / English: Transitional grouping tags remain silent in the compact DOM announcer. */
  readonly announce: boolean;
}

const route = (
  visual: FeatureVisualRoute,
  options: Partial<Omit<FeatureEventRoute, "visual">> = {},
): FeatureEventRoute => Object.freeze({
  beforeReels: false,
  visual,
  environment: false,
  audio: false,
  announce: true,
  ...options,
});

/**
 * 纯事件到表现的路由表。它刻意不推断结果：每条路由都从一个已解码的权威事件开始。
 * 开始/奖励事件与分组/格子事件分配给不同负责人，确保同一次服务端状态转换不会重复触发
 * 同一个轮盘、Vault 分组重击、角色提示或 Free Spins 面板。
 *
 * 英文 / English: Pure event-to-presentation routing table. It intentionally infers no outcomes: every route begins with a decoded authoritative event. Start/award events and group/cell events have distinct owners so one server state transition cannot trigger the same Wheel, grouped Vault impact, character cue, or Free Spins panel twice.
 */
export function featureEventRoute(event: FeatureEvent): FeatureEventRoute {
  switch (event.type) {
    case "grid.expanded":
      return route("none", { beforeReels: true, environment: true, audio: true });
    case "surge.collected":
      // 触发 Rage 的结果已由制作好的停轴退场流程持有。第二次 DOM 播报会在进入 Wheel 前 / English: A Rage-triggering result is already owned by the authored reel-stop outro. A second DOM announcement before Wheel would
      // 插入虚假的 620ms+160ms 栅栏；普通计量条收集仍需播报。 / English: insert a bogus 620 ms + 160 ms fence; ordinary meter collections still require an announcement.
      return route("collect", {
        environment: true,
        audio: true,
        announce: !event.triggered,
      });
    case "rage.transformed":
      return route("rage-transform", { environment: true, announce: false });
    case "wheel.started":
      return route("none", { environment: true, audio: true, announce: false });
    case "wheel.awarded":
      return route("wheel", { environment: true, audio: true });
    case "free_spins.started":
      return route("free-spin-intro", { environment: true, audio: true });
    case "vaults.landed":
      return route("none", { announce: false });
    case "vaults.locked":
      // Locked 是语义分组边界，不是制作好的视觉暂停点。 / English: Locked is a semantic grouping boundary, not a well-made visual pause point.
      return route("none", { announce: false });
    case "vaults.unlock.started":
      return route("vault-group", { environment: true, audio: true, announce: false });
    case "vault.unlocked":
      return route("vault-reveal", { announce: false });
    case "vaults.unlock.completed":
      return route("none", { environment: true, announce: false });
    case "vaults.upgrade.started":
      return route("vault-group", { environment: true, audio: true, announce: false });
    case "vault.awarded":
      // 官方 Vault 最终奖励只投影派彩与高亮。Jackpot 奖池音效仅归 / English: A final Vault award projects only its payout and highlight. Jackpot-tier audio belongs exclusively to
      // Wheel FINISH_SPIN 奖励路由所有。 / English: the Wheel FINISH_SPIN award route.
      return route("vault-award", { environment: true, announce: false });
    case "vault.upgraded":
      return route("vault-award", { announce: false });
    case "free_spin.awarded":
      return route("extra-spin", { announce: false });
    case "free_spin.cap_reached":
      return route("free-spin-cap", { announce: false });
    case "win_cap.reached":
      return route("none", { announce: false });
    case "free_spins.completed":
      return route("free-spin-summary", { audio: true, announce: false });
  }
}
