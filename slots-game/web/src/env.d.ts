// / <参考类型="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RGS_BASE_URL?: string;
  readonly VITE_RGS_BET_OPTIONS_MINOR?: string;
  readonly VITE_RGS_DEFAULT_BET_MINOR?: string;
  readonly VITE_RGS_HOST_ORIGIN?: string;
  readonly VITE_PRIMAL_RUNTIME_MODE?: "auto" | "force" | "off";
  /**
   * Pass107 B 阶段默认被故意关闭。 `shadow` 仅执行启动后缓存/完整性验证，从不门控呈现。
   */
  readonly VITE_ASSET_STREAMING_MODE?: "off" | "shadow";
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
