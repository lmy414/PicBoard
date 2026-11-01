//! Background clipboard monitor (Windows).
//!
//! One dedicated thread owns a message-only window (`HWND_MESSAGE`) registered
//! with `AddClipboardFormatListener`. Each `WM_CLIPBOARDUPDATE` starts a 120 ms
//! one-shot timer so a burst of updates (some applications publish several
//! formats sequentially) becomes a single read; the read happens without the
//! storage lock, and only a supported capture takes the lock to ingest.
//!
//! Teardown only signals: `request_teardown` posts a custom message that makes
//! the thread post `WM_QUIT`, and the join happens on a separate reaping
//! thread, never inside a window callback.

use crate::SharedStorage;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

/// Coalescing window for burst clipboard updates.
#[cfg(windows)]
const COALESCE_MS: u32 = 120;

struct MonitorInner {
    app: AppHandle,
    storage: SharedStorage,
    /// Live "record clipboard" switch (true = recording). The same atomic is
    /// held by `DesktopState`, so settings changes take effect immediately.
    enabled: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    #[cfg(windows)]
    window: AtomicUsize,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

/// Handle to the clipboard monitor thread.
#[derive(Clone)]
pub struct ClipboardMonitor {
    inner: Arc<MonitorInner>,
}

impl ClipboardMonitor {
    /// Start listening. A failure to start is logged, never fatal: capture is a
    /// convenience, the rest of the app must still work.
    #[cfg(windows)]
    pub fn start(app: AppHandle, storage: SharedStorage, enabled: Arc<AtomicBool>) -> Self {
        let inner = Arc::new(MonitorInner {
            app,
            storage,
            enabled,
            stop: Arc::new(AtomicBool::new(false)),
            window: AtomicUsize::new(0),
            thread: Mutex::new(None),
        });
        let worker = Arc::clone(&inner);
        match std::thread::Builder::new()
            .name("picboard-clipboard".into())
            .spawn(move || {
                if let Err(error) = platform::run(&worker) {
                    eprintln!("[clipboard] monitor stopped: {error}");
                }
            }) {
            Ok(handle) => {
                *inner
                    .thread
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner()) = Some(handle);
            }
            Err(error) => eprintln!("[clipboard] failed to start the monitor: {error}"),
        }
        Self { inner }
    }

    #[cfg(not(windows))]
    pub fn start(_app: AppHandle, _storage: SharedStorage, _enabled: Arc<AtomicBool>) -> Self {
        let inner = Arc::new(MonitorInner {
            app: _app,
            storage: _storage,
            enabled: _enabled,
            stop: Arc::new(AtomicBool::new(false)),
            thread: Mutex::new(None),
        });
        Self { inner }
    }

    /// Signal the monitor to stop and reap its thread off the calling thread.
    pub fn request_teardown(&self) {
        self.inner.stop.store(true, Ordering::Release);
        #[cfg(windows)]
        {
            let hwnd = self.inner.window.load(Ordering::Acquire);
            if hwnd != 0 {
                unsafe {
                    windows_sys::Win32::UI::WindowsAndMessaging::PostMessageW(
                        hwnd as windows_sys::Win32::Foundation::HWND,
                        platform::WM_STOP_MONITOR,
                        0,
                        0,
                    );
                }
            }
        }
        let inner = Arc::clone(&self.inner);
        std::thread::spawn(move || {
            if let Some(thread) = inner
                .thread
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .take()
            {
                let _ = thread.join();
            }
        });
    }
}

/// Read the clipboard and ingest one capture. Runs on the monitor thread.
fn handle_update(inner: &MonitorInner) {
    let enabled = !inner.stop.load(Ordering::Acquire) && inner.enabled.load(Ordering::Acquire);
    if !enabled {
        // Do not even open the clipboard while capture is off.
        return;
    }
    let capture = match crate::clipboard::read_capture() {
        Ok(capture) => capture,
        Err(error) => {
            eprintln!("[clipboard] capture read failed: {error}");
            return;
        }
    };
    if let Some(error) = capture.image_error.as_deref() {
        eprintln!("[clipboard] image ignored: {error}");
    }
    if capture.text_too_large && capture.html.is_none() && capture.image.is_none() {
        eprintln!("[clipboard] skipped an oversized text capture");
    }
    // Disabled, excluded, self-marked and payload-less captures are skipped by
    // this pure decision; it is unit-tested without the system clipboard.
    let Some(captured) = crate::clipboard::capture_decision(enabled, &capture) else {
        return;
    };
    let state = {
        let mut store = inner
            .storage
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        match store.ingest_capture(&captured) {
            Ok(state) => state,
            Err(error) => {
                eprintln!("[clipboard] ingest failed: {error}");
                return;
            }
        }
    };
    if let Err(error) = inner.app.emit(crate::STATE_CHANGED_EVENT, state) {
        eprintln!(
            "[clipboard] failed to emit {}: {error}",
            crate::STATE_CHANGED_EVENT
        );
    }
}

#[cfg(windows)]
mod platform {
    use super::{handle_update, MonitorInner, COALESCE_MS};
    use crate::error::AppError;
    use std::sync::{Arc, Mutex};
    use windows_sys::Win32::Foundation::{GetLastError, HWND, LPARAM, LRESULT, WPARAM, ERROR_CLASS_ALREADY_EXISTS};
    use windows_sys::Win32::System::DataExchange::{
        AddClipboardFormatListener, RemoveClipboardFormatListener,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
        KillTimer, PostQuitMessage, RegisterClassW, SetTimer, MSG, WNDCLASSW, WM_APP,
        WM_CLIPBOARDUPDATE, WM_TIMER,
    };

    const WINDOW_CLASS: &str = "PicBoardClipboardMonitor";
    const TIMER_ID: usize = 1;
    /// Custom message that makes the monitor thread leave its message loop.
    pub(super) const WM_STOP_MONITOR: u32 = WM_APP + 1;

    /// The window procedure has no user data channel that survives a
    /// message-only window, and the process owns exactly one monitor.
    static CONTEXT: Mutex<Option<Arc<MonitorInner>>> = Mutex::new(None);

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub(super) fn run(inner: &Arc<MonitorInner>) -> Result<(), AppError> {
        if inner.stop.load(std::sync::atomic::Ordering::Acquire) {
            return Ok(());
        }
        unsafe {
            let hwnd = create_message_window()?;
            inner
                .window
                .store(hwnd as usize, std::sync::atomic::Ordering::Release);
            // Teardown may have raced window creation: honour it before
            // entering a message loop nobody would wake up.
            if inner.stop.load(std::sync::atomic::Ordering::Acquire) {
                DestroyWindow(hwnd);
                return Ok(());
            }
            *CONTEXT.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(Arc::clone(inner));
            if AddClipboardFormatListener(hwnd) == 0 {
                let error = std::io::Error::last_os_error();
                *CONTEXT.lock().unwrap_or_else(|poison| poison.into_inner()) = None;
                DestroyWindow(hwnd);
                return Err(AppError::message(format!(
                    "无法监听系统剪贴板：{error}"
                )));
            }

            let mut message: MSG = std::mem::zeroed();
            loop {
                let result = GetMessageW(&mut message, std::ptr::null_mut(), 0, 0);
                if result == -1 {
                    let error = std::io::Error::last_os_error();
                    RemoveClipboardFormatListener(hwnd);
                    DestroyWindow(hwnd);
                    *CONTEXT.lock().unwrap_or_else(|poison| poison.into_inner()) = None;
                    return Err(AppError::message(format!(
                        "剪贴板监听消息循环失败：{error}"
                    )));
                }
                if result == 0 {
                    break;
                }
                DispatchMessageW(&message);
            }

            RemoveClipboardFormatListener(hwnd);
            DestroyWindow(hwnd);
            *CONTEXT.lock().unwrap_or_else(|poison| poison.into_inner()) = None;
        }
        Ok(())
    }

    unsafe fn create_message_window() -> Result<HWND, AppError> {
        let class_name = wide(WINDOW_CLASS);
        let window_name = wide("PicBoard 剪贴板监听");
        let class = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(wndproc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: std::ptr::null_mut(),
            hIcon: std::ptr::null_mut(),
            hCursor: std::ptr::null_mut(),
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: class_name.as_ptr(),
        };
        if RegisterClassW(&class) == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS {
            return Err(AppError::message(format!(
                "无法注册剪贴板监听窗口类：{}",
                GetLastError()
            )));
        }
        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            window_name.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            windows_sys::Win32::UI::WindowsAndMessaging::HWND_MESSAGE,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null(),
        );
        if hwnd.is_null() {
            return Err(AppError::message("无法创建剪贴板监听窗口"));
        }
        Ok(hwnd)
    }

    /// Read the clipboard on this thread, never letting a panic unwind through
    /// the window procedure (that would abort the whole process).
    fn run_update() {
        let context = CONTEXT
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        if let Some(inner) = context {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                handle_update(&inner)
            }));
        }
    }

    unsafe extern "system" fn wndproc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_CLIPBOARDUPDATE => {
                // Restarting the same timer coalesces a burst into one fire.
                if SetTimer(hwnd, TIMER_ID, COALESCE_MS, None) == 0 {
                    // The timer could not be armed; do not lose the update.
                    run_update();
                }
                0
            }
            WM_TIMER => {
                if wparam == TIMER_ID {
                    KillTimer(hwnd, TIMER_ID);
                    run_update();
                }
                0
            }
            WM_STOP_MONITOR => {
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, message, wparam, lparam),
        }
    }
}
