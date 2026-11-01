# 处理节点插件接口

这份文档写给要写 PicBoard 处理节点插件的人。这一版只定义接口：插件能被发现、加载和校验，界面上能看到它声明的处理节点。运行处理节点的按钮和画布上的数据线在后续版本实现。

## 插件目录

插件放在数据目录下的 `plugins` 文件夹里，一个插件一个子文件夹。

```
<数据目录>/plugins/<插件文件夹>/
├── manifest.json
└── main.js
```

数据目录就是设置页里显示的文件路径。`plugins` 文件夹在第一次读取时自动创建。

`main.js` 是默认入口。你可以在 manifest 里用 `main` 字段换成别的 `.js` 文件。入口必须留在插件文件夹内部，不能写成绝对路径，也不能用 `..` 跳出目录。

入口文件最大 1 MiB，按普通脚本执行，不能用 `import` / `export` 语法。

## manifest.json

```json
{
  "apiVersion": 1,
  "id": "text-tools",
  "name": "文本工具",
  "version": "0.1.0",
  "main": "main.js",
  "description": "几个常用的文本处理节点。"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `apiVersion` | 是 | 必须是 `1`。其他值直接拒绝加载 |
| `id` | 是 | 插件标识，小写字母、数字和连字符，长度 1 到 64，必须以字母或数字开头 |
| `name` | 是 | 显示名，不能为空 |
| `version` | 是 | 插件版本号，不能为空。写什么都行，建议用语义化版本 |
| `main` | 否 | 入口脚本，默认 `main.js` |
| `description` | 否 | 一句话说明 |

`id` 在已安装的插件里必须唯一。重复的插件只有第一个会被加载，后面的显示为错误。

## 写一个处理器

入口脚本通过全局变量 `picboard` 注册处理器。`registerProcessor` 只能在加载期间同步调用，加载结束后再调用会抛错。

```js
picboard.registerProcessor({
  id: "uppercase",
  title: "转为大写",
  description: "把输入的文本转为大写，并追加后缀。",
  inputs: [{ id: "text", label: "文本", type: "text" }],
  outputs: [{ id: "text", label: "文本", type: "text" }],
  params: [{ id: "suffix", label: "后缀", type: "string", default: "" }],
  run(request) {
    const suffix = request.params.suffix;
    const values = request.inputs.text || [];
    return {
      outputs: {
        text: values.map((value) => ({
          type: "text",
          text: (value.type === "link" ? value.url : value.text).toUpperCase() + suffix,
        })),
      },
    };
  },
});
```

处理器 id 和插件 id 用同一套规则：小写字母、数字和连字符。完整 id 是 `插件 id/处理器 id`，例如 `text-tools/uppercase`。

## 端口类型

端口有三种类型：`text`（文本）、`link`（链接）、`image`（图片）。

| 输入端口 | 接受的值 |
| --- | --- |
| `text` | 文本、链接 |
| `link` | 链接 |
| `image` | 图片 |

文本端口接受链接，因为链接就是带 URL 的文本。链接端口只接受链接，图片端口只接受图片。

输出端口的要求更严格：值的类型必须和端口声明的类型完全一致。声明为 `text` 的输出端口不能返回链接。

`PortSpec` 的字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 端口 id，同一个方向内唯一 |
| `label` | 是 | 显示名 |
| `type` | 是 | `text`、`link` 或 `image` |
| `multiple` | 否 | 为 `true` 时端口可以接多个值，默认只接一个 |
| `optional` | 否 | 输入端口可以为空，默认必填 |

## 参数

参数是用户在运行节点前填的值。声明在 `params` 数组里，id 不能重复。

| `type` | 说明 |
| --- | --- |
| `string` | 字符串。`multiline: true` 时界面用多行输入框 |
| `number` | 数字。可以用 `min`、`max` 限制范围，用 `step` 给步长 |
| `boolean` | 布尔值 |
| `select` | 固定选项。`options` 是 `{ value, label }` 数组，`default` 必须是其中一个 `value` |

每个参数都可以写 `default`。请求里没传这个参数时，宿主填上默认值；没有默认值的参数不会出现在 `params` 里。

数字参数接受数字，也接受能转成数字的字符串。布尔参数接受 `true`、`false`，也接受 `"true"`、`"false"`。越界的数字和不在选项里的值会让这次运行直接失败。

## 运行契约

一次运行收到两样东西：

```js
run(request, context) {
  request.inputs; // { [端口 id]: PortValue[] }
  request.params; // { [参数 id]: 值 }
}
```

`PortValue` 有三种形态：

```js
{ type: "text", text: "内容", html: null }   // html 可选
{ type: "link", url: "https://example.com" }
{ type: "image", mime: "image/png", data: Uint8Array, width: 800, height: 600 }
```

`width` 和 `height` 可选。图片数据是 `Uint8Array`，返回结果时宿主会转移它的缓冲区，插件之后不要再读写。

结果只有一个字段：

```js
return { outputs: { [端口 id]: PortValue[] } };
```

只能返回已声明的输出端口。没返回的输出端口按空处理。单值端口最多放一个值。

`run` 可以直接返回值，也可以返回 Promise。`context` 提供两项能力：

- `context.signal`：`AbortSignal`。用户取消或超时时触发。
- `context.log(message)`：写一行日志。当前版本只打到开发者控制台。

抛出的错误会让这次运行失败，错误信息会显示给用户。错误信息用中文写，写清楚哪一步不对。

一次运行默认超时 30 秒。超时后宿主终止这个插件的 Worker，把插件标记为错误，需要点设置页的“重新加载”才能恢复。

## 隔离模型

每个插件运行在独立 Worker 中：没有 DOM、没有 Tauri IPC，网络接口在加载前被移除；这不是针对恶意代码的强沙箱，只安装你信任的插件。

移除的接口包括 `fetch`、`XMLHttpRequest`、`WebSocket`、`EventSource`、`importScripts`、`indexedDB`、`caches`、`BroadcastChannel`、`Worker`、`SharedWorker`、`WebTransport`。

`eval` 和 `Function` 仍然可用，插件也能读到自己的源码。

## 版本管理

`apiVersion` 表示接口版本，当前是 `1`。宿主只加载 `apiVersion` 为 `1` 的插件。

以后有不兼容的改动时会提升版本号，旧插件会显示加载失败，错误信息里写明版本不符。新增可选字段不提升版本号。

## 渲染进程接口

应用内部通过 `renderer/src/plugins/plugin-host.ts` 使用这套接口：

```ts
const host = getPluginHost();
const statuses = await host.load(listing.plugins); // 每个插件一个 Worker
const descriptor = host.getProcessor("text-tools/uppercase");
const result = await host.run("text-tools/uppercase", request, { signal, timeoutMs });
host.dispose(); // 终止全部 Worker
```

`load` 会替换上一批插件并终止它们的 Worker。描述符在加载时校验，插件侧和宿主侧各校验一次。`run` 会先校验请求，收到结果后再校验一次。

当前版本只有设置页调用 `load`，应用里没有任何地方调用 `run`。
