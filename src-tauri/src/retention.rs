//! Background history retention.
//!
//! Unplaced, unclassified contents expire after `historyRetentionDays`
//! (`0` = never). The sweep runs once at startup, then every six hours, and is
//! triggered immediately when the user changes the retention setting. Each
//! sweep that removed something broadcasts the new state so any open panel
//! refreshes without polling.

use crate::desktop::DesktopState;
use crate::error::AppError;
use crate::SharedStorage;
use chrono::Utc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const CLEANUP_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const TICK: Duration = Duration::from_millis(500);

/// Handle to the retention thread.
#[derive(Clone)]
pub struct RetentionTimer {
    inner: Arc<TimerInner>,
}

struct TimerInner {
    stop: AtomicBool,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl RetentionTimer {
    pub fn start(app: AppHandle, storage: SharedStorage) -> Self {
        let inner = Arc::new(TimerInner {
            stop: AtomicBool::new(false),
            thread: Mutex::new(None),
        });
        let worker = Arc::clone(&inner);
        match std::thread::Builder::new()
            .name("picboard-retention".into())
            .spawn(move || {
                // The startup sweep already ran synchronously during setup; the
                // timer only handles the six-hour cadence afterwards.
                let ticks = (CLEANUP_INTERVAL.as_millis() / TICK.as_millis()) as u64;
                loop {
                    for _ in 0..ticks {
                        if worker.stop.load(Ordering::Acquire) {
                            return;
                        }
                        std::thread::sleep(TICK);
                    }
                    if worker.stop.load(Ordering::Acquire) {
                        return;
                    }
                    run_logged(&app, &storage);
                }
            }) {
            Ok(handle) => {
                *inner
                    .thread
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner()) = Some(handle);
            }
            Err(error) => eprintln!("[retention] failed to start the timer: {error}"),
        }
        Self { inner }
    }

    /// Signal the timer and reap its thread off the calling thread.
    pub fn request_teardown(&self) {
        self.inner.stop.store(true, Ordering::Release);
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

fn run_logged(app: &AppHandle, storage: &SharedStorage) {
    if let Err(error) = run_cleanup(app, storage) {
        eprintln!("[retention] cleanup failed: {error}");
    }
}

/// Apply the current retention setting. Returns how many contents were removed.
pub fn run_cleanup(app: &AppHandle, storage: &SharedStorage) -> Result<usize, AppError> {
    let Some(desktop) = app.try_state::<DesktopState>() else {
        return Ok(0);
    };
    let days = desktop.current().history_retention_days.days();
    let (state, removed) = {
        let mut store = storage
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        store.cleanup_history(Utc::now(), days)?
    };
    if removed > 0 {
        if let Err(error) = app.emit(crate::STATE_CHANGED_EVENT, state) {
            eprintln!("[retention] failed to emit {}: {error}", crate::STATE_CHANGED_EVENT);
        }
    }
    Ok(removed)
}
