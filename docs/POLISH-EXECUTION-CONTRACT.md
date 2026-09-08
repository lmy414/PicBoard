# 本轮并行执行合同（2026-09-07，用户已授权）

优先依据 PHASE-1-POLISH-PLAN.md v2，新增托盘、关闭行为、自启动设置与可交付打包。目标约1小时，先落盘再定点编译，不无限调研。

## 所有权（每个分支只有一名写入者）

- ui：renderer/src/App.tsx、renderer/src/styles.css；可新建renderer/src/ui/Toast.tsx及motion.ts、Icons.tsx。负责现代卡片/布局/通知自动消失/浮层焦点/开合时序/控件接线。
- ball：renderer/src/BloubBall.tsx、renderer/src/ball-settings.ts、新增renderer/src/ball-motion.css及BallIntake.tsx等ball专用模块；不得改App/styles.css。
- controls：仅新增renderer/src/ui/ColorPicker.tsx、Select.tsx、DirectoryField.tsx、ShellSettings.tsx、controls.css及必要Popover.tsx；负责定制控件，自带CSS；不得改App/包配置/现有Rust。
- native：src-tauri/、shared/image-board.ts、renderer/src/platform/、scripts/dev-rust.mjs；如必要可改package*.json。负责托盘/关闭语义/自启动/选择文件夹/原生配置。不改App/BloubBall/styles.css/ui组件。
- 主代理：合并、冲突裁决、修正接缝、最终验收、发布构建/体积报告和README。子代理不自行发布/开机注册/安装到系统。

## 固定接口（不得各自发明）

### 球
BloubBall原props保持兼容；新增可选 intakeState: 'idle'|'over'|'receiving'|'success'|'error'、intakeKey?:number、intakeCount?:number、variant?:'ball'|'brand'|'preview'。旧dragOpen/dropState兼容。ball作者默认variant='ball'，自己的CSS由组件import。新BallIntake口型/符号图卡在同一SVG体系；真实入库成功才吞咽，支持重复成功重触发。
ui作者在App的import处理维护intakeState/key/count，在CollapsedBall调用处传给BloubBall；失败/取消复位、成功徽章SVG固定居中。全局styles不得再覆盖ball专用transform。

### 通用控件（controls导出）
ColorPicker: named export，props {value:string; onChange:(hex:string)=>void; label?:string; disabled?:boolean}，六位HEX，应用内popover，不使用系统color弹窗。
Select: named export，props {value:string; onChange:(value:string)=>void; options:Array<{value:string;label:string}>; label?:string; disabled?:boolean}。
DirectoryField: named export，props {label:string;value:string;onChange:(path:string)=>void;disabled?:boolean}。调用window.imageBoard.pickDirectory(value)，取消返回null不改值；界面注明目录偏好并不迁移数据。
ShellSettings: named export，无必需props；内部读取/更新下面的API。自身提供加载/失败处理，布局紧凑。
控件自己import './controls.css'，类名qib-前缀避免全局冲突；不安装UI库。ui作者用以上接口替换眼睛拾色器/形状和表情select/路径输入，并在SettingsPage加入<ShellSettings/>，可在controls未出现时使用临时外部声明检查，禁止提交stub。

### Host（native提供，shared合同扩充）
export type CloseBehavior = 'float'|'tray'|'quit';
export interface DesktopSettings { closeBehavior:CloseBehavior; autoStart:boolean; autoStartAvailable:boolean; }
ImageBoardApi新增 getDesktopSettings():Promise<DesktopSettings>; setDesktopSettings(patch:{closeBehavior?:CloseBehavior;autoStart?:boolean}):Promise<DesktopSettings>; pickDirectory(initialPath?:string):Promise<string|null>。
默认 closeBehavior='float'：closeWindow收起并保留悬浮球；tray：隐藏主窗但进程/托盘保留；quit：退出。托盘显示小球/打开画板/完全退出，系统关闭事件也遵循设置，不造成关闭递归。托盘打开/折叠必须同步React，不能只改原生窗口尺寸。
为此新增可选 onExpandedChange?(listener:(expanded:boolean)=>void):()=>void；ui收到 Tauri host 事件更新 expanded 及清理交互，不能再次 invoke 造成循环。事件名为 `window:expanded-changed`。
自启动默认关；开发/debug禁止注册debug exe，autoStartAvailable=false，UI说明发布版可用。release下用户显式开启才注册到当前用户，不提权；关闭删除本应用项。实际系统设置读回，不虚构成功；开发验证不得真的写系统启动项。
目录选择使用host原生对话框，仅主窗口调用；取消null。可窄用途插件/受控命令，不开放通用shell/fs。关闭行为保存独立偏好文件，不改state.json业务结构，不混入图片库事务；隔离数据开发的偏好不得污染release。

## 验证与交接

每个作者只在自己worktree编辑，不能读写其他作者worktree代码来代替交接。30分钟左右产出候选代码，必须及时报告实质进展。完成后本地git add指定文件/commit（已授权）并报告commit SHA、改动/必要构建/风险。不要提交target/node_modules/用户数据，不使用git add .盲加。
随后每个作者只读检查另一个候选worktree，最多3个真实阻断问题，文件行号+最小修正，不为建议扩大范围。父代理负责裁决和合并，不允许跨worktree写修正。

不回退最近修好的HTML5小球拖入、DIB粘贴、CF_HDROP/Bitmap复制。不动真实用户图像数据。保留用户颜色/形状偏好与第三方许可证。不承诺已经看过GrokBot视频。
