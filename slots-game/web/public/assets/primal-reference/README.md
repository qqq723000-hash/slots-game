# 前端直接引用资源

该目录只保留当前 `PrimalAssetManifest.ts`、样式表或界面配置直接引用的精简资源。历史下载、未
引用素材和导入工具已经移出交付仓库。

文件名是稳定的运行时标识，不表示加载顺序。新增、替换或删除文件后必须同步更新源码引用，并
执行 `npm run build` 与 `npm run build:assets-check`；只有进入 `release-manifest.json` 且通过外部
资源审批精确哈希绑定的文件才能进入正式镜像。
