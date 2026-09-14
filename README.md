# IPATool GUI

[中文](#简介) · [English](#what-this-is)

一个跨平台桌面应用，为 [majd/ipatool](https://github.com/majd/ipatool) 提供完整的图形界面：
搜索 App Store、查看版本历史、批量下载 `.ipa` / `.pkg` 安装包、管理下载队列与凭据。

**仓库里不含任何 ipatool 二进制文件。** 首次运行时从官方 GitHub Releases 下载，
并校验官方发布的 SHA-256；编译与打包全部在 GitHub Actions 中完成。

---

## 简介

`ipatool` 是一个命令行工具。本项目的定位是它的**前端**：不自己实现任何 Apple 私有协议，
所有与 App Store 的交互都通过调用 `ipatool` 完成。因此：

- 本仓库只有 TypeScript 源码，**不存储、不分发 ipatool 可执行文件**；
- 应用会自行定位或安装 ipatool（见下文「ipatool 从哪里来」）；
- ipatool 升级后，GUI 无需改动即可跟随（命令面按 v2.6 实现，向前兼容）。

### 功能清单

| 模块 | 能力 |
| --- | --- |
| 引擎 | 自动探测 PATH / Homebrew / scoop / WinGet 等安装位置；缺失时自动下载 + SHA-256 校验 + 解包；可固定版本、可配置 GitHub 镜像、可卸载托管副本 |
| 登录 | 邮箱 + 密码登录；**两步验证（2FA）在 GUI 内完成第二段输入**；查看账户信息；吊销凭据；记住邮箱 |
| 搜索 | 关键字 / Bundle ID 搜索；平台筛选（iPhone / iPad / Apple TV / visionOS / Mac）；结果数限制；搜索历史；应用图标（主进程代理抓取并缓存） |
| 版本历史 | `list-versions` 的全部历史版本；按需解析可读版本号与发布日期（并发受限 + 缓存）；下载任意指定版本 |
| 已购项目 | 分页加载名下应用；客户端二次筛选；多选批量下载；滚动到底自动加载下一页 |
| 下载队列 | 可调并行数（1–8）；**真·暂停/继续**（基于 ipatool 的 Range 续传，见下文）；取消 / 重试 / 排序 / 移除；速度、剩余时间、百分比；完成后定位文件；失败自动给出可操作建议；队列跨重启持久化 |
| 批量导入 | 导入文本/JSON 列表：支持 Bundle ID、App Store 链接、track ID、`id: …, name: …` 键值行、管道分隔行 |
| 活动日志 | 每次 ipatool 调用的完整输出；进度行自动折叠；可按关键字过滤；导出为文本；命令中的密钥全部脱敏 |
| 命令行台 | 直接运行任意 ipatool 子命令（含交互模式开关），用于排障与高级用法 |
| 设置 | 中英双语（默认跟随系统）、明暗主题、下载目录、钥匙串口令策略、凭据目录隔离、日志上限、通知等 |
| 其他 | 命令面板（⌘/Ctrl+K）、全局快捷键、窗口关闭前确认、检查更新 |

### 截图

应用为原生窗口（macOS 隐藏式标题栏、Windows 标题栏叠加按钮），
首次启动会出现 ipatool 安装向导。界面为深色优先的现代风格，列表全虚拟化。

---

## 关键设计决策

### 为什么不是「纯网页前端」

浏览器里的 JavaScript **没有任何途径**执行本地命令行——这是沙箱的硬限制。
「纯前端 + 调用 ipatool」必须依赖一个宿主进程。权衡后选择 Electron：

- 全栈 TypeScript，主进程 / preload / 渲染进程共享类型与纯逻辑层，编译期即可发现 IPC 不一致；
- 渲染层与其它方案同样是 webview，UI 流畅度没有差别；
- 打包产物覆盖 Windows（NSIS + 便携版）、macOS（dmg）、Linux（AppImage + deb）。

> 若你更想要 Tauri/Wails 的体积，`src/shared/` 与 `src/main/` 的命令构建、输出解析、
> 队列与引擎逻辑均为平台无关的纯逻辑，可以较直接地移植到 Rust/Go 壳中。

### 暂停 / 继续是怎么做到的

ipatool 没有 `--resume` 参数，但它的 `downloadFile()` 会打开 `<目标>.tmp`、读取已有大小，
并发送 `Range: bytes=<已有字节>-` 请求头后从文件末尾续写。因此：

- **暂停 = 杀掉子进程**，`.tmp` 保留在磁盘上；
- **继续 = 用相同参数重跑同一条命令**，ipatool 自动从断点续传。

长时间暂停后 Apple 可能拒绝字节范围（HTTP 416），此时队列会给出
「丢弃未完成文件」按钮，从 0 字节重新开始。

### 下载进度是怎么解析出来的

`download` 以**交互模式**运行（progressbar 只在交互模式创建，且不要求 TTY 也会输出），
输出形如：

```
downloading  21% [======>       ] (12/45 MB, 1.2 MB/s)
```

注意三个容易踩错的细节，解析器都已处理：单位是 **1000 进制**且带前导空格；
当前值与总量同单位时会塌缩成 `12/45 MB`；速率与进度在**同一个括号**里，
朴素的「取前两个尺寸」会把速率当成总量。解析器用多条互不依赖的正则容错匹配，
并以**轮询 `.tmp` 文件大小**作为兜底数据源（字节数精确，且不依赖 bar 的版式）。

### 性能与流畅性

- **进度不经过 React**：主进程按 10 Hz 节流推送，渲染进程通过 `progressBus` 直接写
  `transform: scaleX()` 与 `textContent`（合成器路径，不触发布局与重渲染）；
- **队列快照合并**：主进程 4 Hz 推全量快照，渲染进程按「结构签名」比对，
  未变化的行**复用原对象引用**，`React.memo` 因此真正生效；
- **全虚拟化列表**：搜索结果、已购项目、下载队列、日志均为定高虚拟滚动；
- **IPC 与日志上界**：每任务日志环形缓冲（默认 2000 行）、任务数上限 200、图标 LRU 缓存；
- 首屏不等网络：窗口 `ready-to-show` 后才做引擎探测与账户刷新。

### 安全模型

- 渲染进程 `sandbox: true` + `contextIsolation: true` + 严格 CSP；禁止导航与新建窗口；
- preload 只暴露一个冻结的 `window.api` 对象（显式白名单）；
- **密码 / 2FA / 钥匙串口令在落盘、展示、导出前全部脱敏**；Apple ID 密码从不持久化；
- 托管钥匙串口令用 Electron `safeStorage`（DPAPI / Keychain / libsecret）加密存储；
- 引擎下载校验官方 `.sha256sum`，不一致即拒绝安装。

---

## 构建与安装

### 方式一：GitHub Releases（推荐）

推送 `v*` 标签后，`.github/workflows/release.yml` 会在 Windows / macOS / Linux
三个矩阵上构建并上传安装包到 Draft Release。未做代码签名：

- **macOS**：首次打开请右键 → 打开（或 `xattr -d com.apple.quarantine`）；
- **Windows**：接受 SmartScreen 提示即可。

### 方式二：本地开发

```bash
npm install          # 需要 Node 20.19+ / 22+
npm run dev          # esbuild 监听主进程 + Vite HMR + 自动拉起 Electron
```

> 仅做验证而无需启动 GUI 时：
> `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install`，然后 `npm run typecheck && npm test && npm run build`。

### 方式三：本地打包

```bash
npm run dist         # 当前平台
npm run dist:win     # Windows NSIS + portable
npm run dist:mac     # macOS dmg/zip（未签名）
npm run dist:linux   # AppImage + deb
```

产物在 `release/`。Linux 打包需要 `fakeroot`、`dpkg`、`rpm`、`libarchive-tools`
（CI 已安装）。

### 测试

```bash
npm test             # vitest：命令构建、输出解析、tar 解包、错误分类、脱敏、导入解析、队列合并
npm run typecheck    # 主进程/preload 与 渲染进程 两个 tsconfig 全量检查
```

---

## ipatool 从哪里来

按以下顺序解析，命中即止：

1. 设置里手动指定的路径（或 `IPATOOL_PATH` 环境变量）；
2. 应用托管目录 `<userData>/bin/ipatool`；
3. `PATH`；
4. 常见安装目录（`/opt/homebrew/bin`、`scoop`、`WinGet`、`~/.local/bin` …）。

全都找不到且开启了自动安装时，从 `majd/ipatool` Releases 下载匹配当前
`os/arch` 的 `ipatool-<v>-<os>-<arch>.tar.gz`，校验 `.sha256sum` 后解包安装。
可在设置中固定版本或配置镜像前缀（例如 `https://gh-proxy.com`）。

---

## 目录结构

```
src/
  shared/            平台无关纯逻辑（有单测）
    ipatool/args.ts      ipatool v2 命令面（参数构建）
    ipatool/parse.ts     zerolog JSON + progressbar 输出解析
    ipatool/errors.ts    失败 → 稳定错误码（供 i18n）
    import.ts            批量导入列表解析
    semver.ts tar.ts redact.ts format.ts
  main/              Electron 主进程
    runner.ts            子进程流式执行（\r 分段 / 脱敏 / 可杀）
    api.ts               高层操作（登录 2FA、搜索、下载…）
    queue.ts             下载队列（续传 / 并发 / 持久化 / 节流）
    engine.ts            引擎定位 / 下载 / 校验 / 安装
    artwork.ts http.ts settings.ts tasks.ts ipc.ts window.ts index.ts
  preload/           唯一 IPC 出口（冻结的 window.api）
  renderer/          React 19 + Vite + Tailwind 4
    src/store/           zustand 状态（快照合并、进度旁路）
    src/lib/progressBus  进度直写 DOM 的总线
    src/components|pages i18n(zh-CN/en-US)
.github/workflows/   ci.yml（验证）+ release.yml（三平台打包发布）
tests/               vitest 单测 + 真实 tar 固件
```

---

## 许可与声明

MIT。ipatool 为 majd 的独立 MIT 项目，本项目不重新分发它。

请只下载你有权获取的应用。自动化访问 App Store 可能触发 Apple 的限流或账户标记。

---

## What this is

A desktop GUI for [ipatool](https://github.com/majd/ipatool): search the App Store,
browse version history, and download `.ipa`/`.pkg` packages with a resumable,
parallel download queue. The repository ships **no** ipatool binary — it is resolved
at runtime or fetched from official releases with SHA-256 verification. Builds run in
GitHub Actions for Windows, macOS and Linux.

Key points: 2FA handled inside the GUI, real pause/resume (via ipatool's ranged
downloads), virtualised lists, progress painted outside React, secrets redacted
everywhere, zh-CN/en-US UI. See the Chinese section above for the full design notes.
