# 图片打开性能实测

2026-11-03。在下述本机条件下，运行中的画板打开已有图片，新版三个样本、每种冷开/再次打开各三轮，**完整原图解码及可见首帧均小于 1,000 ms**。新版最慢可见首帧为 **603.8 ms**，最慢完整解码为 **528.2 ms**。

这些结果衡量从画布双击到原图显示，不包含文件选择对话框、外部图片首次入库、Tauri/WebView 冷启动，也不代表任意硬件、任意体积图片均可在一秒内打开。

## 环境与样本

- Windows 11 x64，版本 `10.0.26200`。
- Intel Core i7-11800H，8 核 / 16 线程，约 64 GiB 内存。
- Microsoft Edge `156.0.4314.58`，Playwright `channel: msedge`，headless。
- 窗口 `1000 × 700`，正常动效，Vite 本地开发服务 `127.0.0.1:5173`。
- 使用真实 App、ContentPage 和 ImageContentPage。测试宿主提供已有内容元数据；原图从本地 HTTP 静态文件获取，经过浏览器真实解码，不用 data URL 代替原图传输。

样本由固定种子的纹理、渐变和文字生成，包含较多像素变化。PNG 保留原始像素；JPEG 样本在准备阶段以 95% 质量编码。对照与新版使用相同文件，不重新编码、缩小尺寸或降低质量。

| 样本 | 原始尺寸 | 文件字节数 | 约合 MB |
| --- | --- | ---: | ---: |
| 1080p PNG | 1920 × 1080 | 3,299,155 | 3.30 |
| 4K PNG | 3840 × 2160 | 12,536,308 | 12.54 |
| 较大 JPEG | 6000 × 4000，24 MP | 14,187,745 | 14.19 |

## 测量口径

每个样本执行三轮，每轮包含冷开和关闭后再次打开，共 18 次打开：

1. 冷开使用 CDP 禁用 HTTP 缓存，给原图分配唯一 URL，不预载完整图片。检查真实 HTTP 请求和传输字节数，避免把已在内存里的原图误当冷开。
2. 再次打开使用同一 URL，允许浏览器正常缓存。浏览器仍可根据自身策略重新请求或丢弃解码缓存。
3. 从真实画布双击事件开始计时，分别记录 `HTMLImageElement.decode()` 完成、完整解码后的可见首帧，以及图片和父级达到 99% 总透明度的时间。
4. 首帧必须满足原图解码完成、实际尺寸正确、元素可见，以 `requestAnimationFrame` 观察并跨帧确认。每次断言 `firstFrameMs >= decodeMs`、`fullOpacityMs >= decodeMs`，不能把已拿到图片尺寸或开始改变透明度当作原图像素已经显示。

对照版使用 `v0.2.0` / `9c84608` 的 ImageContentPage，经测试工具编译后只替换浏览器中的查看页模块。App 和测量代码相同，不切换工作目录或改动运行中的桌面程序。以下仅引用同一最终测量口径的 `baseline-verified` 与 `optimized-verified` 两份报告；早期调试报告不用于比较。


## 结果

| 样本 / 打开方式 | 对照解码 | 新版解码 | 对照首帧 | 新版首帧 | 对照全不透明 | 新版全不透明 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1080p.png / 冷开 | 126.7 | 418.0 | 161.1 | 424.4 | 276.8 | 494.4 |
| 1080p.png / 再次打开 | 11.7 | 12.9 | 32.7 | 20.3 | 157.8 | 138.2 |
| 4k.png / 冷开 | 794.1 | 528.2 | 798.5 | 535.4 | 916.5 | 535.4 |
| 4k.png / 再次打开 | 15.1 | 18.0 | 27.2 | 27.6 | 158.6 | 145.1 |
| 24mp.jpg / 冷开 | 499.7 | 526.5 | 582.9 | 603.8 | 619.8 | 603.8 |
| 24mp.jpg / 再次打开 | 10.1 | 12.7 | 15.7 | 19.8 | 147.6 | 137.9 |

数值均为三轮中的最大值，单位 ms。全不透明保留正常整页动效，作为图片已清晰显示的保守补充指标。

两版在这组样本中都达到一秒目标。不同样本并非都变快：本轮 1080p 冷开最大解码时间上升，24 MP 解码时间也略有增加。HTTP、解码与开发机负载存在波动，因此不推导统一加速倍数。

本轮确定性优化包括：

- 原图 eager 加载，并提升浏览器请求优先级。
- 在布局阶段完成尺寸适配，检查已经加载完成的缓存图片，避免首帧仍等待 React load 事件。
- 移除原图自身额外的 200 ms 透明度渐入，加载完成后立即显示，加载提示也立即退出。
- 原生协议中 Full / Asset 使用独立 2 线程队列，Thumb / AssetThumb 使用独立 4 线程队列，避免冷缩略图的全图解码占满原图读取队列。

原图字节、格式和响应缓存规则保持不变。正常整页过渡仍参与全不透明指标。浏览器基准不经过 Tauri 自定义协议，不能由这组数字直接推导原生分池收益。

## 原生读取与入库补充测量

Rust 手动基准使用同一组三个原始文件，保存到新的临时内容库后，重复 20 次真实 resolve_image 和 serve_original；每轮核对响应字节与输入完全一致。文件已经过 OS 缓存，临时库内容少，未制造存储锁竞争。以下不包含 IPC、WebView 解码和画面呈现。

| 样本 | 路径查找最大值 | 查找 + 读取中位数 | 查找 + 读取最大值 | 单独入库耗时 |
| --- | ---: | ---: | ---: | ---: |
| 1080p PNG | 0.759 ms | 1.597 ms | 2.181 ms | 38.695 ms |
| 4K PNG | 0.601 ms | 4.871 ms | 5.827 ms | 80.291 ms |
| 24 MP JPEG | 0.625 ms | 5.411 ms | 6.147 ms | 98.025 ms |

原图协议只做受控路径解析、文件类型头检查和一次文件读取，不重新编码。路由回归覆盖 Full / Asset 原图队列、Thumb / AssetThumb 缩略图队列及无效路径；原有缩略图编码和缓存测试继续通过。

## 外部导入与冷启动边界

冷启动后台调度已经实施：

- 初始参数路径在 Builder 创建前只入队，不再在窗口创建之前同步读取和入库图片。
- 两个 WebView、WindowController、位置/显示就绪控制和关闭行为安装完成后，再由单个后台 worker 消费队列；后来请求也通过队列唤醒同一 worker。
- 适配层等待 image:opened 监听注册成功后才执行 take_pending_image 握手。原生 PendingImage 在同一锁内决定走待取结果还是事件通道，避免早到结果丢失或同一结果被两条通道重复打开。页面重载会重置渲染器就绪状态。
- 所有早到路径都会入库；渲染器未就绪时保留最新的待导航内容 ID，保持多图参数最后打开一张的原有行为。worker 启动失败时保留路径供重试。首进程无图启动仍由正常就绪流程控制，自启动无图不新增无条件显示；第二次手动无图启动会激活已有主窗口，第二次自启动请求仍保持静默。无图激活不启动图片 worker。

以上改善启动顺序与交付可靠性，尚未构成从资源管理器启动到图片可见的完整耗时测量。


外部图片打开、底部导入和编辑副本保存，还要校验、全量字节哈希、保存原图和持久化状态。随后放入画布时还会提交节点状态，首次缩略图显示另有解码/缩放/编码。系统文件选择、文件关联和窗口/WebView 创建不在画板双击计时中。

排查确认入库中的重复校验主要是格式/尺寸头解析，并非两次全量像素解码。主要开销包括原图写盘/同步、状态提交、冷缩略图生成和导入持有存储锁的时间。既有 128 MiB 字节上限、40 MP 像素上限及错误检查均保留。

独立队列避免缩略图占满原图工作线程，但导入持有存储锁时，原图路径查找仍可能等待。这里的入库耗时来自空临时库的局部测量，不能与浏览器数字简单相加后宣称资源管理器冷启动也小于一秒。外部导入和冷启动需要单独端到端验收。

## 复现

先运行本地服务：

```powershell
npm run dev:renderer
```

在另一个 PowerShell 中执行。测试会生成样本，原始 JSON 保存在被 Git 忽略的 test-results 中：

```powershell
$env:PICBOARD_IMAGE_VIEW_BASELINE = '1'
$env:PICBOARD_IMAGE_VIEW_BASELINE_REV = 'v0.2.0'
$env:PICBOARD_IMAGE_PERF_PHASE = 'baseline-verified'
node node_modules/@playwright/test/cli.js test tests/browser/image-view-performance.spec.ts --workers=1 --reporter=line --output=test-results/image-performance-baseline-run
Remove-Item Env:\PICBOARD_IMAGE_VIEW_BASELINE
Remove-Item Env:\PICBOARD_IMAGE_VIEW_BASELINE_REV

$env:PICBOARD_IMAGE_PERF_PHASE = 'optimized-verified'
node node_modules/@playwright/test/cli.js test tests/browser/image-view-performance.spec.ts --workers=1 --reporter=line --output=test-results/image-performance-run
Remove-Item Env:\PICBOARD_IMAGE_PERF_PHASE
```

报告文件：

- `test-results/image-performance-baseline-verified.json`
- `test-results/image-performance-optimized-verified.json`

手动原生读取基准：

```powershell
$env:PICBOARD_PROTOCOL_BENCH_PATHS = @(
  (Join-Path $PWD 'test-results/image-performance-assets/1080p.png')
  (Join-Path $PWD 'test-results/image-performance-assets/4k.png')
  (Join-Path $PWD 'test-results/image-performance-assets/24mp.jpg')
) -join [IO.Path]::PathSeparator
cargo test --manifest-path src-tauri/Cargo.toml --lib protocol::tests::benchmark_original_lookup_and_read -- --ignored --nocapture
Remove-Item Env:\PICBOARD_PROTOCOL_BENCH_PATHS
```

该基准平时标为 ignored，避免日常测试依赖外部图片文件和机器性能；普通协议回归仍随 Rust 测试执行。
