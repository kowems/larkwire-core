# @larkwire/core

灵鹊 Larkwire 的电脑端桥：跑在你的 Mac / Linux 上，把 Claude Code（以及任何 stream-json 兼容的 Agent CLI）会话安全地送上你的手机。

- **看**：手机实时滚动电脑上的 Agent 输出，出门也知道干完没有
- **接**：人离开后，手机可以接管会话继续发话
- **控**：权限卡（确认执行）直接在手机上点，不用冲回电脑前
- 端到端加密（X25519 + NaCl box），中继对内容**零可见**
- MIT 开源

## 安装

需要 Node.js ≥ 22。

```bash
npx @larkwire/core up
```

`up` 是单入口：未配对会自动先配对（终端显示二维码，手机 App 扫码即可），配对成功直接进入监听；配对 token 过期会明确报错退出，不会傻等。

全局安装也行（命令名仍是 `larkwire`）：

```bash
npm install -g @larkwire/core
larkwire up
```

## 三分钟上手

1. 手机安装灵鹊 App（iOS TestFlight / Android，见官网 <https://larkwire.kowems.site>）
2. 电脑终端跑 `npx @larkwire/core up`，用 App 扫终端里的二维码
3. 正常在电脑上开 Claude Code 干活，会话自动出现在手机上

手机端可以：看实时输出、权限卡点允许/拒绝、人离开电脑后接管发话、会话被占时候查看占用状态。

## 命令一览

| 命令 | 作用 |
|------|------|
| `larkwire up` | 单入口：未配对先配对 → 进入 watch |
| `larkwire pair` | 仅配对 |
| `larkwire watch` | 仅监听（已配对过） |
| `larkwire sessions` | 查看本机注册的会话 |
| `larkwire unpair` | 解除与手机的配对 |
| `larkwire install` | 安装 launchd 开机自启（macOS） |

## 作为库嵌入

桥核心也可以直接嵌入（桌面壳就这么用）：

```ts
import { startBridge, type BridgeHandle } from "@larkwire/core";

const bridge = await startBridge({
  onLog: (line) => console.log(line),
});
// bridge.stop()
```

## 隐私

- 手机与桥之间 E2E 加密，官方中继只转发密文，看不到任何会话内容
- 配对基于二维码 + 公钥指纹，扫码时手机和终端会显示同一段指纹供人工核对
- 不收集对话内容；中继只做转发、配对路由、离线暂存（10 分钟 TTL）和用量计数
- **离线推送的边界**（2026-10-08 起）：通知可带**项目目录名最后一段**与权限**工具名**
  （如 `🔐 larkwire · Bash 等你授权`）；完整路径、命令、输入内容、会话标题永不出端。
  详见 [`@larkwire/relay` 的「推送与隐私边界」](../relay/README.md#推送与隐私边界)

## 相关包

- [`@larkwire/protocol`](https://www.npmjs.com/package/@larkwire/protocol) — 三端共享协议
- [`@larkwire/relay`](https://www.npmjs.com/package/@larkwire/relay) — 哑中继（也可完全自建）

## License

MIT
