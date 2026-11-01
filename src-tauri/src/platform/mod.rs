mod windows;

pub use windows::cursor_position;

/// Run `task` on a short-lived worker thread.
///
/// tao dispatches window events re-entrantly from inside window API calls, so
/// a window, tray or page-load callback must never call a window API itself:
/// the callback defers that work through here instead. Spawning is fallible and
/// an event callback must never panic, so a failed spawn is only logged.
pub(crate) fn spawn_worker(name: &str, task: impl FnOnce() + Send + 'static) {
    if let Err(error) = std::thread::Builder::new()
        .name(name.to_owned())
        .spawn(task)
    {
        eprintln!("[host] failed to start worker `{name}`: {error}");
    }
}
