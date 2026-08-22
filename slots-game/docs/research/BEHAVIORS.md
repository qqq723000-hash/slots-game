# Primal Rampage 三端行为基线

本文件只记录从原游戏运行页、官方移动配置和本地归档中交叉验证出的行为参数；原始抓包、运行包和截图留在忽略目录 `.artifacts/`，不进入发布物。

## 目标设备

- PC：1280×720 为固定对照视口。
- 手机：390×844 与 844×390 只是像素回归标尺；320×568、360×640、375×812、393×852、412×915 等任意尺寸都走连续布局。
- 平板：633×844 与 844×633 只是像素回归标尺；600×960、768×1024、800×1280、1024×768、1366×1024 等任意尺寸都走连续布局。

## 视口与黑边

- PC 使用固定 1280×720 设计表面。手机和平板以 844 逻辑长边和当前真实宽高比连续生成设计域；`phone-pt/tablet-pt/...` 只保留为诊断标签，不再选择画布尺寸。
- 缩放固定为 `min(viewportWidth / designWidth, viewportHeight / designHeight)`，禁止 X/Y 独立拉伸、cover 裁切或把盘面弹性铺满。
- 多余区域统一为纯黑 letterbox/pillarbox；常规移动宽高比因设计域连续匹配而无需黑边，极端比例仍等比居中。画布、DOM、点击区域和帮助页共享同一设计坐标系。
- `ResizeObserver`、`window.resize` 与 `visualViewport.resize` 的重复通知合并到同一动画帧；切换开发者设备和旋转不得重载资源或改变游戏状态。
- 资源通道在会话启动时冻结；布局通道在每次提交按显式 `layout=`、输入能力与视口重新判定，避免 DevTools 从 PC 切到手机后仍保留桌面构图。

## Jackpot 左侧边框

- 交互模型：时间驱动。
- 触发顺序：MINI → MINOR → MAJOR → MEGA → GRAND。
- 相邻档位触发间隔：200ms；0/200/400/600/800ms 分别累计激活一档。
- Spine 单帧推进允许限幅以避免跳帧，但 200ms 语义计时必须使用完整、非负的墙钟增量。
- PC 为左侧纵向五档；手机竖屏和平板竖屏分别使用官方 `pt`、`iPad_pt` minBounds。紧凑手机横屏在 canonical `ls` 投影上按原游戏实机截图增加 `scaleX=1.12`，平板横屏恢复等比 `ls`，两者均不改变 Y、纵向间距或触发时序。

## Balance / Bet / Win

- PC：状态栏基准来自 1600×900 的 30px/18px 投影；1280×720 应为 24px 高、14.4px `ROBOTO_CONDENSED_REGULAR`。
- 手机和平板：使用官方移动默认 `ROBOTO_CONDENSED_BOLD`，字号由响应式布局变量决定，不写死为桌面值。
- 金额使用会话绑定的 currency 与 currencyExponent；不得使用浮点数，也不得默认为两位小数。
- 不添加来源外的千位分隔符；PC 不添加移动端 Balance/Bet 背板。
- 三个金额同时达到 int64 极值时，竖屏改为三行、横屏改为三列完整显示，禁止 ellipsis、裁切和互相覆盖。

## Helmet / Radio / Tank / Jet 高亮

- 交互模型：中奖表现驱动。
- 使用现有官方 Spine NORMAL/ADD 双实例；不以扁平 paytable PNG 替换卷轴素材。
- 普通 Win 与 Big Win 均须触发中奖单元的 ADD 轨道。
- PC、手机、平板及旋转后，NORMAL/ADD 的 world matrix、原点和四角必须一致；滤镜 framebuffer 不得裁掉外溢辉光。

## 特殊模式退出

- EXPANSION/fire 与 OVERDRIVE/snow 的退出完成边界必须晚于：卷轴恢复 3 行、背景 camera track 归位、角色/背景旧轨道清除、旧粒子 kill。
- `PRESENTATION_COMPLETE`、ACK 和下一次 Spin ready 均不得早于该边界。
- 退出完成后的 0ms 与 200ms 截图必须一致，不允许旧火/冰像素残留。

## 帮助与玩法

- 交互模型：菜单点击 + 内容区域滚动。
- 章节顺序取自官方配置：Wild、Vault Bonus、Rage Symbol、Primal Wheel、Kong Quest、King Spin、Paying Symbols、Way Wins。
- 手机和平板使用顶部页签与纵向内容卡；PC 使用固定侧栏。三端内容区均可滚动。
- 玩家页不展示内部 RGS/部署说明，不声明未经当前签名数学定义认证的 RTP、概率或最大赢额。
