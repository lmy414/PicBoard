# Rust 壳层迁移记录（P0）

验证日期：2026-09-07

## 本轮范围

本轮严格执行 Astra 计划的 P0 准备切片：

- 将前端类型契约和纯几何函数抽到项目中立的 `shared/` 目录；
- 保留 Electron 原有源码路径为 re-export，确保入口、preload、测试和回滚路径继续可用；
- 让 renderer 只引用中立模块；
- 增加共享边界和几何行为回归测试；
- 保留完整的 `window.imageBoard` 方法名、参数、返回形状和全局声明。

本轮**没有实现 Rust/Tauri/Wry 壳层**。因此没有 Rust 构建、WebView2 运行时、Rust 数据读取或 `<50MB` release 结论；这些属于后续 R0/R1 及发布 gate。

## 修改前基线与恢复点

- 项目目录不是 Git 仓库；没有执行 `git init`，也没有使用 Git 回滚或覆盖既有改动。
- 修改前相关文件清单与 SHA-256 已保存到外部备份：
  - Windows 路径：`E:\M_Workbench\.quick-image-board-p0-backup-20260907-160106`
  - 备份校验清单：`E:\M_Workbench\.quick-image-board-p0-backup-20260907-160106\SHA256SUMS.txt`
- 备份了本轮修改前已存在的：
  - `electron/shared.ts`
  - `electron/main/look-geometry.ts`
  - `electron/main/minimap-geometry.ts`
  - `electron/main/window-geometry.ts`
  - `renderer/src/App.tsx`
  - `renderer/src/BloubBall.tsx`
  - `package.json`
- `package-lock.json` 修改前后 SHA-256 均为：
  - `e930e6b4f0ebb053fc2a07c5645bf30bb48d9b06ad2d35e3d457b23fef72aef3`
- 未读取、写入、迁移或删除真实用户数据；自动化存储测试继续使用系统临时目录。

## 逐文件变更

### 新增

- `shared/image-board.ts`：承接 `ImageStatus`、状态记录、导入/光标 DTO、`ImageBoardApi` 和 `Window.imageBoard` 全局声明。
- `shared/look-geometry.ts`：承接 `LookTarget`、视角上限和 `pointerToLookTarget`。
- `shared/minimap-geometry.ts`：承接小地图类型、投影和逆投影函数。
- `shared/window-geometry.ts`：承接窗口 bounds/work area 类型及展开收起几何函数。
- `tests/shared-boundary.test.mjs`：验证中立模块依赖边界、renderer 路径边界、旧编译路径导出和 preload API 表面。
- `tests/shared-geometry.test.mjs`：以固定预期值验证视角和小地图行为，并比较中立路径与旧 Electron 路径。

### 修改

- `electron/shared.ts`：仅 re-export `../shared/image-board`；全局声明移至中立契约。
- `electron/main/look-geometry.ts`：仅 re-export `../../shared/look-geometry`。
- `electron/main/minimap-geometry.ts`：仅 re-export `../../shared/minimap-geometry`。
- `electron/main/window-geometry.ts`：仅 re-export `../../shared/window-geometry`。
- `renderer/src/App.tsx`：类型和小地图导入改为 `shared/`。
- `renderer/src/BloubBall.tsx`：视角几何导入改为 `shared/`。
- `package.json`：只在既有 `test` 脚本末尾追加两个新测试文件；没有新增依赖或脚本。

未修改：Electron preload/main/storage/clipboard、renderer 业务逻辑/CSS/main、TypeScript 配置、`package-lock.json`、用户数据格式和默认入口。

## 验证结果

### P0 修改前基线

执行并通过：

```text
npm run typecheck
npm test
npm run build
```

修改前实际 Node 测试结果为 `22` 个通过、`0` 个失败。文档中旧的 6/6 或 8/8 记录未作为本轮证据使用。

### P0 修改后

执行并通过：

```text
npm run typecheck
npm test
npm run build
```

结果：

- `npm run typecheck`：退出码 0；Electron 和 renderer TypeScript 检查通过。
- `npm test`：退出码 0；`28` 个测试通过，`0` 个失败。
  - 新增共享边界测试 4 个；
  - 新增共享几何测试 2 个；
  - 原有 storage、UI surface、Windows clipboard、window geometry、window main 测试均保留并通过。
- `npm run build`：退出码 0；Vite renderer 与 Electron TypeScript 构建均通过。
  - Vite 输出了既有的 CJS Node API deprecated warning；不影响构建结果，未升级依赖。
- 实际本地 Electron runtime：`node_modules/electron/dist/version` 为 `32.0.0`；没有用 package 声明版本替代实际 runtime。
- `dist/`、`dist-electron/` 仅由验证命令按现有构建流程生成/更新，没有手工编辑，也没有将其作为源码变更交付。

共享编译输出确认仍包含：

```text
dist-electron/shared/image-board.js
dist-electron/shared/look-geometry.js
dist-electron/shared/minimap-geometry.js
dist-electron/shared/window-geometry.js
```

旧 Electron 输出路径仍包含：

```text
dist-electron/electron/main/index.js
dist-electron/electron/preload/index.js
dist-electron/electron/shared.js
dist-electron/electron/main/look-geometry.js
dist-electron/electron/main/minimap-geometry.js
dist-electron/electron/main/window-geometry.js
```

## Electron 回滚与 GUI 状态

- 原 Electron 默认入口、`npm run dev`、`npm run build:electron` 和 preload API 未删除或替换；旧几何/契约路径由 re-export 保持可导入，自动化兼容测试已通过。
- 可回滚方式：关闭应用，从上述外部备份恢复 7 个既有文件，删除 7 个本轮新增源码/测试/文档文件，并重新运行 `npm run build`；不触碰用户数据。
- 本轮未执行真实 GUI smoke test，也未启动 Electron 窗口、DevTools、文件管理器或跨应用剪贴板验证。原因是本轮 P0 只要求中立契约抽离，且不应把后续桌面交互验收写成已通过。
- 因此透明窗口、置顶、跨显示器/DPI、长按拖动、WebView2 资源加载和真实用户目录读取仍是后续 R0/人工验收风险。

## 后续 gate（本轮不实施）

只有在明确授权新增 Rust/Tauri 依赖、具备 Windows/WebView2 验证环境并准备隔离数据副本后，才进入 R0。R0 必须保持只读、显式数据根目录和 Electron 并行回滚路径；存储写入、剪贴板 parity、偏好迁移、release 体积测量均不得由本轮 P0 的测试结果替代。

---

# Rust/Tauri 壳层实施记录（R0 完成：可开发启动）

实施日期：2026-09-07（Rust 迁移单轮连续实施）

## 本轮目标与结论

将原有 P0 记录中的“后续 gate”在本轮授权下实施完成：Tauri 2 + 系统 WebView2
壳层、`ImageBoardApi` 全部方法的真实 Rust 路径、串行状态写入与损坏恢复、Windows
原生剪贴板（图片读取 + 文件/位图复制）、窗口/悬浮球/光标事件等价迁移、开发模式
实际启动验证。

**结论：实现完整接入并通过隔离数据开发启动。不宣称完成真实用户数据迁移、跨应用
剪贴板/多显示器 GUI 验收或 release 体积达标。**

## 启动命令

```powershell
# Rust/Tauri 开发（推荐，自动使用隔离临时数据根）
npm run dev:rust

# 带偏好迁移文件启动（先导出 Electron 偏好）
npm run build
npm run export:prefs        # 生成 preferences-export.json
npm run dev:rust -- --preferences-export preferences-export.json

# Electron 回滚入口（原样保留）
npm run dev:electron        # 等同旧 npm run dev
npm run build:electron
```

`npm run dev:rust` 执行 `scripts/dev-rust.mjs`：
- 在系统临时目录新建一次运行专用会话目录（`%TEMP%/quick-image-board-rust-dev-*`）；
- 业务数据写入该会话的 `data/`，经 `--data-root` 传给应用；
- 日志输出到终端；会话目录路径启动时打印，不会被自动删除（供检查与清理）。

生产构建入口（不要求本轮发布验收）：

```powershell
npm run build:renderer      # 产出 dist/，供 frontendDist
npx tauri build             # 可选：Rust release 构建
```

## 隔离与数据安全

- 开发启动一律通过 `scripts/dev-rust.mjs` 的临时目录，绝不读写真实用户数据。
- Rust host 支持 `--data-root <path>` 与 `QUICK_IMAGE_BOARD_DATA_ROOT` 两个覆盖入口；
  无覆盖时默认解析为 Electron 兼容目录 `%APPDATA%/quick-image-board/quick-image-board`。
- 偏好迁移（`quick-image-board.ball-settings` / `quick-image-board.path-settings`）
  不解析 Chromium LevelDB；由 `npm run export:prefs` 在 Electron 侧原 origin 读取两个
  localStorage key 输出受控 JSON，Rust 经 `--preferences-export` 校验后提供，
  renderer 在 React 初始化前完成种子，已有值不覆盖。

## 架构与能力映射

| ImageBoardApi 方法 | Rust command | 模块 |
|---|---|---|
| loadState | load_state | storage.rs |
| importImages | import_images | storage.rs |
| pasteImage | paste_image（读系统剪贴板→PNG→导入） | storage.rs + clipboard/windows.rs |
| setActiveCanvas / setCanvasViewport | set_active_canvas / set_canvas_viewport | storage.rs |
| createCanvas / renameCanvas / deleteCanvas | 同名 snake_case | storage.rs |
| createCategory / classifyImages | 同名 snake_case | storage.rs |
| removeImageFromCanvas / moveImage | 同名 snake_case | storage.rs |
| copyImageFiles | copy_image_files（CF_HDROP + 单图 Bitmap） | storage.rs + clipboard/windows.rs |
| setExpanded / closeWindow | set_expanded / close_window | window_controller.rs |
| startWindowDrag / endWindowDrag | start_window_drag / end_window_drag | window_controller.rs |
| onCursorPosition | `window:cursor-position` 事件（50ms） | window_controller.rs |

- renderer 桥接：`renderer/src/platform/`（bootstrap / tauri-adapter / preferences）；
  Electron preload 注入对象时直接保留，Tauri 时安装 `@tauri-apps/api` adapter。
- 事件注册异步、`onCursorPosition` 同步退订（adapter 维护 ready/unlisten 桥）。
- 存储：串行锁 + 临时文件 + sync + 备份 + Windows 替换 + corrupt 副本 + `.trash`
  回滚，与 Electron storage.ts 语义对齐。
- 图片预览 dataUrl 与 storageNotice 仅在内存返回，不写入 state.json。

## 依赖与配置

- `src-tauri/Cargo.toml`：tauri 2.11（wry、common-controls-v6）、serde/serde_json、
  uuid、chrono、base64、image（bmp/gif/jpeg/png/webp）、dirs；Windows 目标用
  windows-sys 0.61 原生实现剪贴板与光标读取。
- 未捆绑/固定 WebView2 runtime；release 分发方向为系统 WebView2。
- `src-tauri/tauri.conf.json`：identifier `com.quickimageboard.app`（可运行）；窗口由
  Rust host 手动创建（`windows: []` 避免双窗）；frontendDist `../dist`、devUrl Vite。
- Cargo.lock 已生成并纳入 src-tauri/。

## 验证结果（本轮实际执行）

- `cargo check` / `cargo build`：通过（无 error；少量 dead_code 警告来自预留接口）。
- `npm run typecheck`：通过。
- `npm run build`（renderer + electron TS）：通过。
- `npm test`：28/28 通过（Electron 基线未破坏）。
- `npm run dev:rust`（隔离临时目录）：
  - Rust host 打印隔离 data-root；
  - WebView 加载 `http://127.0.0.1:5173` Started→Finished；
  - 88×88 无边框透明置顶窗口于主屏工作区右上角（x=1424,y=20 @scale 1.25），可见；
  - PrintWindow 捕获确认渲染成功（中心像素为小球主体色 #0a0a0c）；
  - `state.json` 在隔离 data 根生成默认库（画布 1、分类 角色/其他、viewport
    -900,-500,1），无 dataUrl/storageNotice 泄漏到磁盘。

## 残余 GUI 风险（未自动化实测）

- 展开/收起点击与尺寸过渡（host 命令已实现，未做点击级自动化）；
- 悬浮球长按拖动跨显示器/工作区边界；
- 跨应用（Explorer/图片编辑器）粘贴与复制的真实格式兼容；
- 混合 DPI/多显示器下光标事件与窗口坐标的实机复核；
- 真实 Electron 用户数据目录（旧数据格式）的读入——开发验证全程使用隔离目录。

## 回滚方式

- Electron 入口与既有测试完整保留；`npm run dev:electron` 恢复原 Electron 行为。
- 若需撤销 Rust 壳层：删除 `src-tauri/`、恢复 `package.json`/`package-lock.json` 的
  Tauri 依赖改动，并移除 renderer platform/ 与 main.tsx host bootstrap 改动即可。
