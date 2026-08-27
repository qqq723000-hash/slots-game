# 前端宿主集成契约

生产 RGS 页面必须由运营商宿主创建会话。浏览器只消费宿主交付的一次性
`launchCode`，不负责签发、保存或重放它。

## 初始会话失败

RGS 首会话在 15 秒内未建立，或 exchange 在此之前失败时，客户端会：

1. 关闭当前 RGS gateway，清除一次性 `launchCode` 并取消在途请求；
2. 保持投注控件禁用，并持续显示 `SESSION UNAVAILABLE`；
3. 仅发送一次 `slots-game:operator-session-required` 恢复通知；
4. 拒绝迟到的旧会话响应，避免已失败凭据重新激活页面。

离线或后台停放发生在 exchange 之前，此时一次性 code 尚未消费；一旦客户端准备实际发包，会先在
本实例内清除 code。此后无论出现网络不确定、HTTP 拒绝还是协议解码失败，同一 gateway 的再次
`connect()` 都不会重放，宿主只能签发新的完整会话。

事件 `detail` 只包含以下稳定字段：

```ts
interface OperatorSessionRequest {
  reason:
    | "initial-session-timeout"
    | "initial-session-failed"
    | "session-timeout"
    | "committed-result-recovery-required";
  code: "SESSION_TIMEOUT" | "OPERATOR_SESSION_REQUIRED";
  correlationId?: string;
}
```

宿主收到事件后应终止或替换当前页面容器（包括 iframe），由运营商后端签发全新的会话和
`launchCode`。禁止刷新当前 URL、再次使用旧 code，或在前端拼接新的 code。

```ts
window.addEventListener("slots-game:operator-session-required", (event) => {
  const request = (event as CustomEvent).detail;
  // 只把 reason/code/correlationId 发送给受控宿主；新会话必须由运营商后端创建。
  operatorHost.requestNewGameSession(request);
});
```

直接构造 `AppController` 的受控宿主也可以提供
`onOperatorSessionRequired(request)` 回调；回调和 DOM 事件表达同一个契约，宿主应做
幂等去重。

## 空闲会话终止与 EXIT

在线且前台的客户端会以只读方式周期调用 `POST /client/v1/sessions/status`，并用响应体中的
`serverTime`、单调浏览器时钟和 `idleDisconnectAt` 校准绝对空闲截止时间。服务端返回
`SESSION_TIMEOUT` 或绝对截止时间到达后，旧 transport 立即终止投注、自动播放、表现和音频，
但不会清除可能已提交轮次的本地 durable ledger，也不会在页面内自动刷新、重连或重放旧
`launchCode`。

超时弹窗出现时不会立即通知宿主。只有玩家按下唯一的 `EXIT` 后，客户端才发送
`reason="session-timeout"`、`code="SESSION_TIMEOUT"` 的白名单消息。宿主必须换发新的浏览器
授权和一次性 `launchCode`，同时让后端恢复同一个 durable server session；如有未 ACK 轮次，
新 transport 应通过既有 pending-result/ledger 流程继续，而不是再次运行 spin/RNG。

顶层同源部署可在受控构建中把 `VITE_OPERATOR_RETURN_URL` 设置为同源绝对路径（例如
`/operator/`）。该兜底同样只在 EXIT 后执行；相对路径、协议相对 URL、跨源 URL、query/hash
以及 framed 页面都会拒绝自导航，iframe 仍只使用精确 origin 的宿主消息。

## 已提交结果恢复

会话 exchange 返回的 `sequence` 已推进、但浏览器没有本地 round ledger 时，客户端会先调用
`GET /client/v1/results/pending`，然后才把会话交给游戏状态机。待交付响应必须同时包含完整
`SpinResult`、`resultHash`，以及与该 round 同步持久化的权威 `originFeature`。客户端严格校验
operator/session、round、sequence、revision、余额、局后特性和局前语义关系；任一不一致都会
保持投注禁用。恢复过程不调用 `/spins`，不重新运行 RNG，也不从当前会话猜测局前 Rage 或
Free Spins 状态。

完整结果完成展示（或既有的表现失败兜底提交）后，客户端才向
`POST /client/v1/results/acknowledgements` 发送精确 round/sequence/resultHash。ACK 重试保持幂等，
且不会修改余额、revision、特性状态或钱包事实。目标 RGS/CORS 必须允许精确游戏 origin 的
`GET`、`Authorization`、`X-Operator-Id`、`X-Request-Id`、`traceparent`，并拒绝未列入的 origin；
不要允许 credentials/cookie 模式代替 Bearer token。浏览器为每个请求生成独立且不持久化的
随机 Trace Context；它不包含玩家、会话、轮次或设备标识，随机源不可用时会省略而不会阻断权威请求。

ACK 遇到断网、`202`、`429` 或 `5xx` 时会自动重试同一 tuple；默认指数退避从 500 ms 开始，
单次最多 30 秒、最多 8 次逻辑尝试，并受 120 秒页内硬截止约束。`Retry-After` 只接受规范的
正整数秒或 IMF-fixdate。当前 RGS HTTP 只扣一个准入成本单位且最低回填率为 `0.001/s`，因此
前端独立接受最长 1000 秒的服务端下界，不再错用 30 秒 ACK 退避配置裁剪。该下界仍不能延长
ACK 的 120 秒绝对截止；若已超过剩余窗口，立即交接运营商恢复。零、负数、重复合并、非规范或超过
1000 秒的值会被忽略；未来 weighted-cost HTTP 契约必须显式升级此界限，不得默认沿用。硬截止会
取消在途 ACK。一次 `401` 仍沿用既有 token refresh 后
重试一次的语义；refresh 失败或 ACK 恢复耗尽时，客户端保留本地 ledger 和服务端 cursor、
终止旧 transport，并向宿主发送 reason=`committed-result-recovery-required` 的白名单通知。
宿主应换发完整新会话，不得让 iframe 重放旧 launch code。

token refresh 把发起请求时的 session 作为不可变基线。相同 revision/sequence 的响应必须保持
余额与规范化特性状态不变；存在待处理轮次时，普通响应只允许保持当前游标，或在该轮次的
`start..start+1` 窗口内让 revision/sequence 同步前进一步。另一个明确允许的迟到交错是本页已经从
`start` 提交到 `start+1`，而较早的 refresh 仍返回未经改变的 `start` 快照；此时只采用新
token/expiry，绝不回退当前投影。窗口外的旧游标、超过一步的前跳、sequence 不匹配或同 revision
的经济状态漂移都会失败关闭并请求运营商新会话。

### 跨源 iframe 恢复桥

跨源 iframe 的生产构建必须在上述 RGS 变量之外配置：

```bash
VITE_RGS_HOST_ORIGIN=https://operator.example
```

该值只接受精确、规范化、无 credentials 的 HTTPS origin；`*`、HTTP、末尾 `/`、路径、
query/hash 均非法。framed RGS 缺失或误配时会在 session exchange 与投注启用前
fail-closed。iframe 还必须提供可写 `sessionStorage`；opaque-origin sandbox 或存储策略导致
读写失败时同样拒绝启动，以免已提交轮次失去可恢复 ledger。

客户端保留同页 CustomEvent/回调，同时向直接父 frame 使用上述精确 target origin 发送：

```json
{
  "type": "slots-game:operator-session-required",
  "version": 1,
  "reason": "initial-session-failed",
  "code": "OPERATOR_SESSION_REQUIRED",
  "correlationId": "optional-safe-request-id"
}
```

父页面必须同时校验 `event.origin` 等于游戏页面的精确 origin、`event.source` 等于目标
iframe 的 `contentWindow`，再校验 `type === "slots-game:operator-session-required"` 与
`version === 1`。消息业务字段只允许上述 `reason/code/correlationId`；收到后仍须由运营商
后端签发新会话，禁止刷新或重放旧 launch code。

## iframe 与浏览器策略

仓库内不可发布的 `static-conformance` 镜像使用 `X-Frame-Options: SAMEORIGIN` 和
`frame-ancestors 'self'`，因此只允许独立页面或同源嵌入。生产 `runtime` 镜像则在同一次
approval-gated 构建中复用 `VITE_RGS_HOST_ORIGIN` 与 `VITE_RGS_BASE_URL`：移除会阻断跨源
iframe 的 X-Frame-Options，并生成唯一的精确 `frame-ancestors` 宿主 origin 与
`connect-src` RGS origin。渲染器拒绝 `*`、HTTP、credentials、重复 CSP 指令和第二套 origin
配置，最终镜像还执行 `nginx -t`。CloudFront Response Headers Policy 同样不得重新注入
`X-Frame-Options`，必须逐字复用该 digest 提取出的唯一 CSP。不要在发布代理再次放宽或覆盖这些响应头；
每个获批宿主 origin 应生成并归档独立镜像 digest。同时按相同清单配置 RGS CORS，并在目标浏览器验证
未列入的 origin 无法嵌入或调用接口。

CloudFront release router 设置 host-only 的 `Secure; HttpOnly; SameSite=None; Partitioned` cookie。
`SameSite=None` 允许跨站 iframe 携带 release 固定状态，`Partitioned` 将其隔离到顶层站点；是否能在目标
Safari/Chrome/Edge 版本、隐私模式和运营商嵌套方式中持续固定，必须用真实跨站浏览器验收，不能只靠静态
字符串检查宣称完成。

## 安全诊断事件

`slots-game:player-error` 只发送稳定公共错误 `code`，以及通过字符集和长度校验的可选
`correlationId`。服务端异常文本、URL、token、请求体和堆栈不会进入玩家界面或事件。
该事件只用于受控日志关联，不是资金审计记录，也不能作为重试或结算依据。

## 发布验收

- 模拟 exchange 网络失败和 15 秒超时，确认宿主只创建一次新会话请求；
- 清空 sessionStorage 中的 round ledger、保留服务端未 ACK 结果，确认重载只消费该结果一次、
  不调用 spin/RNG，并在展示完成后精确 ACK；
- 确认旧 iframe/code 被销毁，迟到响应不能解锁投注；
- 检查 `runtime` 实际响应只有一条 CSP、没有 X-Frame-Options，且
  `frame-ancestors`/`connect-src` 与该镜像构建参数完全一致；
- 在获批运营商的跨站 iframe 中连续刷新和切换页面，确认 `slots-release` cookie 为
  `Secure; HttpOnly; SameSite=None; Partitioned` 且始终固定到同一 release；
- 确认玩家 DOM、控制台采集和宿主事件中没有原始服务端 `.message`；
- 确认网络失败不会重放一次性 RGS code，而是只请求运营商签发新会话；
- 将宿主恢复演练结果与运营商会话签发、钱包和审计证据一起归档。
