# 生产静态资源

该目录只保留当前前端发布清单实际使用的资源：

- `brand/`：产品标识与启动外壳资源；
- `primal-reference/`：界面布局仍直接使用的精简资源；
- `primal-runtime/`：Spine、音频和流式资源包；
- `streaming-packages/`：由构建脚本校验的资源包清单。

生产构建由 `scripts/finalize-production-assets.mjs` 按白名单裁剪，并由
`scripts/verify-production-javascript-bundles.mjs` 拒绝未审查的脚本产物。资源变更后必须执行：

```sh
npm run assets:generate-streaming-packages
npm run build
npm run build:assets-check
npm run build:bundle-check
```

不要在此目录存放抓包、设计过程稿、浏览器缓存或私钥。
