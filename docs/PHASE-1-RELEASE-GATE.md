# 第一阶段最终发布验收

日期：2026-09-08（测试开始于2026-09-07 23:53）。
结论：**第一阶段 Windows x64 便携形态已交付；本机环境的独立启动、核心图片流程、持久化、关闭生命周期验收通过。不是跨所有Windows设备、所有剪贴板来源的无条件保证。**

## 唯一交付包

`release/quick-image-board-windows-20260908-000131.zip`

- ZIP：2,783,671 bytes，低于50,000,000 bytes。
- SHA256：`84eac0ea2c0d9ebb99c3dcc9352af8ac493d45013fba52e8200158bed501f7ad`。
- EXE SHA256：`3a0485a8515ad00eb61718e7999e7589194e8becab8a9c74ecf9df56ea60123f`。
- EXE与已完成release检查的234407版本完全相同；本次只完善分发说明与依赖许可证，不替换未经验证的二进制。
- `scripts/collect-licenses.mjs`从锁定的Windows x64 Cargo依赖图和前端实际包收集285个依赖记录及随包许可/NOTICE。11个包只有license元数据没有根目录声明文件，清单保留此事实；不是法律合规认证。
- `scripts/package-portable.ps1`检查体积、输出hash/清单；修正Cargo原始1970时间戳无法被ZIP表示的问题，仅规范stage拷贝的时间戳。
- 含主程序、说明、第三方声明。不含源码、node_modules、Cargo target、用户图片或固定WebView2运行时。

## 实际执行，不是mock

1. 对最初234407 ZIP和最终000131 ZIP分别执行Expand-Archive，解压在系统临时目录的`app with spaces`，工作目录为解压后的程序目录。
2. 使用独立`data with spaces`及`WEBVIEW2_USER_DATA_FOLDER`，不接触真实用户库/浏览器profile。
3. 本次验证以WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS临时开本机CDP端口，直接连接真正的WebView2页面，不把浏览器fixture当发布运行；发行包不设置调试端口。
4. 最终包页面URL=`http://tauri.localhost/`，不是开发Vite。正常窗口显示、getDesktopSettings返回float/autoStart=false/autoStartAvailable=true。
5. 前端canvas生成PNG→Uint8Array→真实importImages成功；返回data:image/png预览；移动到(-25,40)、分类成功。
6. create/rename/delete canvas、setCanvasViewport成功；先前一次界面活动改变了视角，故重新在关闭前明确保存{12,-34,1.2}并立即退出，重启读回完全一致，图片名称/分类/坐标也保留。
7. 默认float关闭回到88×88；tray分支通过Win32 EnumWindows/IsWindowVisible验证主窗口visible=false且进程保留；float恢复后visible=true；quit显式退出，随后可重启。
8. 最终000131包在全新数据/profile再次启动；在实际折叠小球DOM派发带PNG File的dragenter/drop，经现有React处理到真实Rust存储，loadState返回1张图片、ARIA显示本次1张、仅1个成功徽章。点击展开后有真实图片卡片。删除fixture图片返回0张。注意：这是程序合成DOM事件，不冒称从Explorer人工拖入的系统输入验证。
9. 所有验收实例均经其自身quit关闭；未终止用户已有的debug运行实例，未操作用户真实剪贴板、未开启系统自启动。

## 发布形态与行为

- 解压运行exe即可，不需要Node/npm/Rust/Vite或项目源码。
- **前置条件：Windows x64 + 系统Microsoft Edge WebView2 Evergreen Runtime。** 未捆绑固定运行时、不承诺无WebView2时可直接运行。
- 关闭方式：float默认保留小球；tray隐藏；quit全退。托盘提供打开/显示球/退出。
- 发布版自启动开关可用，默认关闭；只在用户显式切换时修改当前用户Run项。将解压目录放在固定位置后再开启，移走程序前关闭。
- 默认图片库位于`%APPDATA%\quick-image-board\quick-image-board`，不是ZIP目录。不要与Electron同时写同一库。
- 目录选择仅改变既有目录偏好，不自动改变实际库根或迁移旧文件；这是已确认范围，不承诺不存在的路径迁移功能。
- 未签名便携应用，没有安装器/自动更新；Windows可能显示未知发布者提示。

## 不扩大验收结论

- 自启动真实注册/注销及下次登录未执行（不能未经用户同意自动启用）。代码检查发现的null终止与引号读回问题已在二进制中修正，系统登录结果仍需用户主动确认。
- 系统文件管理器手动拖放、跨应用剪贴板各种源格式依赖此前修复及6项DIB内存回归，本轮不重复替换用户剪贴板。
- 混合DPI/多显示器、缺WebView2的干净机器、完整长时间性能与视觉主观满意度不是本机测试能保证的。
- 便携包交付与独立运行通过，不等于签名安装器/公开分发法律审计完成。

## 第一阶段状态

可运行产品包已明确、核心验收有证据，代码/脚本/文档可回溯。第一阶段的技术交付与核心发布验收闭环；用户主观视觉验收与上述环境专项保留为明确已知边界，不以“保证”掩盖未验证项。
