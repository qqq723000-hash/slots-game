# Web 多副本生产交付契约

本目录交付的是无状态、非特权、只读静态 Web 容器。容器不保存会话、不写业务数据，
也不在启动时读取环境变量改写前端或 Nginx 配置。RGS 地址、运营商父页面 origin、公开
版本和完整提交摘要都在同一次受控构建中固化；任一值变化都必须生成并审批新镜像。

## 构建身份与确定性

生产构建除四项 `VITE_RGS_*` 参数外，还必须传入：

- `WEB_RELEASE_VERSION`：1 至 128 个受限 ASCII 版本字符；
- `WEB_RELEASE_REVISION`：完整的 40 或 64 位小写 Git 提交摘要。

`release-manifest.json` 只公开 `schemaVersion`、`releaseId`、`version`、`revision` 和排序后的
文件路径、字节数、SHA-256。`releaseId` 从上述规范化内容复算，不包含构建时间、主机名、
工作目录、环境变量或自由文本。相同输入与依赖锁必须得到同一清单；文件内容或公开身份
变化必须得到不同 `releaseId`。容器的 OCI `version` 与 `revision` 标签暴露同一组值。

禁止把令牌、审批编号、内部目录、人员信息或 Secret 填入版本参数。素材审批文件只作为
BuildKit Secret 参与门禁，不会进入镜像、标签或 HTTP 响应。

## 探针

| 路径 | 用途 | 成功条件 | 是否检查外部依赖 |
| --- | --- | --- | --- |
| `/livez` | 编排器存活探针 | Nginx 可响应 `200 live` | 否 |
| `/readyz` | 编排器就绪探针及镜像健康检查 | `index.html` 与 `release-manifest.json` 均存在时响应 `200 ready` | 否 |
| `/healthz` | 兼容旧接入方 | Nginx 可响应 `200 ok` | 否 |

静态 Web 不应因为 RGS、数据库或外部 CDN 短暂异常而重启，因此探针刻意不请求外部服务。
所有探针和发布清单必须绕过 CDN，并使用 `Cache-Control: no-store, max-age=0`。

## 缓存边界

| 资源 | 容器响应策略 | 原因 |
| --- | --- | --- |
| HTML、SPA 回退、探针、`release-manifest.json` | `no-store, max-age=0` | 每次取得当前发布和安全策略 |
| runtime/streaming JSON 清单 | `no-store, max-age=0` | 避免控制清单与资源版本错配 |
| 顶层含至少 8 位内容 hash 的 JS/CSS | `public, max-age=31536000, immutable` | URL 与内容绑定，可跨副本强缓存 |
| `public/` 复制的稳定名称图片、音频、字体等 | `no-cache` | 每次发布可能沿用路径，必须重新验证 |

只有 200/206/304 成功响应可以取得资产缓存策略；缺失文件和其他错误响应一律 `no-store`，
避免 CDN 把发布先后顺序造成的短暂 404 长期缓存。

当前只有内容哈希 JS/CSS 可以直接强缓存。若 CDN 要对稳定名称素材使用一年强缓存，必须先
把源站路径改写为带 `releaseId` 的不可变前缀或内容寻址 URL，并保证旧前缀永久不覆盖；不能
只改 CDN TTL。客户端会校验部分流式素材的大小和 SHA，CDN 还必须关闭图片、音频和 JSON
内容变换，保留 Range 响应，并且不得缓存 4xx/5xx。

## 多副本与发布

同一流量池必须满足以下条件：

1. 所有副本引用同一个镜像 digest，禁止仅依赖可变 tag；
2. `version`、`revision`、`releaseId` 和完整 `Content-Security-Policy` 完全一致；
3. Pod 使用 UID/GID `101:101`、只读根文件系统，`/tmp` 挂载内存型临时卷，不挂业务持久卷；
4. CSP 不允许由 ConfigMap、环境变量、启动脚本、Sidecar 或 Ingress 动态拼接；
5. 新副本通过 `/readyz` 和直连清单一致性检查后才能接流量。

稳定名称素材使混合版本滚动发布存在串版风险。默认发布方式必须是蓝绿或等价的版本隔离：
新池完成校验后原子切换流量，旧池保留到旧页面会话自然退出；若使用 CDN，则每个发布使用
独立缓存前缀。未完成版本隔离时，不得把稳定名称素材改为 `immutable`。

直连每个待上线 Pod 的检查示例：

```sh
node deploy/web/verify-replica-consistency.mjs \
  --timeout-ms 3000 \
  --max-bytes 1048576 \
  --replica http://10.0.1.11:8080/release-manifest.json \
  --replica http://10.0.1.12:8080/release-manifest.json
```

该命令拒绝重定向、可缓存清单、超时、超限响应、未知清单字段、无法复算的 `releaseId`、
副本内容差异和 CSP 差异。地址必须直达各 Pod；经过 Service、Ingress 或 CDN 会隐藏单副本
漂移，不能作为放量证据。

## 集群外仍需配置

Ingress 与 CDN 不属于本镜像，正式接入时仍需完成：

- Ingress 终止 TLS，启用组织要求的 HSTS/TLS 策略，并原样保留容器安全响应头；
- `/livez`、`/readyz`、`/healthz`、HTML 和所有发布/运行时清单绕过缓存；
- 不注入第二条 CSP，不追加通配 origin，不为跨源嵌入重新添加冲突的 `X-Frame-Options`；
- 以镜像 digest 部署，并配置 `maxUnavailable: 0` 或蓝绿切流、就绪门控和异常回滚；
- 对强缓存 JS/CSS 保留完整 URL 和编码维度，禁止缓存错误响应；
- 稳定名称素材保持重验证，除非 CDN 已实现不可覆盖的 `releaseId` 路径隔离；
- CDN/Ingress 日志带上镜像 digest 或 `releaseId`，但不得记录查询令牌、审批 Secret 或完整敏感请求头；
- 发布后从每个 Pod 直连执行一致性 CLI，再从公网抽查 HTML `no-store`、哈希资产 `immutable`、
  CSP 精确 origin 和 Range 响应。
