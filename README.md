# 快捷图片画布

本项目是一个本地优先的桌面图片临时画布工具。

首期闭环：

> 悬浮窗 → 拖入或 Ctrl+V 粘贴 → 当前画布临时保留 → 点击图片快速分类 → 分类图片进入本地图片库

首期不包含服务器端和 SSH，图片数据保存在 Electron 的本地用户数据目录中。

## 开发

```powershell
npm install
npm run dev
```

## 构建与检查

```powershell
npm run typecheck
npm run build
```
