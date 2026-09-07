import { nativeImage } from "electron";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Windows PowerShell/WinForms is used instead of Electron's clipboard API here.
 * The WinForms DataObject can publish both the native FileDrop format and an
 * image at once, and SetDataObject(..., true) flushes the data so it survives
 * this helper process exiting.
 *
 * Electron nativeImage decodes the formats supported by Chromium (including
 * WebP), so the helper always receives a temporary PNG for the single-image
 * Bitmap path. The original paths are kept separately for FileDrop.
 */
const POWERSHELL_SCRIPT = String.raw`
$source = @'
using System;
using System.Collections.Specialized;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Windows.Forms;

public static class QuickImageBoardClipboard {
    private static Bitmap LoadBitmapPreservingAlpha(string path) {
        using (var source = Image.FromFile(path)) {
            var bitmap = new Bitmap(source.Width, source.Height, PixelFormat.Format32bppArgb);
            using (var graphics = Graphics.FromImage(bitmap)) {
                // SourceCopy keeps the source alpha channel instead of painting
                // transparent pixels onto an opaque background.
                graphics.CompositingMode = CompositingMode.SourceCopy;
                graphics.DrawImageUnscaled(source, 0, 0);
            }
            return bitmap;
        }
    }

    private static DataObject BuildDataObject(string[] paths) {
        var files = new StringCollection();
        files.AddRange(paths);
        var data = new DataObject();
        data.SetFileDropList(files);
        return data;
    }

    public static void SetFiles(string[] paths, string imagePath) {
        if (paths == null || paths.Length == 0) throw new ArgumentException("No files to copy");
        var data = BuildDataObject(paths);

        // A single image gets both Bitmap (decoded from a PNG by the caller) and
        // FileDrop (the original path). Multiple images intentionally stay
        // FileDrop-only so Explorer receives the complete selection.
        if (paths.Length == 1 && !String.IsNullOrWhiteSpace(imagePath)) {
            using (var bitmap = LoadBitmapPreservingAlpha(imagePath)) {
                data.SetData(DataFormats.Bitmap, true, bitmap);
                Clipboard.SetDataObject(data, true);
                return;
            }
        }

        Clipboard.SetDataObject(data, true);
    }
}
'@
Add-Type -AssemblyName System.Drawing -ErrorAction Stop
Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
Add-Type -TypeDefinition $source -ReferencedAssemblies @("System.Drawing", "System.Windows.Forms") -ErrorAction Stop
$encoded = $env:QUICK_IMAGE_BOARD_CLIPBOARD_PAYLOAD
if ([string]::IsNullOrWhiteSpace($encoded)) { throw "No clipboard payload supplied" }
$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
$payload = ConvertFrom-Json $json
[QuickImageBoardClipboard]::SetFiles([string[]]$payload.filePaths, [string]$payload.imagePath)
`;

export function createWindowsFileClipboardWriter() {
  return async (filePaths: string[]) => {
    if (process.platform !== "win32") throw new Error("Windows 文件剪贴板仅支持 Windows");
    if (filePaths.length === 0) throw new Error("没有可复制的文件");

    let temporaryDirectory: string | undefined;
    try {
      let imagePath: string | undefined;
      if (filePaths.length === 1) {
        const image = nativeImage.createFromPath(filePaths[0]);
        if (image.isEmpty()) throw new Error("无法解码要复制的图片");

        temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "quick-image-board-clipboard-"));
        imagePath = path.join(temporaryDirectory, "clipboard.png");
        await fs.writeFile(imagePath, image.toPNG(), { flag: "wx" });
      }

      const encoded = Buffer.from(JSON.stringify({ filePaths, imagePath }), "utf8").toString("base64");
      await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-Command", POWERSHELL_SCRIPT], {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, QUICK_IMAGE_BOARD_CLIPBOARD_PAYLOAD: encoded },
      });
    } catch (error) {
      const detail = error && typeof error === "object" && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : "";
      throw new Error(detail.trim() || (error instanceof Error ? error.message : "无法写入 Windows 文件剪贴板"));
    } finally {
      if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}
