# 静态资源与商业发布边界

本文件说明仓库中的前端静态资源如何进入构建、如何接受完整性校验，以及哪些权属条件必须在
商业发布前由仓库外的审批流程满足。它不构成商标注册、著作权归属或第三方授权证明。

## 目录职责

- `public/assets/brand/`：GM GO 产品标识。仓库只记录项目所有者的第一方声明；商标注册和可用
  地域仍需外部法律材料确认。
- `public/assets/primal-reference/`：界面直接引用的图片与 SVG。它们是运行依赖，不是研究附件。
- `public/assets/primal-runtime/`：Spine、音频、字体、界面图集和流式资源清单。
- `public/THIRD_PARTY_NOTICES.txt`：随 Web 成品分发的前端开源依赖声明。
- `asset-provenance.json`：机器可读的目录级权属状态和发布处理方式；该文件不进入 Web 成品。

`public/` 不允许存放 README、抓包、截图、测试夹具、设计过程稿、浏览器缓存、源码映射或密钥。
说明文档应放在 `web/` 或 `docs/`，原始取证材料必须保存在仓库外。

## 两层发布门禁

1. `npm run assets:provenance-check` 校验公开目录没有夹带文档或证据文件，并确认所有受保护资源
   都被 `asset-provenance.json` 分类。
2. `npm run build:release` 根据本次构建产生的 `release-manifest.json`，要求仓库外提供
   `RELEASE_ASSET_APPROVAL_FILE`。审批必须覆盖所有受保护资源的精确路径、字节数和 SHA-256，
   同时包含审批引用、适用地域和有效期；缺失、过期或任一字节不一致都会失败关闭。

哈希审批只能证明“本次获批的字节与成品一致”，不能替代授权链或商标注册证据。目前
`primal-reference/`、`primal-runtime/` 及 `favicon.ico` 的权属材料未存放在仓库中，因此在取得
可审计授权或完成自主素材替换前，不应将当前 Web 资源包对外宣称为可商业分发或全部原创。

## 资源变更

```sh
cd slots-game/web
npm run assets:provenance-check
npm run assets:generate-streaming-packages
npm run build
npm run build:assets-check
npm run build:bundle-check
```

新增、移动或替换资源时，必须同步更新运行时引用、资源清单、权属分类和外部精确哈希审批。
不能通过删除来源记录、降低清单覆盖率或把资源移到未保护目录来绕过发布门禁。
