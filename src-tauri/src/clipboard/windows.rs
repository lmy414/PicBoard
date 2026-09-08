//! Native Windows clipboard support (no Electron, no PowerShell helper).
//! Clipboard access is short-lived and synchronous inside a single Open/Close
//! pair on the calling thread.
//!
//! Reading handles `CF_DIBV5`, `CF_DIB`, `CF_BITMAP` and the registered "PNG"
//! format some producers publish. DIB parsing covers 1/4/8 bpp indexed,
//! 16/24/32 bpp direct color, bottom-up and top-down rows, and alpha from V4/V5
//! embedded masks or a BI_BITFIELDS fourth mask. Everything is re-encoded to
//! PNG so storage import is uniform with Electron's
//! `clipboard.readImage().toPNG()`.
//!
//! Writing publishes `CF_HDROP` (DROPFILES header + UTF-16 list, double NUL) for
//! every copy; a single image also publishes a 32bpp alpha-preserving
//! `CF_BITMAP` DIBSection. Both formats are staged in one clipboard ownership
//! window so publishing the second never clears the first.

use crate::error::AppError;
use image::codecs::png::PngEncoder;
use image::{ExtendedColorType, ImageEncoder};
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr;
use std::sync::OnceLock;
use windows_sys::core::PCWSTR;
use windows_sys::Win32::Foundation::{GlobalFree, HGLOBAL};
use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDIBits, GetObjectW,
    SelectObject, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_BITFIELDS, BI_RGB, DIB_RGB_COLORS,
};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    RegisterClipboardFormatW, SetClipboardData,
};
use windows_sys::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT,
};
use windows_sys::Win32::System::Ole::{CF_BITMAP, CF_DIB, CF_DIBV5, CF_HDROP};
use windows_sys::Win32::UI::Shell::DROPFILES;

const DROPFILES_HEADER: u32 = 20;
const MAX_RETRIES: u32 = 40;
/// Practical upper bound for one pasted bitmap (256M pixels ~ 1 GiB RGBA). A
/// corrupt header must not turn into a giant allocation.
const MAX_PIXELS: u64 = 256 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn align4(value: usize) -> usize {
    (value + 3) & !3
}

fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

fn read_i32(bytes: &[u8], offset: usize) -> i32 {
    i32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

fn read_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}

/// DIB header layouts we can decode without guessing, plus whether that
/// layout already carries channel masks inside the header.
#[derive(Debug, Clone, Copy)]
struct HeaderLayout {
    /// `true` when the header contains red/green/blue masks itself: that is
    /// BITMAPV4HEADER (108) and BITMAPV5HEADER (124).
    embedded_masks: bool,
}

impl HeaderLayout {
    /// Map a DIB header size to a known layout. Unknown sizes are rejected so
    /// we never mis-locate the pixel data.
    fn from_size(size: u32) -> Option<Self> {
        match size {
            12 | 40 | 52 | 56 | 64 | 108 | 124 => Some(Self {
                embedded_masks: size == 108 || size == 124,
            }),
            _ => None,
        }
    }
}

/// Convenience for parsing a little-endian value at a fixed header offset.

/// Byte range the `biSize` header claims, computed with checked arithmetic so
/// overflow cannot bypass length checks.
fn claimed_len(header_size: usize, extension: usize, pixel_len: usize) -> Result<usize, AppError> {
    header_size
        .checked_add(extension)
        .and_then(|v| v.checked_add(pixel_len))
        .ok_or_else(|| AppError::message("剪贴板 DIB 尺寸过大"))
}

/// Palette helper: entries of B,G,R,(reserved) or legacy B,G,R follow the
/// header. The returned entries are stored as [R,G,B].
fn read_palette(
    bytes: &[u8],
    offset: usize,
    count: usize,
    entry_size: usize,
) -> Result<Vec<[u8; 3]>, AppError> {
    let size = count
        .checked_mul(entry_size)
        .ok_or_else(|| AppError::message("剪贴板 DIB 尺寸过大"))?;
    let end = offset
        .checked_add(size)
        .ok_or_else(|| AppError::message("剪贴板 DIB 尺寸过大"))?;
    if end > bytes.len() {
        return Err(AppError::message("剪贴板 DIB 调色板不完整"));
    }
    let mut palette = Vec::with_capacity(count);
    for index in 0..count {
        let base = offset + index * entry_size;
        palette.push([bytes[base + 2], bytes[base + 1], bytes[base]]);
    }
    Ok(palette)
}

fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, AppError> {
    let mut output = Vec::new();
    PngEncoder::new(&mut output)
        .write_image(rgba, width, height, ExtendedColorType::Rgba8)
        .map_err(|error| AppError::message(format!("剪贴板图片编码 PNG 失败：{error}")))?;
    Ok(output)
}

/// Open the clipboard with a bounded retry loop, run `f` under the lock, then
/// close. Returns the error from `f` or an open failure.
fn with_clipboard<T>(f: impl FnOnce() -> Result<T, AppError>) -> Result<T, AppError> {
    unsafe {
        let mut opened = false;
        for _ in 0..MAX_RETRIES {
            if OpenClipboard(ptr::null_mut()) != 0 {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        if !opened {
            return Err(AppError::message(
                "无法打开系统剪贴板（可能被其他程序占用）",
            ));
        }
        let result = f();
        CloseClipboard();
        result
    }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// Registered clipboard format name many screenshot tools use to publish a
/// real PNG byte stream. It avoids lossy/odd DIB variants and can carry alpha
/// that plain CF_DIB cannot.
fn png_clipboard_format() -> u32 {
    static FORMAT: OnceLock<u32> = OnceLock::new();
    *FORMAT.get_or_init(|| {
        let wide: Vec<u16> = b"PNG\0".iter().map(|&byte| byte as u16).collect();
        unsafe { RegisterClipboardFormatW(wide.as_ptr() as PCWSTR) }
    })
}

/// Read an image from the clipboard and return PNG bytes.
/// `Ok(None)` means the clipboard holds no image we understand.
pub fn read_image_png() -> Result<Option<Vec<u8>>, AppError> {
    with_clipboard(|| unsafe {
        // Transparent/precise path first: some producers publish a real PNG.
        if let Some(png) = read_standard_png()? {
            return Ok(Some(png));
        }
        // Otherwise try DIB variants most specific first (V5 can carry alpha,
        // plain DIB next, legacy HBITMAP last). A present-but-undecodable
        // format must not hide the others, and when every present format fails
        // we surface a diagnostic instead of a silent "no image".
        let mut attempts = 0usize;
        let mut failed: Vec<String> = Vec::new();
        for (label, format) in [
            ("CF_DIBV5", CF_DIBV5 as u32),
            ("CF_DIB", CF_DIB as u32),
            ("CF_BITMAP", CF_BITMAP as u32),
        ] {
            if IsClipboardFormatAvailable(format) == 0 {
                continue;
            }
            attempts += 1;
            match read_format(format) {
                Ok(Some(png)) => return Ok(Some(png)),
                Ok(None) => {}
                Err(error) => failed.push(format!("{label}：{error}")),
            }
        }
        if attempts > 0 && !failed.is_empty() {
            return Err(AppError::message(format!(
                "剪贴板图片解码失败：{}",
                failed.join("；")
            )));
        }
        Ok(None)
    })
}

/// Decode one clipboard bitmap format (CF_DIBV5 / CF_DIB, or CF_BITMAP via
/// GDI). Returns `Ok(None)` when the clipboard has no data in that format.
unsafe fn read_format(format: u32) -> Result<Option<Vec<u8>>, AppError> {
    if format == CF_BITMAP as u32 {
        return read_bitmap();
    }
    let handle = GetClipboardData(format);
    if handle.is_null() {
        return Ok(None);
    }
    let handle = handle as HGLOBAL;
    let memory = GlobalLock(handle);
    if memory.is_null() {
        return Ok(None);
    }
    let size = GlobalSize(handle);
    let bytes = std::slice::from_raw_parts(memory as *const u8, size);
    let decoded = decode_dib_bytes(bytes);
    GlobalUnlock(handle);
    match decoded? {
        Some((rgba, width, height)) => Ok(Some(encode_png(&rgba, width, height)?)),
        None => Ok(None),
    }
}

/// Try the registered "PNG" clipboard format. `Ok(None)` when the clipboard
/// does not offer it; `Err` only for a genuine decode problem.
unsafe fn read_standard_png() -> Result<Option<Vec<u8>>, AppError> {
    let format = png_clipboard_format();
    if format == 0 || IsClipboardFormatAvailable(format) == 0 {
        return Ok(None);
    }
    let handle = GetClipboardData(format);
    if handle.is_null() {
        return Ok(None);
    }
    let handle = handle as HGLOBAL;
    let memory = GlobalLock(handle);
    if memory.is_null() {
        return Ok(None);
    }
    let size = GlobalSize(handle);
    let bytes = std::slice::from_raw_parts(memory as *const u8, size);
    let loaded = image::load_from_memory(bytes)
        .map_err(|error| AppError::message(format!("剪贴板 PNG 数据无效：{error}")));
    GlobalUnlock(handle);
    let image = loaded?;
    let rgba = image.to_rgba8();
    Ok(Some(encode_png(
        rgba.as_raw(),
        rgba.width(),
        rgba.height(),
    )?))
}

struct DibInfo {
    width: u32,
    height: u32,
    /// Positive height means rows are stored bottom-up (last row first).
    bottom_up: bool,
    bit_count: u16,
    compression: u32,
    red_mask: u32,
    green_mask: u32,
    blue_mask: u32,
    alpha_mask: u32,
    /// Offset of the first pixel row (after header, trailing masks and palette).
    data_offset: usize,
    /// Present for 1/4/8 bpp: `(palette offset in `bytes`, entry count, entry size)`.
    palette: Option<(usize, usize, usize)>,
    /// Number of whole rows available after `data_offset`.
    pixel_len: usize,
}

/// Parse a DIB byte buffer header. The header's own `biSize` field selects the
/// layout; that is the only trustworthy signal (CF_DIB may legally carry a
/// V5-sized header, so the old `dibv5` parameter was wrong).
fn parse_dib_header(bytes: &[u8]) -> Result<DibInfo, AppError> {
    if bytes.len() < 4 {
        return Err(AppError::message("剪贴板 DIB 数据不完整"));
    }
    let header_size = read_u32(bytes, 0) as usize;
    if header_size < 12 || header_size > bytes.len() {
        return Err(AppError::message("剪贴板 DIB 头无效"));
    }
    let layout = HeaderLayout::from_size(header_size as u32)
        .ok_or_else(|| AppError::message("剪贴板 DIB 头版本不支持"))?;

    let (width, height, bottom_up) = if header_size == 12 {
        // BITMAPCOREHEADER: unsigned 16-bit dimensions at offset 4/6.
        let width = read_u16(bytes, 4) as i32;
        let height = read_u16(bytes, 6) as i32;
        if width <= 0 || height <= 0 {
            return Err(AppError::message("剪贴板 DIB 尺寸无效"));
        }
        (width as u32, height as u32, true)
    } else {
        let raw_width = read_i32(bytes, 4);
        let raw_height = read_i32(bytes, 8);
        if raw_width <= 0 || raw_height == 0 {
            return Err(AppError::message("剪贴板 DIB 尺寸无效"));
        }
        let bottom_up = raw_height > 0;
        (raw_width as u32, raw_height.unsigned_abs(), bottom_up)
    };

    let bit_count: u16;
    let compression: u32;
    let colors_used: u32;
    if header_size == 12 {
        bit_count = read_u16(bytes, 10);
        compression = 0;
        colors_used = 0;
    } else {
        bit_count = read_u16(bytes, 14);
        compression = read_u32(bytes, 16);
        colors_used = if header_size >= 36 {
            read_u32(bytes, 32)
        } else {
            0
        };
    }
    if !matches!(bit_count, 1 | 4 | 8 | 16 | 24 | 32) {
        return Err(AppError::message(format!(
            "暂不支持的剪贴板位图格式（bpp={bit_count}）"
        )));
    }

    // Only BI_RGB and BI_BITFIELDS are decoded; RLE / JPEG / PNG-embedded and
    // other compressed variants get a clear error instead of a mis-decode.
    let masked = compression == BI_BITFIELDS;
    if !matches!(compression, BI_RGB | BI_BITFIELDS) {
        return Err(AppError::message(format!(
            "暂不支持的剪贴板位图压缩（压缩={compression}）"
        )));
    }

    // Mask layout per the Windows bitmap-header types documentation:
    //  * V4 (108) and V5 (124) embed masks inside the header at offsets 40..56.
    //  * V2/V3 (52/56) also carry them inline (read_bitmasks consumes a fourth
    //    alpha mask word for V3; V2 keeps 3 words with the last word zero).
    //  * The classic 40-byte BITMAPINFOHEADER stores only 3 masks *after* the
    //    header. Reading a fourth word there would treat the first pixel row as
    //    a mask, which is exactly the reported bug.
    // For indexed (1/4/8 bpp) rows BI_BITFIELDS is invalid: the trailing words
    // are skipped and rows are decoded as BI_RGB below.
    let mut red_mask = 0u32;
    let mut green_mask = 0u32;
    let mut blue_mask = 0u32;
    let mut alpha_mask = 0u32;
    let mut trailing = 0usize;
    if masked && matches!(bit_count, 16 | 24 | 32) {
        if layout.embedded_masks || header_size == 52 || header_size == 56 {
            if bytes.len() < 56 {
                return Err(AppError::message("剪贴板 DIB 头不完整"));
            }
            red_mask = read_u32(bytes, 40);
            green_mask = read_u32(bytes, 44);
            blue_mask = read_u32(bytes, 48);
            if header_size >= 56 {
                alpha_mask = read_u32(bytes, 52);
            }
        } else if header_size == 40 {
            // Classic BITMAPINFOHEADER: exactly three mask words follow the
            // header; pixel rows start after them. No fourth-word guessing.
            let end = header_size
                .checked_add(12)
                .ok_or_else(|| AppError::message("剪贴板位图掩码不完整"))?;
            if bytes.len() < end {
                return Err(AppError::message("剪贴板位图掩码不完整"));
            }
            red_mask = read_u32(bytes, 40);
            green_mask = read_u32(bytes, 44);
            blue_mask = read_u32(bytes, 48);
            trailing = 12;
        } else {
            return Err(AppError::message("剪贴板位图掩码布局不明确"));
        }
    }

    // Palette handling for 1/4/8 bpp. A truncated palette is a hard error (the
    // rows reference it); a palette size larger than 2^bpp is rejected.
    let mut palette: Option<(usize, usize, usize)> = None;
    if bit_count <= 8 {
        let capacity = 1usize << bit_count;
        let entries = if colors_used != 0 {
            colors_used as usize
        } else {
            capacity
        };
        if entries > capacity {
            return Err(AppError::message("剪贴板 DIB 调色板超出位深容量"));
        }
        let entry_size = if header_size == 12 { 3 } else { 4 };
        if entries > 0 {
            let palette_offset = header_size + trailing;
            let need = entries
                .checked_mul(entry_size)
                .and_then(|size| palette_offset.checked_add(size))
                .ok_or_else(|| AppError::message("剪贴板 DIB 尺寸过大"))?;
            if need > bytes.len() {
                return Err(AppError::message("剪贴板 DIB 调色板不完整"));
            }
            palette = Some((palette_offset, entries, entry_size));
        }
    }

    if masked {
        validate_bit_masks(red_mask, green_mask, blue_mask, alpha_mask, bit_count)?;
    }

    // Bounds-checked dimensions and allocation budget.
    let width_u = width as u64;
    let height_u = height as u64;
    if width_u == 0
        || height_u == 0
        || width_u
            .checked_mul(height_u)
            .map_or(true, |pixels| pixels > MAX_PIXELS)
    {
        return Err(AppError::message("剪贴板 DIB 尺寸过大"));
    }

    // Row math with checked arithmetic.
    let row_bits = width_u
        .checked_mul(bit_count as u64)
        .ok_or_else(|| AppError::message("剪贴板 DIB 尺寸过大"))?;
    let stride = align4(((row_bits + 7) / 8) as usize);
    let palette_bytes = palette
        .map(|(_, count, entry_size)| count * entry_size)
        .unwrap_or(0);
    let pixel_rows = stride
        .checked_mul(height as usize)
        .ok_or_else(|| AppError::message("剪贴板 DIB 尺寸过大"))?;
    let expected = claimed_len(header_size, trailing + palette_bytes, pixel_rows)?;
    if expected > bytes.len() {
        return Err(AppError::message("剪贴板 DIB 像素数据不完整"));
    }
    let pixel_len = bytes.len() - header_size - trailing - palette_bytes;

    Ok(DibInfo {
        width,
        height,
        bottom_up,
        bit_count,
        compression,
        red_mask,
        green_mask,
        blue_mask,
        alpha_mask,
        data_offset: header_size + trailing + palette_bytes,
        palette,
        pixel_len,
    })
}

fn validate_bit_masks(
    red: u32,
    green: u32,
    blue: u32,
    alpha: u32,
    bit_count: u16,
) -> Result<(), AppError> {
    if red == 0 || green == 0 || blue == 0 {
        return Err(AppError::message("剪贴板 DIB RGB 掩码必须非零"));
    }
    let allowed = match bit_count {
        16 => 0x0000_ffff,
        24 => 0x00ff_ffff,
        32 => u32::MAX,
        _ => return Err(AppError::message("剪贴板 DIB 掩码位宽无效")),
    };
    if (red | green | blue | alpha) & !allowed != 0 {
        return Err(AppError::message("剪贴板 DIB 掩码超出像素位宽"));
    }
    let masks = [red, green, blue, alpha];
    for (index, mask) in masks.iter().enumerate() {
        if *mask == 0 && index == 3 {
            continue;
        }
        let shifted = *mask >> mask.trailing_zeros();
        if shifted == 0 || (shifted & shifted.wrapping_add(1)) != 0 {
            return Err(AppError::message("剪贴板 DIB 掩码必须是连续位域"));
        }
    }
    if (red & green) != 0
        || (red & blue) != 0
        || (green & blue) != 0
        || (alpha != 0 && ((alpha & red) != 0 || (alpha & green) != 0 || (alpha & blue) != 0))
    {
        return Err(AppError::message("剪贴板 DIB 掩码不能重叠"));
    }
    let bits = [red, green, blue, alpha];
    for mask in bits {
        if mask != 0 {
            let shift = mask.trailing_zeros();
            let width = mask.count_ones();
            if shift + width > bit_count as u32 {
                return Err(AppError::message("剪贴板 DIB 掩码超出像素位宽"));
            }
        }
    }
    Ok(())
}

/// Normalize a raw masked channel into 0..255 without u8 overflow: a 5-bit
/// channel (max 31) times 255 exceeds u8, so scaling runs in u64.
fn scaled_channel(channel: u32, bits: u8) -> u8 {
    if bits == 0 {
        return 0;
    }
    if bits >= 8 {
        return (channel >> (bits - 8)) as u8;
    }
    let max = (1u32 << bits) - 1;
    ((channel as u64 * 255 + max as u64 / 2) / max as u64) as u8
}

/// Decode DIB bytes into top-down RGBA pixels plus dimensions.
fn decode_dib_bytes(bytes: &[u8]) -> Result<Option<(Vec<u8>, u32, u32)>, AppError> {
    let info = parse_dib_header(bytes)?;
    let bits = info.bit_count as usize;
    let row_count = info.height as usize;
    if row_count == 0 {
        return Ok(None);
    }
    // Packed rows: pixel bits per row rounded up to bytes then to 4.
    let row_bits = (info.width as u64)
        .checked_mul(info.bit_count as u64)
        .ok_or_else(|| AppError::message("剪贴板 DIB 尺寸过大"))?;
    let stride = align4((row_bits as usize + 7) / 8);
    let needed = stride
        .checked_mul(row_count)
        .ok_or_else(|| AppError::message("剪贴板 DIB 尺寸过大"))?;
    if needed > info.pixel_len {
        return Err(AppError::message("剪贴板 DIB 像素数据不完整"));
    }

    let pixel_count = (info.width as usize)
        .checked_mul(row_count)
        .ok_or_else(|| AppError::message("剪贴板 DIB 尺寸过大"))?;
    let rgba_len = pixel_count
        .checked_mul(4)
        .ok_or_else(|| AppError::message("剪贴板 DIB 尺寸过大"))?;
    let mut rgba = vec![0u8; rgba_len];

    let palette = match info.palette {
        Some((offset, count, entry_size)) => Some(read_palette(bytes, offset, count, entry_size)?),
        None => None,
    };

    let direct = bits >= 16; // 16/24/32 bpp, one little-endian word per pixel
    let bytes_per_pixel = bits / 8;
    for y in 0..row_count {
        let src_y = if info.bottom_up { row_count - 1 - y } else { y };
        let row_start = info.data_offset + src_y * stride;
        let row = &bytes[row_start..row_start + stride];
        let dest = &mut rgba[y * pixel_count / row_count * 4..][..info.width as usize * 4];
        if direct {
            for x in 0..info.width as usize {
                let src = &row[x * bytes_per_pixel..x * bytes_per_pixel + bytes_per_pixel];
                let pixel = direct_pixel(src, &info)?;
                dest[x * 4..x * 4 + 4].copy_from_slice(&pixel);
            }
        } else if let Some(palette) = &palette {
            // Packed bit index inside each row.
            for x in 0..info.width as usize {
                let bit_index = x * bits;
                let byte_index = bit_index / 8;
                let value = match bits {
                    8 => row[byte_index],
                    4 => (row[byte_index] >> (4 - (bit_index % 8))) & 0x0f,
                    1 => (row[byte_index] >> (7 - (bit_index % 8))) & 0x01,
                    _ => unreachable!(),
                };
                let rgb = palette
                    .get(value as usize)
                    .ok_or_else(|| AppError::message("剪贴板 DIB 像素索引超出调色板范围"))?;
                dest[x * 4..x * 4 + 4].copy_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
            }
        } else {
            return Err(AppError::message("剪贴板 DIB 缺少调色板"));
        }
    }
    Ok(Some((rgba, info.width, info.height)))
}

fn direct_pixel(src: &[u8], info: &DibInfo) -> Result<[u8; 4], AppError> {
    let (channel_r, channel_g, channel_b): (u32, u32, u32);
    let (bits_r, bits_g, bits_b): (u8, u8, u8);
    match (info.compression, info.bit_count) {
        (0, 24) => return Ok([src[2], src[1], src[0], 255]),
        (0, 32) => return Ok([src[2], src[1], src[0], 255]),
        (0, 16) => {
            let value = u16::from_le_bytes([src[0], src[1]]) as u32;
            channel_r = (value >> 10) & 0x1f;
            channel_g = (value >> 5) & 0x1f;
            channel_b = value & 0x1f;
            bits_r = 5;
            bits_g = 5;
            bits_b = 5;
        }
        (3, 16) | (3, 24) | (3, 32) => {
            let value = raw_pixel_value(src, info)?;
            channel_r = (value & info.red_mask) >> info.red_mask.trailing_zeros();
            channel_g = (value & info.green_mask) >> info.green_mask.trailing_zeros();
            channel_b = (value & info.blue_mask) >> info.blue_mask.trailing_zeros();
            bits_r = (info.red_mask >> info.red_mask.trailing_zeros()).count_ones() as u8;
            bits_g = (info.green_mask >> info.green_mask.trailing_zeros()).count_ones() as u8;
            bits_b = (info.blue_mask >> info.blue_mask.trailing_zeros()).count_ones() as u8;
        }
        _ => {
            return Err(AppError::message(format!(
                "暂不支持的剪贴板位图格式（bpp={}，压缩={}）",
                info.bit_count, info.compression
            )))
        }
    }
    let alpha = if info.alpha_mask != 0 {
        let value = raw_pixel_value(src, info)?;
        let shift = info.alpha_mask.trailing_zeros();
        let bits = (info.alpha_mask >> shift).count_ones() as u8;
        scaled_channel((value & info.alpha_mask) >> shift, bits)
    } else {
        255
    };
    Ok([
        scaled_channel(channel_r, bits_r),
        scaled_channel(channel_g, bits_g),
        scaled_channel(channel_b, bits_b),
        alpha,
    ])
}

/// Read the raw little-endian pixel word sized to the bit depth. Direct
/// 16/24/32 bpp rows start on byte boundaries so this cannot read past `src`.
fn raw_pixel_value(src: &[u8], info: &DibInfo) -> Result<u32, AppError> {
    match info.bit_count {
        16 => Ok(u16::from_le_bytes([src[0], src[1]]) as u32),
        24 => Ok(u32::from_le_bytes([src[0], src[1], src[2], 0])),
        32 => Ok(u32::from_le_bytes([src[0], src[1], src[2], src[3]])),
        _ => Err(AppError::message("剪贴板位图内部错误")),
    }
}

/// CF_BITMAP is an HBITMAP (GDI object). Read pixels with GetDIBits into a
/// top-down 32bpp buffer. HBITMAP has no alpha; force opaque.
unsafe fn read_bitmap() -> Result<Option<Vec<u8>>, AppError> {
    let handle = GetClipboardData(CF_BITMAP as u32);
    if handle.is_null() {
        return Ok(None);
    }
    let mut bitmap: BITMAP = std::mem::zeroed();
    if GetObjectW(
        handle,
        core::mem::size_of::<BITMAP>() as i32,
        &mut bitmap as *mut BITMAP as *mut core::ffi::c_void,
    ) == 0
    {
        return Err(AppError::message("无法读取剪贴板位图信息"));
    }
    let width = bitmap.bmWidth as u32;
    let height = bitmap.bmHeight.unsigned_abs();
    if width == 0 || height == 0 {
        return Ok(None);
    }
    let pixel_count = (width as u64) * (height as u64);
    if pixel_count > MAX_PIXELS {
        return Err(AppError::message("剪贴板 DIB 尺寸过大"));
    }

    let dc = CreateCompatibleDC(ptr::null_mut());
    if dc.is_null() {
        return Err(AppError::message("无法创建位图内存上下文"));
    }
    let old = SelectObject(dc, handle);
    let mut header: BITMAPINFOHEADER = std::mem::zeroed();
    header.biSize = core::mem::size_of::<BITMAPINFOHEADER>() as u32;
    header.biWidth = width as i32;
    header.biHeight = -(height as i32);
    header.biPlanes = 1;
    header.biBitCount = 32;
    header.biCompression = BI_RGB;
    let row_size = align4(width as usize * 4);
    let mut pixels = vec![0u8; row_size * height as usize];
    let mut info: BITMAPINFO = std::mem::zeroed();
    info.bmiHeader = header;
    let lines = GetDIBits(
        dc,
        handle,
        0,
        height,
        pixels.as_mut_ptr() as *mut core::ffi::c_void,
        &mut info,
        DIB_RGB_COLORS,
    );
    // Restore the previous object before releasing the DC, then release the
    // DC even when GetDIBits failed so no GDI handle leaks.
    if !old.is_null() {
        SelectObject(dc, old);
    }
    DeleteDC(dc);
    if lines as u32 != height {
        return Err(AppError::message(format!(
            "无法读取剪贴板位图像素（{lines}/{} 行）",
            height
        )));
    }

    let mut rgba = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height as usize {
        let row = &pixels[y * row_size..];
        for x in 0..width as usize {
            let p = &row[x * 4..];
            rgba.extend_from_slice(&[p[2], p[1], p[0], 255]);
        }
    }
    Ok(Some(encode_png(&rgba, width, height)?))
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/// Publish absolute image file paths. Empty input is a no-op. A single path
/// additionally publishes decoded pixels as CF_BITMAP.
pub fn write_image_files(paths: &[std::path::PathBuf]) -> Result<(), AppError> {
    if paths.is_empty() {
        return Ok(());
    }
    with_clipboard(|| unsafe {
        EmptyClipboard();
        let drop_handle = build_dropfiles(paths)?;
        if SetClipboardData(CF_HDROP as u32, drop_handle as *mut core::ffi::c_void).is_null() {
            let _ = GlobalFree(drop_handle);
            return Err(AppError::message("无法写入文件剪贴板（CF_HDROP）"));
        }
        if paths.len() == 1 {
            match build_bitmap(&paths[0]) {
                Ok(Some(bitmap)) => {
                    if SetClipboardData(CF_BITMAP as u32, bitmap as *mut core::ffi::c_void)
                        .is_null()
                    {
                        // The file list already succeeded; dropping the pixel
                        // format must not fail the whole copy.
                        DeleteObject(bitmap);
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    // File list succeeded but the pixel decode failed. Report the
                    // decode problem because the user explicitly copied an image.
                    return Err(error);
                }
            }
        }
        Ok(())
    })
}

fn build_dropfiles(paths: &[std::path::PathBuf]) -> Result<HGLOBAL, AppError> {
    let mut wide: Vec<u16> = Vec::new();
    for path in paths {
        let normalized = path.to_string_lossy().replace('/', "\\");
        for unit in OsStr::new(&normalized).encode_wide() {
            wide.push(unit);
        }
        wide.push(0);
    }
    wide.push(0); // double NUL terminates the whole list
    let payload = wide.len() * 2;
    unsafe {
        let handle = GlobalAlloc(
            GMEM_MOVEABLE | GMEM_ZEROINIT,
            DROPFILES_HEADER as usize + payload,
        );
        if handle.is_null() {
            return Err(AppError::message("无法分配文件剪贴板内存"));
        }
        let memory = GlobalLock(handle) as *mut u8;
        if memory.is_null() {
            let _ = GlobalFree(handle);
            return Err(AppError::message("无法锁定文件剪贴板内存"));
        }
        let header = DROPFILES {
            pFiles: DROPFILES_HEADER,
            pt: std::mem::zeroed(),
            fNC: 0,
            fWide: 1,
        };
        ptr::copy_nonoverlapping(
            &header as *const DROPFILES as *const u8,
            memory,
            DROPFILES_HEADER as usize,
        );
        ptr::copy_nonoverlapping(
            wide.as_ptr() as *const u8,
            memory.add(DROPFILES_HEADER as usize),
            payload,
        );
        GlobalUnlock(handle);
        Ok(handle)
    }
}

fn checked_image_byte_len(width: u32, height: u32) -> Option<usize> {
    (width as u64)
        .checked_mul(height as u64)
        .and_then(|pixels| pixels.checked_mul(4))
        .and_then(|bytes| usize::try_from(bytes).ok())
}

fn validate_bitmap_dimensions(width: u32, height: u32) -> Result<usize, AppError> {
    if width == 0 || height == 0 {
        return Ok(0);
    }
    let pixels = (width as u64)
        .checked_mul(height as u64)
        .ok_or_else(|| AppError::message("要复制的图片尺寸过大"))?;
    if pixels > MAX_PIXELS {
        return Err(AppError::message("要复制的图片尺寸过大"));
    }
    checked_image_byte_len(width, height).ok_or_else(|| AppError::message("要复制的图片尺寸过大"))
}

/// Decode an image file and create a top-down 32bpp DIBSection whose memory the
/// clipboard owns once SetClipboardData succeeds.
fn build_bitmap(path: &Path) -> Result<Option<*mut core::ffi::c_void>, AppError> {
    let bytes = std::fs::read(path)?;
    let reader = image::ImageReader::new(std::io::Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|error| AppError::message(format!("无法识别要复制的图片：{error}")))?;
    let (source_width, source_height) = reader
        .into_dimensions()
        .map_err(|error| AppError::message(format!("无法读取要复制的图片尺寸：{error}")))?;
    if validate_bitmap_dimensions(source_width, source_height)? == 0 {
        return Ok(None);
    }
    let image = image::load_from_memory(&bytes)
        .map_err(|error| AppError::message(format!("无法解码要复制的图片：{error}")))?;
    let width = image.width();
    let height = image.height();
    let target_len = validate_bitmap_dimensions(width, height)?;
    if target_len == 0 {
        return Ok(None);
    }
    let rgba = image.to_rgba8();
    let width = rgba.width();
    let height = rgba.height();
    let mut header: BITMAPINFOHEADER;
    let mut info: BITMAPINFO;
    let dc;
    let bitmap;
    unsafe {
        header = std::mem::zeroed();
        header.biSize = core::mem::size_of::<BITMAPINFOHEADER>() as u32;
        header.biWidth = width as i32;
        header.biHeight = -(height as i32);
        header.biPlanes = 1;
        header.biBitCount = 32;
        header.biCompression = BI_RGB;
        info = std::mem::zeroed();
        info.bmiHeader = header;

        dc = CreateCompatibleDC(ptr::null_mut());
        let mut bits: *mut core::ffi::c_void = ptr::null_mut();
        bitmap = CreateDIBSection(
            dc,
            &info as *const BITMAPINFO,
            DIB_RGB_COLORS,
            &mut bits,
            ptr::null_mut(),
            0,
        );
        if !dc.is_null() {
            DeleteDC(dc);
        }
        if bitmap.is_null() || bits.is_null() {
            if !bitmap.is_null() {
                DeleteObject(bitmap);
            }
            return Err(AppError::message("无法创建剪贴板位图"));
        }
        let target = std::slice::from_raw_parts_mut(bits as *mut u8, target_len);
        for (index, pixel) in rgba.pixels().enumerate() {
            let offset = index * 4;
            target[offset] = pixel[2]; // B
            target[offset + 1] = pixel[1]; // G
            target[offset + 2] = pixel[0]; // R
            target[offset + 3] = pixel[3]; // A
        }
    }
    Ok(Some(bitmap as *mut core::ffi::c_void))
}

// ---------------------------------------------------------------------------
// In-memory DIB regression tests (no system clipboard, no GDI)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Classic 40-byte BITMAPINFOHEADER, BI_RGB, bottom-up.
    fn header40(width: i32, height: i32, bpp: u16) -> Vec<u8> {
        let mut h = vec![0u8; 40];
        h[0..4].copy_from_slice(&40u32.to_le_bytes());
        h[4..8].copy_from_slice(&width.to_le_bytes());
        h[8..12].copy_from_slice(&height.to_le_bytes());
        h[12..14].copy_from_slice(&1u16.to_le_bytes());
        h[14..16].copy_from_slice(&bpp.to_le_bytes());
        h
    }

    /// DIB pixels are stored BGRA (little-endian words B,G,R,A). This helper
    /// converts an RGBA8 pixel into its on-disk BGRA bytes.
    fn bgra(r: u8, g: u8, b: u8, a: u8) -> [u8; 4] {
        [b, g, r, a]
    }

    #[test]
    fn checked_image_byte_len_rejects_multiplication_overflow() {
        assert_eq!(checked_image_byte_len(1, 1), Some(4));
        assert_eq!(checked_image_byte_len(u32::MAX, 0), Some(0));
        assert_eq!(checked_image_byte_len(u32::MAX, u32::MAX), None);
    }

    #[test]
    fn dib_v5_bitfields_uses_inline_masks_and_alpha() {
        // V5 header (124 bytes) with premultiplied BGRA8 masks. The alpha mask
        // is embedded at 52..56, so pixel rows start at 124, not 136.
        let width = 2u32;
        let height = 2u32;
        let mut dib = vec![0u8; 124];
        dib[0..4].copy_from_slice(&124u32.to_le_bytes());
        dib[4..8].copy_from_slice(&(width as i32).to_le_bytes());
        dib[8..12].copy_from_slice(&(height as i32).to_le_bytes());
        dib[12..14].copy_from_slice(&1u16.to_le_bytes());
        dib[14..16].copy_from_slice(&32u16.to_le_bytes());
        dib[16..20].copy_from_slice(&BI_BITFIELDS.to_le_bytes());
        dib[40..44].copy_from_slice(&0x00ff0000u32.to_le_bytes()); // R
        dib[44..48].copy_from_slice(&0x0000ff00u32.to_le_bytes()); // G
        dib[48..52].copy_from_slice(&0x000000ffu32.to_le_bytes()); // B
        dib[52..56].copy_from_slice(&0xff000000u32.to_le_bytes()); // A

        // Bottom-up: the first stored row is the *last* image row.
        let row0 = [bgra(0, 255, 0, 64), bgra(0, 0, 0, 0)]; // image row y=0
        let row1 = [bgra(255, 0, 0, 128), bgra(10, 20, 30, 200)]; // image row y=1
        for pixel in row1 {
            dib.extend_from_slice(&pixel);
        }
        for pixel in row0 {
            dib.extend_from_slice(&pixel);
        }

        let (rgba, w, h) = decode_dib_bytes(&dib).unwrap().unwrap();
        assert_eq!((w, h), (width, height));
        assert_eq!(&rgba[0..4], &[0, 255, 0, 64]);
        assert_eq!(&rgba[4..8], &[0, 0, 0, 0]);
        assert_eq!(&rgba[8..12], &[255, 0, 0, 128]);
        assert_eq!(&rgba[12..16], &[10, 20, 30, 200]);
    }

    #[test]
    fn dib_40_byte_bitfields_three_masks_do_not_swallow_first_pixel() {
        // 40-byte BITMAPINFOHEADER + BI_BITFIELDS: exactly three mask words
        // follow the header; the first pixel row must start at 52. The old code
        // read a fourth (alpha) word from the first pixel and mis-shifted.
        let width = 2u32;
        let height = 1u32;
        let mut dib = header40(width as i32, height as i32, 16);
        dib[16..20].copy_from_slice(&BI_BITFIELDS.to_le_bytes());
        dib.extend_from_slice(&0x7c00u32.to_le_bytes()); // R mask
        dib.extend_from_slice(&0x03e0u32.to_le_bytes()); // G mask
        dib.extend_from_slice(&0x001fu32.to_le_bytes()); // B mask
                                                         // One row of two 5:5:5 pixels; row stride = align4(2*2) = 4 bytes.
        dib.extend_from_slice(&0x7fffu16.to_le_bytes()); // 31,31,31 -> white
        dib.extend_from_slice(&0x0000u16.to_le_bytes()); // 0,0,0 -> black

        let (rgba, w, h) = decode_dib_bytes(&dib).unwrap().unwrap();
        assert_eq!((w, h), (width, height));
        assert_eq!(&rgba[0..4], &[255, 255, 255, 255]);
        assert_eq!(&rgba[4..8], &[0, 0, 0, 255]);
    }

    #[test]
    fn dib_16bit_rgb_scales_without_u8_overflow() {
        // 16-bit BI_RGB 5:5:5, width 1 => row stride align4(2) = 4 bytes, so the
        // row payload needs two padding bytes after the two data bytes.
        // The old `(x as u8) * 255 / 31` overflowed u8 and yielded 7, not 255.
        let width = 1u32;
        let height = 1u32;
        let mut dib = header40(width as i32, height as i32, 16);
        dib.extend_from_slice(&0x7fffu16.to_le_bytes());
        dib.extend_from_slice(&[0, 0]); // row padding

        let (rgba, w, h) = decode_dib_bytes(&dib).unwrap().unwrap();
        assert_eq!((w, h), (width, height));
        assert_eq!(&rgba[0..4], &[255, 255, 255, 255]);
    }

    #[test]
    fn dib_indexed_palette_and_packed_stride() {
        // 8bpp indexed: header(40) + palette(2 entries x 4B) then rows. Rows
        // start at 48, after the palette (the old code decoded palette bytes as
        // pixels). Stride for 3 pixels = align4(3) = 4 bytes.
        let width = 3u32;
        let height = 1u32;
        let mut dib = header40(width as i32, height as i32, 8);
        dib[32..36].copy_from_slice(&2u32.to_le_bytes()); // biClrUsed
        dib.extend_from_slice(&[0, 0, 0, 0]); // palette[0] = black (B,G,R,X)
        dib.extend_from_slice(&[255, 255, 255, 0]); // palette[1] = white
        dib.extend_from_slice(&[0, 1, 0]); // row: black, white, black
        dib.push(0); // pad to 4 bytes

        let (rgba, w, h) = decode_dib_bytes(&dib).unwrap().unwrap();
        assert_eq!((w, h), (width, height));
        assert_eq!(&rgba[0..4], &[0, 0, 0, 255]);
        assert_eq!(&rgba[4..8], &[255, 255, 255, 255]);
        assert_eq!(&rgba[8..12], &[0, 0, 0, 255]);
    }

    #[test]
    fn dib_1bpp_decodes_packed_palette_indices() {
        let mut dib = header40(8, 1, 1);
        dib.extend_from_slice(&[0, 0, 255, 0]); // palette[0] = red
        dib.extend_from_slice(&[255, 0, 0, 0]); // palette[1] = blue
        dib.extend_from_slice(&[0b1010_0101, 0, 0, 0]);

        let (rgba, width, height) = decode_dib_bytes(&dib).unwrap().unwrap();
        assert_eq!((width, height), (8, 1));
        for (index, expected) in [
            [0, 0, 255, 255],
            [255, 0, 0, 255],
            [0, 0, 255, 255],
            [255, 0, 0, 255],
            [255, 0, 0, 255],
            [0, 0, 255, 255],
            [255, 0, 0, 255],
            [0, 0, 255, 255],
        ]
        .into_iter()
        .enumerate()
        {
            assert_eq!(&rgba[index * 4..index * 4 + 4], &expected);
        }
    }

    #[test]
    fn dib_4bpp_decodes_packed_palette_indices() {
        let mut dib = header40(4, 1, 4);
        for index in 0..16u8 {
            dib.extend_from_slice(&[index, index.wrapping_add(1), index.wrapping_add(2), 0]);
        }
        dib.extend_from_slice(&[0x1f, 0x30, 0, 0]); // indices 1, 15, 3, 0

        let (rgba, width, height) = decode_dib_bytes(&dib).unwrap().unwrap();
        assert_eq!((width, height), (4, 1));
        for (index, palette_index) in [1u8, 15, 3, 0].into_iter().enumerate() {
            let expected = [palette_index + 2, palette_index + 1, palette_index, 255];
            assert_eq!(&rgba[index * 4..index * 4 + 4], &expected);
        }
    }

    #[test]
    fn dib_indexed_palette_rejects_colors_used_above_bpp_capacity() {
        let mut dib = header40(1, 1, 1);
        dib[32..36].copy_from_slice(&3u32.to_le_bytes());
        dib.extend_from_slice(&[0, 0, 0, 0]);
        dib.extend_from_slice(&[255, 255, 255, 0]);
        dib.extend_from_slice(&[0, 0, 0, 0]);
        dib.extend_from_slice(&[0, 0, 0, 0]);
        dib.extend_from_slice(&[0, 0, 0, 0]);

        let error = decode_dib_bytes(&dib).unwrap_err();
        assert!(format!("{error}").contains("调色板"), "{error}");
    }

    #[test]
    fn dib_24bpp_bitfields_decodes_three_byte_pixels() {
        let mut dib = header40(1, 1, 24);
        dib[16..20].copy_from_slice(&BI_BITFIELDS.to_le_bytes());
        dib.extend_from_slice(&0x00ff0000u32.to_le_bytes());
        dib.extend_from_slice(&0x0000ff00u32.to_le_bytes());
        dib.extend_from_slice(&0x000000ffu32.to_le_bytes());
        dib.extend_from_slice(&[30, 20, 10, 0]); // B, G, R, row padding

        let (rgba, width, height) = decode_dib_bytes(&dib).unwrap().unwrap();
        assert_eq!((width, height), (1, 1));
        assert_eq!(&rgba[0..4], &[10, 20, 30, 255]);
    }

    #[test]
    fn dib_header_dimensions_above_pixel_budget_are_rejected() {
        let dib = header40((MAX_PIXELS + 1) as i32, 1, 24);
        let error = decode_dib_bytes(&dib).unwrap_err();
        assert!(format!("{error}").contains("尺寸"), "{error}");
    }

    #[test]
    fn dib_core_header_decodes_three_byte_palette_entries() {
        let mut dib = vec![0u8; 12];
        dib[0..4].copy_from_slice(&12u32.to_le_bytes());
        dib[4..6].copy_from_slice(&2u16.to_le_bytes());
        dib[6..8].copy_from_slice(&1u16.to_le_bytes());
        dib[8..10].copy_from_slice(&1u16.to_le_bytes());
        dib[10..12].copy_from_slice(&1u16.to_le_bytes());
        dib.extend_from_slice(&[0, 0, 255]); // palette[0] = red (B, G, R)
        dib.extend_from_slice(&[255, 0, 0]); // palette[1] = blue (B, G, R)
        dib.extend_from_slice(&[0b0100_0000, 0, 0, 0]); // red, blue

        let (rgba, width, height) = decode_dib_bytes(&dib).unwrap().unwrap();
        assert_eq!((width, height), (2, 1));
        assert_eq!(&rgba[0..4], &[255, 0, 0, 255]);
        assert_eq!(&rgba[4..8], &[0, 0, 255, 255]);
    }

    #[test]
    fn dib_bitfields_zero_rgb_mask_is_rejected() {
        let mut dib = header40(1, 1, 16);
        dib[16..20].copy_from_slice(&BI_BITFIELDS.to_le_bytes());
        dib.extend_from_slice(&0u32.to_le_bytes());
        dib.extend_from_slice(&0x03e0u32.to_le_bytes());
        dib.extend_from_slice(&0x001fu32.to_le_bytes());
        dib.extend_from_slice(&[0, 0, 0, 0]);

        let error = decode_dib_bytes(&dib).unwrap_err();
        assert!(format!("{error}").contains("掩码"), "{error}");
    }

    #[test]
    fn dib_bitfields_overlapping_rgb_masks_are_rejected() {
        let mut dib = header40(1, 1, 16);
        dib[16..20].copy_from_slice(&BI_BITFIELDS.to_le_bytes());
        dib.extend_from_slice(&0x7c00u32.to_le_bytes());
        dib.extend_from_slice(&0x7c00u32.to_le_bytes());
        dib.extend_from_slice(&0x001fu32.to_le_bytes());
        dib.extend_from_slice(&[0, 0, 0, 0]);

        let error = decode_dib_bytes(&dib).unwrap_err();
        assert!(format!("{error}").contains("掩码"), "{error}");
    }

    #[test]
    fn dib_bitfields_non_contiguous_mask_is_rejected() {
        let mut dib = header40(1, 1, 16);
        dib[16..20].copy_from_slice(&BI_BITFIELDS.to_le_bytes());
        dib.extend_from_slice(&0x5400u32.to_le_bytes());
        dib.extend_from_slice(&0x03e0u32.to_le_bytes());
        dib.extend_from_slice(&0x001fu32.to_le_bytes());
        dib.extend_from_slice(&[0, 0, 0, 0]);

        let error = decode_dib_bytes(&dib).unwrap_err();
        assert!(format!("{error}").contains("掩码"), "{error}");
    }

    #[test]
    fn dib_bitfields_channels_scale_using_their_own_widths() {
        let mut dib = header40(1, 1, 16);
        dib[16..20].copy_from_slice(&BI_BITFIELDS.to_le_bytes());
        dib.extend_from_slice(&0xf800u32.to_le_bytes());
        dib.extend_from_slice(&0x07e0u32.to_le_bytes());
        dib.extend_from_slice(&0x001fu32.to_le_bytes());
        dib.extend_from_slice(&0xffffu16.to_le_bytes());
        dib.extend_from_slice(&[0, 0]);

        let (rgba, _, _) = decode_dib_bytes(&dib).unwrap().unwrap();
        assert_eq!(&rgba[0..4], &[255, 255, 255, 255]);
    }

    #[test]
    fn dib_indexed_palette_value_out_of_range_is_rejected() {
        let mut dib = header40(1, 1, 8);
        dib[32..36].copy_from_slice(&2u32.to_le_bytes());
        dib.extend_from_slice(&[0, 0, 0, 0]);
        dib.extend_from_slice(&[255, 255, 255, 0]);
        dib.extend_from_slice(&[2, 0, 0, 0]);

        let error = decode_dib_bytes(&dib).unwrap_err();
        assert!(format!("{error}").contains("调色板"), "{error}");
    }

    #[test]
    fn bitmap_copy_rejects_dimensions_over_allocation_budget() {
        assert!(validate_bitmap_dimensions(1, 1).is_ok());
        assert!(validate_bitmap_dimensions(u32::MAX, u32::MAX).is_err());
        assert!(validate_bitmap_dimensions((MAX_PIXELS + 1) as u32, 1).is_err());
    }

    #[test]
    fn checked_image_byte_len_handles_pixel_and_byte_boundaries() {
        assert_eq!(checked_image_byte_len(1, 1), Some(4));
        assert_eq!(checked_image_byte_len(u32::MAX, 0), Some(0));
        assert_eq!(checked_image_byte_len(u32::MAX, u32::MAX), None);
    }

    #[test]
    fn dib_truncated_pixels_are_rejected() {
        // Header claims one 24-bit row (stride align4(9) = 12 bytes) but the
        // buffer only carries three bytes.
        let width = 3i32;
        let mut dib = header40(width, 1, 24);
        dib.extend_from_slice(&[0, 0, 0]); // only 3 of the 12 row bytes
        let error = decode_dib_bytes(&dib).unwrap_err();
        assert!(format!("{error}").contains("不完整"), "{error}");
    }

    #[test]
    fn dib_v4_top_down_rows_are_not_flipped() {
        // V4 header (108 bytes) with embedded masks and a negative height:
        // rows are stored top-down, so stored order equals image order.
        let width = 1u32;
        let height = 2u32;
        let mut dib = vec![0u8; 108];
        dib[0..4].copy_from_slice(&108u32.to_le_bytes());
        dib[4..8].copy_from_slice(&(width as i32).to_le_bytes());
        dib[8..12].copy_from_slice(&(-(height as i32)).to_le_bytes());
        dib[12..14].copy_from_slice(&1u16.to_le_bytes());
        dib[14..16].copy_from_slice(&32u16.to_le_bytes());
        dib[16..20].copy_from_slice(&BI_BITFIELDS.to_le_bytes());
        dib[40..44].copy_from_slice(&0x00ff0000u32.to_le_bytes()); // R
        dib[44..48].copy_from_slice(&0x0000ff00u32.to_le_bytes()); // G
        dib[48..52].copy_from_slice(&0x000000ffu32.to_le_bytes()); // B
        dib[52..56].copy_from_slice(&0xff000000u32.to_le_bytes()); // A
        dib.extend_from_slice(&bgra(255, 0, 0, 255)); // image row 0 (stored first)
        dib.extend_from_slice(&bgra(0, 255, 0, 255)); // image row 1 (stored second)

        let (rgba, w, h) = decode_dib_bytes(&dib).unwrap().unwrap();
        assert_eq!((w, h), (width, height));
        assert_eq!(&rgba[0..4], &[255, 0, 0, 255]);
        assert_eq!(&rgba[4..8], &[0, 255, 0, 255]);
    }
}
