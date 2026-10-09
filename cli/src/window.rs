// The server window's prompt: a typed line is a sushila command (run as in a terminal; changes ask first), a question
// (answered by the Sushila assistant, in this process), or a command attempt that did not parse (the assistant and a
// spelling match propose real commands, each checked by clap; nothing runs without a yes).
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use clap::{CommandFactory, Parser};
use crate::{Cli, Cmd, KeysCmd, ShareCmd};

/// Words split like a shell would (double or single quotes keep spaces).
pub fn split_args(line: &str) -> Vec<String> {
    let (mut out, mut cur, mut q, mut any) = (vec![], String::new(), None::<char>, false);
    for c in line.chars() {
        match (q, c) {
            (Some(x), c) if c == x => q = None,
            (Some(_), c) => cur.push(c),
            (None, '"' | '\'') => { q = Some(c); any = true; }
            (None, c) if c.is_whitespace() => { if !cur.is_empty() || any { out.push(std::mem::take(&mut cur)); any = false; } }
            (None, c) => cur.push(c),
        }
    }
    if !cur.is_empty() || any { out.push(cur); }
    out
}
/// The arguments of a typed command, without a leading "sushila" (or sushila.exe, ./sushila).
pub fn command_args(line: &str) -> Vec<String> {
    let mut a = split_args(line.trim().trim_matches('`'));
    if a.first().map(|w| { let w = w.trim_start_matches("./").to_lowercase(); w == "sushila" || w == "sushila.exe" }).unwrap_or(false) { a.remove(0); }
    a
}
pub fn parse(args: &[String]) -> Result<Cli, clap::Error> { Cli::try_parse_from(std::iter::once("sushila".to_string()).chain(args.iter().cloned())) }
fn valid(args: &[String]) -> bool { !args.is_empty() && parse(args).map(|c| c.cmd.is_some()).unwrap_or(false) }

/// Commands that delete or change things: asked before they run.
pub fn changes_things(c: &Cmd) -> bool {
    matches!(c, Cmd::Remove { .. } | Cmd::Uninstall { .. } | Cmd::Restore { .. } | Cmd::Import { .. } | Cmd::Keys { act: KeysCmd::Remove { .. } } | Cmd::Share { act: ShareCmd::On { .. } })
        || matches!(c, Cmd::Clean { dry_run: false }) || matches!(c, Cmd::Update { check: false })
        || matches!(c, Cmd::Home { folder: Some(_), .. } | Cmd::Home { reset: true, .. })
}
/// Commands that cannot run inside the server's window: serve itself, and those that run until Ctrl+C (which would stop the server too).
fn refused(c: &Cmd) -> Option<&'static str> {
    if crate::tui::in_screen() {
        match c {
            Cmd::Chat { .. } => return Some("this window takes one line at a time: chat on its Generate page, or run sushila chat in another terminal"),
            Cmd::Assistant { question: None } => return Some("just type your question here, it is answered right away"),
            _ => {}
        }
    }
    match c {
        Cmd::Serve { .. } => Some("the server is already running in this window"),
        Cmd::Top { once: false, .. } | Cmd::Logs { follow: true, .. } | Cmd::Watch { once: false, .. } =>
            Some("it runs until Ctrl+C, and Ctrl+C here also stops the server: run it in another terminal"),
        _ => None,
    }
}
/// A question or a sentence (for the assistant), not a command attempt.
pub fn is_question(line: &str) -> bool {
    let l = line.trim().to_lowercase();
    let first = l.split_whitespace().next().unwrap_or("");
    l.ends_with('?') || ["what", "how", "why", "which", "where", "when", "who", "can", "could", "does", "do", "is", "are", "should", "will", "would"].contains(&first)
        || l.starts_with("help me") || l.split_whitespace().count() >= 4
}

fn subcommands() -> Vec<(String, String)> {
    Cli::command().get_subcommands().map(|s| (s.get_name().to_string(), s.get_about().map(|a| a.to_string()).unwrap_or_default())).collect()
}
fn distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![i; b.len() + 1];
        for k in 1..=b.len() { cur[k] = (prev[k] + 1).min(cur[k - 1] + 1).min(prev[k - 1] + usize::from(a[i - 1] != b[k - 1])); }
        prev = cur;
    }
    prev[b.len()]
}
/// Spelling: the first word replaced by the nearest command names (at most 2 letters off), kept if clap accepts the line.
pub fn spelling_candidates(args: &[String]) -> Vec<Vec<String>> {
    let Some(w) = args.first().map(|w| w.to_lowercase()) else { return vec![] };
    let mut near: Vec<(usize, String)> = subcommands().into_iter().map(|(n, _)| (distance(&w, &n), n)).filter(|(d, n)| *d <= 2 && *d < n.len()).collect();
    near.sort();
    near.into_iter().map(|(_, n)| std::iter::once(n).chain(args[1..].iter().cloned()).collect::<Vec<_>>()).filter(|a| valid(a)).take(3).collect()
}
/// Without a language model (quote mode): the command word by spelling or by everyday words, pack words matched
/// against pack ids ("instal coder model" -> install qwen2.5-coder-7b). `packs`: catalog and installed ids; `mine`: an
/// installed text pack for commands that need one. Every candidate is checked by clap.
pub fn keyword_candidates(args: &[String], packs: &[String], mine: Option<&str>) -> Vec<Vec<String>> {
    const FILL: [&str; 14] = ["model", "models", "pack", "packs", "the", "a", "an", "for", "me", "please", "my", "it", "new", "one"];
    let names: Vec<String> = subcommands().into_iter().map(|(n, _)| n).collect();
    let lower: Vec<String> = args.iter().map(|a| a.to_lowercase()).collect();
    let mut out: Vec<Vec<String>> = vec![];
    let push = |v: Vec<String>, out: &mut Vec<Vec<String>>| { if valid(&v) && !out.contains(&v) && out.len() < 3 { out.push(v); } };
    // 1. a command word (exact or at most 2 letters off), then pack ids that contain the other words
    let cmd = lower.first().and_then(|w| { let mut near: Vec<(usize, &String)> = names.iter().map(|n| (distance(w, n), n)).filter(|(d, n)| *d <= 2 && *d < n.len()).collect(); near.sort(); near.first().map(|x| x.1.clone()) });
    if let Some(c) = &cmd {
        let rest: Vec<&String> = lower[1..].iter().filter(|w| !FILL.contains(&w.as_str())).collect();
        if !rest.is_empty() {
            for id in packs.iter().filter(|id| rest.iter().all(|w| id.contains(w.as_str()))) { push(vec![c.clone(), id.clone()], &mut out); }
        } else { push(vec![c.clone()], &mut out); }
        if !out.is_empty() { return out; }
    }
    // 2. everyday words for what a command does
    let pack = mine.unwrap_or(crate::core::DEFAULT_MODEL);
    let table: [(&[&str], &[&str]); 10] = [
        (&["fast", "faster", "speed", "quick", "quicker", "slow", "benchmark"], &["bench {pack}", "mode {pack} accelerated"]),
        (&["check", "broken", "problem", "driver", "fix", "wrong", "gpu"], &["doctor"]),
        (&["running", "loaded"], &["ps"]),
        (&["find", "available", "download", "catalog"], &["search"]),
        (&["phone", "tablet", "network", "share", "qr"], &["share qr"]),
        (&["log", "logs", "error", "errors"], &["logs"]),
        (&["update", "upgrade", "newer"], &["update --check"]),
        (&["space", "disk", "size"], &["du"]),
        (&["uninstall"], &["uninstall"]),
        (&["chat", "talk"], &["chat"]),
    ];
    for (keys, cmds) in table { if lower.iter().any(|w| keys.contains(&w.as_str())) { for c in cmds { push(split_args(&c.replace("{pack}", pack)), &mut out); } } }
    out
}

/// "CMD: sushila ..." lines of the assistant's reply, each checked by clap.
pub fn parse_candidates(reply: &str) -> Vec<Vec<String>> {
    let mut out: Vec<Vec<String>> = vec![];
    for l in reply.lines() {
        let Some(i) = l.find("CMD:") else { continue };
        let a = command_args(l[i + 4..].trim().trim_matches('`'));
        if valid(&a) && !out.contains(&a) { out.push(a); }
    }
    out.truncate(3);
    out
}
fn show(a: &[String]) -> String { std::iter::once("sushila".to_string()).chain(a.iter().map(|x| if x.contains(' ') || x.is_empty() { format!("\"{x}\"") } else { x.clone() })).collect::<Vec<_>>().join(" ") }

/// Runs this program with the arguments, in this window. Under the screen it runs in the background (the window keeps
/// taking commands and questions; a line says when it is finished); in a plain terminal it waits.
fn run(exe: &Path, args: &[String]) {
    crate::core::log(true, &format!("[window] ran: {}", show(args)));
    if crate::tui::in_screen() {
        let mut c = std::process::Command::new(exe);
        c.args(args).stdin(std::process::Stdio::null());
        match wait_or_cancel(c) {
            Ok(Some(s)) if !s.success() => eprintln!("({} ended with {s})", show(args)),
            Ok(None) => eprintln!("(cancelled: {})", show(args)),
            Err(e) => eprintln!("could not run it: {e}"),
            _ => {}
        }
        return;
    }
    crate::ticker::pause(true);  // the command writes to this terminal: the ticker line stays still meanwhile
    let r = std::process::Command::new(exe).args(args).status();
    crate::ticker::pause(false);
    match r {
        Ok(s) if !s.success() => eprintln!("({} ended with {s})", show(args)),
        Err(e) => eprintln!("could not run it: {e}"),
        _ => {}
    }
}

/// Puts text on the clipboard: the system's tool (Windows clip, macOS pbcopy, Linux wl-copy, xclip or xsel), else the
/// terminal's own clipboard sequence (OSC 52: Windows Terminal, iTerm2, most Linux terminals).
pub fn to_clipboard(text: &str) -> &'static str {
    use std::process::{Command, Stdio};
    let tools: &[(&str, &[&str])] = if cfg!(windows) { &[("clip", &[])] } else if cfg!(target_os = "macos") { &[("pbcopy", &[])] }
        else { &[("wl-copy", &[]), ("xclip", &["-selection", "clipboard"]), ("xsel", &["--clipboard", "--input"])] };
    // clip reads UTF-16 with a byte-order mark as Unicode (plain bytes would be read in the old code page)
    let bytes: Vec<u8> = if cfg!(windows) { [0xFFu8, 0xFE].into_iter().chain(text.encode_utf16().flat_map(|u| u.to_le_bytes())).collect() } else { text.as_bytes().to_vec() };
    for (t, a) in tools {
        let Ok(mut c) = Command::new(t).args(*a).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else { continue };
        let ok = c.stdin.take().map(|mut i| i.write_all(&bytes).is_ok()).unwrap_or(false);
        if ok && c.wait().map(|s| s.success()).unwrap_or(false) { return "copied to the clipboard"; }
    }
    use base64::Engine;
    eprint!("\x1b]52;c;{}\x07", base64::engine::general_purpose::STANDARD.encode(text.as_bytes()));
    "sent to the terminal's clipboard (if the terminal allows it; else select the text with the mouse)"
}

/// A working example for commands people often start without their arguments.
fn example(cmd: &str, port: u16) -> Option<String> {
    Some(match cmd {
        "run" => format!("Example: sushila run z-image-turbo-nvidia \"a red fox in the snow, golden light\"  (the picture is saved in the folder shown; or use the Generate Images page: http://localhost:{port}/)\n         sushila run qwen3-4b-instruct-2507 \"Write a haiku about GPUs\"  (text is printed here)"),
        "install" => "Example: sushila install qwen2.5-coder-7b  (find packs: sushila search <words>, sushila search --kind image)".into(),
        "ask" => "Example: sushila ask notes.txt \"What are the action items?\"".into(),
        "mode" => "Example: sushila mode qwen3-4b-instruct-2507 accelerated".into(),
        "bench" | "eval" | "show" | "remove" | "start" | "license" => format!("Example: sushila {cmd} qwen3-4b-instruct-2507  (installed packs: sushila list)"),
        "search" => "Example: sushila search coder, or sushila search --kind image --fits".into(),
        _ => return None,
    })
}

/// Runs a line in the system shell (cmd on Windows, sh elsewhere), in the background under the screen.
fn shell(cmd: &str, dir: &Path) {
    if cmd.is_empty() { eprintln!("!<command> runs a command of the system shell, e.g. !dir or !ls, !nvidia-smi"); return; }
    // Windows: the line goes to cmd exactly as typed (quoted as one argument, cmd would garble inner quotes, e.g. in
    // !powershell -c "Get-Content logs\x.log -Tail 40")
    #[cfg(windows)]
    let mut c = { use std::os::windows::process::CommandExt; let mut c = std::process::Command::new("cmd"); c.arg("/C").raw_arg(cmd); c };
    #[cfg(not(windows))]
    let mut c = { let mut c = std::process::Command::new("sh"); c.args(["-c", cmd]); c };
    c.current_dir(dir).stdin(std::process::Stdio::null());
    if crate::tui::in_screen() {
        match wait_or_cancel(c) { Ok(None) => eprintln!("(cancelled)"), Err(e) => eprintln!("could not run it: {e}"), _ => {} }
    } else { let _ = c.status(); }
}
/// Under the screen: runs the command and waits, unless Ctrl+C there asks to cancel (the file window-cancel in the
/// home folder): then the command is stopped. Ok(None) = cancelled.
fn wait_or_cancel(mut c: std::process::Command) -> std::io::Result<Option<std::process::ExitStatus>> {
    let cancel = PathBuf::from(std::env::var("SUSHILA_HOME").unwrap_or_default()).join("window-cancel");
    let mut ch = c.spawn()?;
    loop {
        if let Some(s) = ch.try_wait()? { return Ok(Some(s)); }
        if cancel.exists() { let _ = std::fs::remove_file(&cancel); let _ = ch.kill(); let _ = ch.wait(); return Ok(None); }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// The clipboard's text (Windows PowerShell Get-Clipboard, macOS pbpaste, Linux wl-paste, xclip or xsel); "" if none.
pub fn from_clipboard() -> String {
    let tools: &[(&str, &[&str])] = if cfg!(windows) { &[("powershell", &["-NoProfile", "-Command", "Get-Clipboard -Raw"])] } else if cfg!(target_os = "macos") { &[("pbpaste", &[])] }
        else { &[("wl-paste", &["--no-newline"]), ("xclip", &["-selection", "clipboard", "-o"]), ("xsel", &["--clipboard", "--output"])] };
    for (t, a) in tools {
        if let Ok(o) = std::process::Command::new(t).args(*a).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).output() {
            if o.status.success() { return String::from_utf8_lossy(&o.stdout).trim_end_matches(['\r', '\n']).replace(['\r', '\n'], " "); }
        }
    }
    String::new()
}

pub struct Window { pub exe: PathBuf, pub data: PathBuf, pub port: u16, pub rt: tokio::runtime::Handle, pub last: std::sync::Mutex<String> }
impl Window {
    fn ask(&self, lines: &mut dyn Iterator<Item = std::io::Result<String>>, prompt: &str) -> String {
        eprint!("{prompt}"); let _ = std::io::stderr().flush();
        signal("ask");
        lines.next().and_then(|l| l.ok()).unwrap_or_default().trim().to_string()
    }
    fn confirm(&self, lines: &mut dyn Iterator<Item = std::io::Result<String>>, prompt: &str) -> bool {
        matches!(self.ask(lines, prompt).to_lowercase().as_str(), "y" | "yes")
    }
    /// Ask Sushila answers with quotes here (its model is under 3B parameters).
    /// The classic helper answers here unless a chat model (3B or more) already runs.
    fn quote_mode(&self) -> bool { crate::assistant::running_chat(&crate::webserver::read_state(&self.data)).is_none() }
    fn assistant(&self, q: &str, extra: Option<&str>, stream: bool) -> Result<serde_json::Value, String> {
        // under the screen, whole lines (output of commands running in the background may come in between)
        let screen = crate::tui::in_screen();
        let mut held = String::new();
        let mut print = |t: &str| {
            if !screen { eprint!("{t}"); let _ = std::io::stderr().flush(); return; }
            held.push_str(t);
            while let Some(i) = held.find('\n') { let l: String = held.drain(..=i).collect(); eprint!("{l}"); }
        };
        let r = self.rt.block_on(crate::assistant::answer_stream(&self.data, self.port, q, &[], true, extra, if stream { Some(&mut print) } else { None }));
        if !held.is_empty() { eprintln!("{held}"); }
        r
    }
    /// One typed line (not ?, urls or stop, which serve() handles itself).
    pub fn line(&self, line: &str, lines: &mut dyn Iterator<Item = std::io::Result<String>>) {
        // !<command>: a command of the operating system's shell (dir, ls, nvidia-smi ...), in the home folder
        if let Some(sh) = line.trim().strip_prefix('!') { shell(sh.trim(), &self.data); return; }
        let args = command_args(line);
        if args.is_empty() { return; }
        match parse(&args) {
            Ok(c) if c.cmd.is_some() => {
                let cmd = c.cmd.as_ref().unwrap();
                if let Some(why) = refused(cmd) { eprintln!("`{}` is not run here: {why}.", show(&args)); return; }
                if changes_things(cmd) && !self.confirm(lines, &format!("`{}` deletes or changes things. Run this? [y/N] ", show(&args))) { eprintln!("not run."); return; }
                run(&self.exe, &args);
                return;
            }
            Err(e) if matches!(e.kind(), clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion | clap::error::ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand) => { let _ = e.print(); return; }
            // a real command with something missing or wrong (e.g. `run` without a prompt): what it needs, with an example
            Err(e) if Cli::command().find_subcommand(&args[0]).is_some() => {
                eprintln!("{}", e.render().to_string().lines().filter(|l| !l.trim().is_empty() && !l.starts_with("For more information")).collect::<Vec<_>>().join("\n"));
                if let Some(x) = example(&args[0], self.port) { eprintln!("{x}"); }
                eprintln!("(sushila {} --help explains every option)", args[0]);
                return;
            }
            _ => {}
        }
        if is_question(line) {
            eprintln!();
            let r = self.assistant(line, None, true);
            if let Ok(v) = &r { if let Some(a) = v["answer"].as_str() { *self.last.lock().unwrap() = a.to_string(); } }
            match r {
                Ok(v) if v["mode"] == "quote" => eprintln!("\n[quoted from Sushila's notes ({} is a small model): {}]", v["model"].as_str().unwrap_or(""), v["sources"].as_array().map(|a| a.iter().filter_map(|s| s["title"].as_str()).collect::<Vec<_>>().join("; ")).unwrap_or_default()),
                Ok(v) => eprintln!("\n[answered by {} from: {}]", v["model"].as_str().unwrap_or(""), v["sources"].as_array().map(|a| a.iter().filter_map(|s| s["title"].as_str()).collect::<Vec<_>>().join("; ")).unwrap_or_default()),
                Err(e) => {
                    // the first model is still downloading (a .part file in a pack folder): say so instead
                    let downloading = std::fs::read_dir(self.data.join("model-packs")).into_iter().flatten().flatten()
                        .any(|d| std::fs::read_dir(d.path()).into_iter().flatten().flatten().any(|f| f.file_name().to_string_lossy().ends_with(".part")));
                    if downloading { eprintln!("the model is still downloading; ask again when it says it is ready (the documentation: urls)"); }
                    else { eprintln!("the assistant could not answer: {e}"); }
                }
            }
            return;
        }
        // a command attempt that does not parse: spelling first; then, with a model of 3B or more, the assistant proposes
        // real commands; with a small one (quote mode) only words matched against commands and pack ids
        let quote = self.quote_mode();
        let mut cands = if quote { vec![] } else { spelling_candidates(&args) };
        if quote {
            let st = crate::webserver::read_state(&self.data);
            let mut packs: Vec<String> = std::fs::read_to_string(self.data.join("catalog-cache.json")).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                .and_then(|c| c["packs"].as_array().map(|a| a.iter().filter_map(|p| p["id"].as_str().map(String::from)).collect())).unwrap_or_default();
            packs.extend(st["packs"].as_object().map(|m| m.keys().cloned().collect::<Vec<_>>()).unwrap_or_default());
            let mine = crate::assistant::pick_model(&st, 0.0);
            for c in keyword_candidates(&args, &packs, mine.as_deref()) { if !cands.contains(&c) && cands.len() < 3 { cands.push(c); } }
        } else if cands.len() < 3 {
            let list: String = subcommands().iter().map(|(n, a)| format!("{n}: {}\n", a.lines().next().unwrap_or(""))).collect();
            let extra = format!("The user typed this into the Sushila Engine window, but it is not a valid sushila command. Reply ONLY with 1 to 3 lines, each exactly \"CMD: sushila <command> <arguments>\", using only these commands and pack ids from the facts:\n{list}");
            eprintln!("(not a command; asking the assistant what you meant…)");
            if let Ok(v) = self.assistant(line, Some(&extra), false) { for c in parse_candidates(v["answer"].as_str().unwrap_or("")) { if !cands.contains(&c) && cands.len() < 3 { cands.push(c); } } }
        }
        match cands.len() {
            0 => {
                let w = args[0].to_lowercase();
                let mut near: Vec<(usize, String, String)> = subcommands().into_iter().map(|(n, a)| (distance(&w, &n), n, a)).collect();
                near.sort();
                eprintln!("What are you trying to do? Type a question in plain words, or one of these (sushila --help lists all):");
                for (_, n, a) in near.into_iter().take(3) { eprintln!("  sushila {n:<11} {}", a.lines().next().unwrap_or("")); }
            }
            1 => { if self.confirm(lines, &format!("Did you mean `{}`? Run it? [y/N] ", show(&cands[0]))) { self.line(&show(&cands[0]), lines); } else { eprintln!("not run."); } }
            _ => {
                eprintln!("Did you mean:"); for (i, c) in cands.iter().enumerate() { eprintln!("  {}. {}", i + 1, show(c)); }
                let a = self.ask(lines, &format!("Which one? [1-{}, Enter = none] ", cands.len()));
                match a.parse::<usize>() { Ok(k) if (1..=cands.len()).contains(&k) => self.line(&show(&cands[k - 1]), lines), _ => eprintln!("not run.") }
            }
        }
    }
}

/// The reader thread's loop (stdin of the server's window).
/// Tells the screen (tui.rs) where the window loop is: "idle" = ready for the next line, "ask" = waits for an answer.
pub fn signal(state: &str) { if crate::tui::in_screen() { eprint!("\x1b]7771;{state}\x07"); let _ = std::io::stderr().flush(); } }

/// The first start: "Create a link to your app?" Yes: the sushila.ai sign-in here (the e-mail from last time is offered;
/// a code is e-mailed, no password), then the engine opens the link (tunnel::at_start). The answer is kept
/// (settings.internetUrlAtStart, sent to the engine as a settings request); 🌐 on the page changes it later.
fn first_start_link(w: &Window, lines: &mut dyn Iterator<Item = std::io::Result<String>>) {
    if !crate::webserver::read_state(&w.data)["settings"]["internetUrlAtStart"].is_null() { return; }
    let set = |yes: bool| { let id = crate::webserver::new_id().replacen("job-", "task-", 1);
        let _ = crate::util::post_request(&w.data, "control-in", &id, &serde_json::json!({ "id": id, "action": "settings", "values": { "internetUrlAtStart": yes }, "source": "first start" })); };
    eprintln!("\nA link to your app (https://sushila.ai/localhost/...) reaches this Sushila Engine from your phone or anywhere, while it runs.\nVisitors need its access key and see only the Generate pages and their queue; Model packs, Engine, myContent and your files stay on this computer.");
    let a = w.ask(lines, "Create a link to your app? [y/N]: ").to_lowercase();
    if a != "y" && a != "yes" { set(false); eprintln!("No link. Make one at any time with 🌐 Get temporary internet URL on the page."); return; }
    let me = crate::share::me(&w.data);
    if me["signedIn"] == true { set(true); eprintln!("Signed in to sushila.ai as {}; the link appears below once the engine is ready.", me["email"].as_str().unwrap_or("")); return; }
    eprintln!("The link is made with a sushila.ai account. No password to remember: we e-mail you a one-time code (OTP) to sign in.");
    let last = crate::share::last_email(&w.data);
    for _ in 0..3 {
        let typed = if last.is_empty() { w.ask(lines, "Your e-mail address: ") } else { w.ask(lines, &format!("Sign in as {last}? Press Enter for the code (not you? type your e-mail address): ")) };
        let email = if typed.is_empty() && !last.is_empty() { last.clone() } else { typed };
        if !email.contains('@') { eprintln!("That does not look like an e-mail address."); continue; }
        let mut first = String::new();
        let sent = match w.rt.block_on(crate::share::send_code(&w.data, &email, "SIGN_IN")) {
            Ok(_) => Ok(()),
            Err(e) if e.to_lowercase().contains("no account") => { first = w.ask(lines, "New sushila.ai account: your first name: "); w.rt.block_on(crate::share::send_code(&w.data, &email, "SIGN_UP")).map(|_| ()) }
            Err(e) => Err(e),
        };
        if let Err(e) = sent { eprintln!("Could not send the code: {e}"); continue; }
        for _ in 0..3 {
            let code = w.ask(lines, &format!("The 6-digit code e-mailed to {email}: "));
            match w.rt.block_on(crate::share::verify(&w.data, &email, &code, &first)) {
                Ok(_) => { set(true); eprintln!("Signed in to sushila.ai as {email}. The link to your app appears below once the engine is ready."); return; }
                Err(e) => eprintln!("{e}"),
            }
        }
    }
    // no answer stored: the question comes again at the next start
    eprintln!("Not signed in, so no link this time (asked again at the next start). 🌐 Get temporary internet URL on the page signs in and makes one.");
}

pub fn read_loop(w: Window, banner: String) {
    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();
    first_start_link(&w, &mut lines);
    crate::ticker::prompt();
    let cancel = w.data.join("window-cancel");
    let _ = std::fs::remove_file(&cancel);
    signal("idle");
    while let Some(Ok(line)) = lines.next() {
        match line.trim().to_lowercase().as_str() {
            "" => {}
            "copy" | "copy answer" => {
                let a = w.last.lock().unwrap().clone();
                if a.trim().is_empty() { eprintln!("no answer yet to copy; copy urls copies the addresses (any text: select it with the mouse, then right-click)"); }
                else { eprintln!("the last answer ({} characters): {}", a.chars().count(), to_clipboard(&a)); }
            }
            "copy urls" | "copy url" => eprintln!("the addresses: {}", to_clipboard(banner.trim().trim_matches('=').trim())),
            "?" | "man" | "help" | "h" => eprintln!("{}", crate::quick_help()),
            "urls" | "url" => eprintln!("{banner}"),
            "ticker off" => { crate::ticker::set_on(false); eprintln!("ticker off (ticker on shows it again; sushila config set ticker off keeps it off)"); }
            "ticker on" => { if crate::ticker::active() { crate::ticker::set_on(true); eprintln!("ticker on"); } else { eprintln!("the ticker is not available in this window (not a terminal, --quiet, TERM=dumb, SUSHILA_TICKER=0 or the setting ticker is off)"); } }
            "stop" | "quit" | "exit" | "q" => { eprintln!("stopping..."); let _ = std::fs::write(w.data.join("shutdown-request.json"), "{}"); break; }
            _ => w.line(&line, &mut lines),
        }
        let _ = std::fs::remove_file(&cancel);
        signal("idle");
        crate::ticker::prompt();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn a(s: &str) -> Vec<String> { command_args(s) }
    #[test] fn splits() { assert_eq!(split_args("run p \"a b\" 'c'"), vec!["run", "p", "a b", "c"]); assert_eq!(a("sushila ps"), vec!["ps"]); assert_eq!(a("`sushila status`"), vec!["status"]); }
    #[test] fn parses_and_classifies() {
        assert!(valid(&a("ps")) && valid(&a("sushila install qwen3-4b-instruct-2507")) && !valid(&a("instal qwen")) && !valid(&a("banana")));
        let c = |s: &str| parse(&a(s)).unwrap().cmd.unwrap();
        assert!(changes_things(&c("remove x")) && changes_things(&c("clean")) && !changes_things(&c("clean --dry-run")) && changes_things(&c("update")) && !changes_things(&c("update --check")));
        assert!(changes_things(&c("home /tmp/x")) && !changes_things(&c("home")) && changes_things(&c("share on")) && !changes_things(&c("share qr")) && changes_things(&c("keys remove a")));
        assert!(refused(&c("serve")).is_some() && refused(&c("top")).is_some() && refused(&c("top --once")).is_none() && refused(&c("logs -f")).is_some());
        assert!(is_question("what does accelerated do?") && is_question("how do I add a model") && is_question("make my videos look better please") && !is_question("instal qwen") && !is_question("banana"));
    }
    #[test] fn candidates() {
        assert_eq!(spelling_candidates(&a("instal qwen")), vec![a("install qwen")]);
        assert!(spelling_candidates(&a("banana")).is_empty());
        let packs: Vec<String> = ["qwen2.5-0.5b-q4km", "qwen2.5-coder-7b", "qwen3-coder-30b-a3b", "z-image-turbo"].iter().map(|x| x.to_string()).collect();
        assert_eq!(keyword_candidates(&a("instal coder model"), &packs, None), vec![a("install qwen2.5-coder-7b"), a("install qwen3-coder-30b-a3b")]);
        assert_eq!(keyword_candidates(&a("make it faster"), &packs, Some("qwen2.5-0.5b-q4km")), vec![a("bench qwen2.5-0.5b-q4km"), a("mode qwen2.5-0.5b-q4km accelerated")]);
        assert!(keyword_candidates(&a("banana"), &packs, None).is_empty());
        assert_eq!(parse_candidates("Sure!\nCMD: sushila install qwen2.5-coder-7b\nCMD: `sushila frobnicate`\nCMD: sushila search --kind code"), vec![a("install qwen2.5-coder-7b"), a("search --kind code")]);
    }
}
