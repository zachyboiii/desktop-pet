#[cfg(windows)]
mod windows_os;
#[cfg(windows)]
pub use windows_os::*;

#[cfg(target_os = "macos")]
mod macos_os;
#[cfg(target_os = "macos")]
pub use macos_os::*;

#[cfg(not(any(windows, target_os = "macos")))]
mod other_os;
#[cfg(not(any(windows, target_os = "macos")))]
pub use other_os::*;
