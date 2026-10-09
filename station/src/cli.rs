// `SushilaStation <command>`: the same file works without a window. Double-clicked (no command) it opens the app; with a
// command (serve, status, install <pack>, run, stop, ...) it hands the command to the Sushila engine it carries, in the
// terminal it was started from, and opens no window (so it also runs over SSH, from Task Scheduler, as a service, on
// Windows Server Core). On Linux, macOS and other Unix the commands belong to the `sushila` program (Sushila.cpp): Station says so.
use std::io::Write;

/// Some(exit code) when this start was a command (it has run); None to open the app.
pub fn run_if_command() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let first = args.first()?;
    // starts of the app itself: at login (tray only), and the process id macOS Finder may add
    if first == "--hidden" || first.starts_with("-psn_") { return None; }
    #[cfg(windows)] attach_console();
    // Linux, macOS and other Unix systems: the window app does not forward commands there; the sushila program
    // (Sushila.cpp) is the command line.
    if cfg!(unix) {
        say(&format!("SushilaStation is the desktop app and does not run commands on Unix. Use sushila.cpp instead \
                      (the sushila program):\n\n    sushila {}\n\nGet it at https://sushila.ai/install \
                      (one file, no desktop libraries needed, also for servers).",
                     args.join(" ")));
        return Some(2);
    }
    let prog = match crate::engine::program() { Ok(p) => p, Err(e) => { say(&format!("error: {e}")); return Some(1); } };
    let mut c = std::process::Command::new(&prog);
    c.args(&args);
    #[cfg(windows)] { if let Some((i, o, e)) = console_stdio() { c.stdin(i).stdout(o).stderr(e); } }
    match c.status() {
        Ok(s) => Some(s.code().unwrap_or(1)),
        Err(e) => { say(&format!("error: could not run {}: {e}", prog.display())); Some(1) }
    }
}

/// A line for the person at the terminal (on Windows the app has no standard output of its own: the terminal's
/// console is opened by name).
fn say(text: &str) {
    #[cfg(windows)] {
        if let Ok(mut f) = std::fs::OpenOptions::new().write(true).open("CONOUT$") { let _ = writeln!(f, "{text}"); return; }
    }
    let _ = writeln!(std::io::stderr(), "{text}");
}

// Windows starts Station as a windowed program: it gets no console. Attaching to the console of the terminal that
// started it (cmd, PowerShell, Windows Terminal, SSH) lets the engine print there and read from it.
#[cfg(windows)]
extern "system" { fn AttachConsole(process_id: u32) -> i32; }
#[cfg(windows)]
fn attach_console() { unsafe { AttachConsole(u32::MAX); } }  // ATTACH_PARENT_PROCESS; no terminal (Task Scheduler): nothing to attach
#[cfg(windows)]
fn console_stdio() -> Option<(std::process::Stdio, std::process::Stdio, std::process::Stdio)> {
    let open = |name: &str, write: bool| std::fs::OpenOptions::new().read(!write).write(write).open(name).ok();
    let (i, o, e) = (open("CONIN$", false)?, open("CONOUT$", true)?, open("CONOUT$", true)?);
    Some((i.into(), o.into(), e.into()))
}
