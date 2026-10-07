# dsh-tavern-preset-roles

DSH Tavern 游玩时，预设条目按自身的 `role` 发送，不再被强制成 system / user。

预设的导入、开关、前中后排序、应用到本局，全部沿用 DSH Tavern 自带的「预设库」，本插件只在请求发出前改写角色和位置：

| 段 | DSH 原行为 | 本插件 |
|---|---|---|
| 前段 | 拼进唯一的 system 消息 | 每条单独成消息，用条目 role；DSH 自己的人物卡/世界书等 system 材料放在其后（`systemPosition`） |
| 中段 | 塞进本轮 foreground-frame 的写作规则 | 从 frame 里剪出，按条目 `injection_depth` 插进对话，用条目 role |
| 后段 | 强制 user，并与相邻 user 合并 | 剪出后按顺序追加在末尾，用条目 role（assistant 即预填） |

## 安装

已在 DSH Tavern 2.5.0（DSH 0.1.5-rc.2，Windows 桌面版）上使用。下面的 `<DSH Tavern>` 指 DSH Tavern 的安装目录（里面有 `DSH Tavern.exe` 和 `data` 文件夹）。

1. 把本仓库克隆到 DSH Tavern 安装目录**之外**的任意位置，例如 `D:\dsh-plugins\dsh-tavern-preset-roles`（放在外面，升级时不会被清掉）。
2. 关闭 DSH Tavern，编辑 `<DSH Tavern>\data\harness\profiles\tavern\package.json`：
   - 在 `dependencies` 里加一行 `"dsh-tavern-preset-roles": "link:D:/dsh-plugins/dsh-tavern-preset-roles"`（换成你的路径，用正斜杠）；
   - 在 `dsh.profile.bundles` 数组末尾加上 `"dsh-tavern-preset-roles"`。
3. 建立链接（PowerShell）：
   ```powershell
   New-Item -ItemType Junction -Path "<DSH Tavern>\data\harness\profiles\tavern\node_modules\dsh-tavern-preset-roles" -Target "D:\dsh-plugins\dsh-tavern-preset-roles"
   ```
4. 启动 DSH Tavern。

DSH Tavern 升级时会保留你自己加的 bundle 和依赖。卸载：删掉 `package.json` 里加的两处和上面的链接，再重启。

改了插件代码或 `cordis.patch.yml` 之后需要重启 DSH Tavern；只改前端（`lib/client.js`）时按 Ctrl+R 刷新即可。

## 注意

本插件不改 dsh-tavern 的代码，但依赖它的一些内部结构（见下文）。dsh-tavern 升级后如果这些结构变了，插件可能失效。设计上失效时尽量原样放行，不影响酒馆本身；遇到问题请开 issue 并注明 DSH Tavern 版本。

## 配置（cordis.patch.yml）

- `front` / `middle` / `back`：某段设为 `false` 则该段保持 DSH 原样
- `systemPosition`：`after-front`（默认）或 `first`
- `debug`：在 DSH 日志里打印每次改写了几条

## 不改写、原样放行的情况

- 非游玩请求（摘要、后台结算等带 `purpose` 的请求）、silly 对话、卡片工作台
- 旧存储格式的对话（`chats/<id>/snapshots/`）
- 文本对不上（例如 DSH 升级改了组装方式）：日志里会有提示，请求照常发送

## 已知限制

- DeepSeek 接口原样保留中间位置的 system 消息；走 pi-ai 的服务商（Gemini、Claude、OpenAI 等）只认开头一条 system，后面的 system 会被它的适配器转成 user。
- 依赖 dsh-tavern 的内部结构：请求标记 `dsh-tavern.request-handled`、`@deepseek-ai/dsh-system-prompt`、`foreground-frame`，以及 `lib/domain/runtime-presets.js`、`native-conversation-storage.js`。
