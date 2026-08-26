// / <参考类型="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RGS_BASE_URL?: string;
  readonly VITE_RGS_BET_OPTIONS_MINOR?: string;
  readonly VITE_RGS_DEFAULT_BET_MINOR?: string;
  readonly VITE_RGS_HOST_ORIGIN?: string;
  /** 顶层同源本地部署在会话 EXIT 后返回的显式 operator path。 */
  readonly VITE_OPERATOR_RETURN_URL?: string;
  readonly VITE_PRIMAL_RUNTIME_MODE?: "auto" | "force" | "off";
  /**
   * 默认 `on-demand`：只在真实功能事件后获取并校验租约。`shadow` 额外执行启动后
   * 全功能包校验；`off` 保留旧的直接加载兼容路径。
   */
  readonly VITE_ASSET_STREAMING_MODE?: "off" | "on-demand" | "shadow";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
