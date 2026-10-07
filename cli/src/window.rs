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
        || matches!(c, Cmd::Clean { dry_run: false }) || matches!(c, Cmd::Password { reset: true }) || matches!(c, Cmd::Update { check: false })
        || matches!(c, Cmd::Home { folder: Some(_), .. } | Cmd::Home { reset: true, .. })
}
/// Commands that cannot run inside the server's window: serve itself, and those that run until Ctrl+C (which would stop the server too).
fn refused(c: &Cmd) -> Option<&'static str> {
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
    let table: [(&[&str], &[&str]); 11] = [
        (&["fast", "faster", "speed", "quick", "quicker", "slow", "benchmark"], &["bench {pack}", "mode {pack} accelerated"]),
        (&["check", "broken", "problem", "driver", "fix", "wrong", "gpu"], &["doctor"]),
        (&["running", "loaded"], &["ps"]),
        (&["find", "available", "download", "catalog"], &["search"]),
        (&["phone", "tablet", "network", "share", "qr"], &["share qr"]),
        (&["password"], &["password"]),
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

/// Runs this program with the arguments, in this window, and waits.
fn run(exe: &Path, args: &[String]) {
    crate::core::log(true, &format!("[window] ran: {}", show(args)));
    crate::ticker::pause(true);  // the command writes to this terminal: the ticker line stays still meanwhile
    let r = std::process::Command::new(exe).args(args).status();
    crate::ticker::pause(false);
    match r {
        Ok(s) if !s.success() => eprintln!("({} ended with {s})", show(args)),
        Err(e) => eprintln!("could not run it: {e}"),
        _ => {}
    }
}

pub struct Window { pub exe: PathBuf, pub data: PathBuf, pub port: u16, pub rt: tokio::runtime::Handle }
impl Window {
    fn ask(&self, lines: &mut dyn Iterator<Item = std::io::Result<String>>, prompt: &str) -> String {
        eprint!("{prompt}"); let _ = std::io::stderr().flush();
        lines.next().and_then(|l| l.ok()).unwrap_or_default().trim().to_string()
    }
    fn confirm(&self, lines: &mut dyn Iterator<Item = std::io::Result<String>>, prompt: &str) -> bool {
        matches!(self.ask(lines, prompt).to_lowercase().as_str(), "y" | "yes")
    }
    /// Ask Sushila answers with quotes here (its model is under 3B parameters).
    fn quote_mode(&self) -> bool {
        let (gpu, _, info) = self.rt.block_on(crate::assistant::probe(&self.data));
        let mem = gpu.as_ref().and_then(|g| g["memoryGB"].as_f64()).unwrap_or(info["memory_bytes"].as_f64().unwrap_or(0.0) / 1e9 * 0.6);
        crate::assistant::model_for(&self.data, mem).map(|m| m.1).unwrap_or(true)
    }
    fn assistant(&self, q: &str, extra: Option<&str>, stream: bool) -> Result<serde_json::Value, String> {
        let mut print = |t: &str| { eprint!("{t}"); let _ = std::io::stderr().flush(); };
        self.rt.block_on(crate::assistant::answer_stream(&self.data, self.port, q, &[], true, extra, if stream { Some(&mut print) } else { None }))
    }
    /// One typed line (not ?, urls or stop, which serve() handles itself).
    pub fn line(&self, line: &str, lines: &mut dyn Iterator<Item = std::io::Result<String>>) {
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
            _ => {}
        }
        if is_question(line) {
            eprintln!();
            match self.assistant(line, None, true) {
                Ok(v) if v["mode"] == "quote" => eprintln!("\n[quoted from Sushila's notes ({} is a small model): {}]", v["model"].as_str().unwrap_or(""), v["sources"].as_array().map(|a| a.iter().filter_map(|s| s["title"].as_str()).collect::<Vec<_>>().join("; ")).unwrap_or_default()),
                Ok(v) => eprintln!("\n[answered by {} from: {}]", v["model"].as_str().unwrap_or(""), v["sources"].as_array().map(|a| a.iter().filter_map(|s| s["title"].as_str()).collect::<Vec<_>>().join("; ")).unwrap_or_default()),
                Err(e) => eprintln!("the assistant could not answer: {e}"),
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
            let extra = format!("The user typed this into the Sushila server window, but it is not a valid sushila command. Reply ONLY with 1 to 3 lines, each exactly \"CMD: sushila <command> <arguments>\", using only these commands and pack ids from the facts:\n{list}");
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
pub fn read_loop(w: Window, banner: String) {
    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();
    while let Some(Ok(line)) = lines.next() {
        match line.trim().to_lowercase().as_str() {
            "" => {}
            "?" | "man" | "help" | "h" => eprintln!("{}", crate::quick_help()),
            "urls" | "url" => eprintln!("{banner}"),
            "ticker off" => { crate::ticker::set_on(false); eprintln!("ticker off (ticker on shows it again; sushila config set ticker off keeps it off)"); }
            "ticker on" => { if crate::ticker::active() { crate::ticker::set_on(true); eprintln!("ticker on"); } else { eprintln!("the ticker is not available in this window (not a terminal, --quiet, TERM=dumb, SUSHILA_TICKER=0 or the setting ticker is off)"); } }
            "stop" | "quit" | "exit" | "q" => { eprintln!("stopping..."); let _ = std::fs::write(w.data.join("shutdown-request.json"), "{}"); break; }
            _ => w.line(&line, &mut lines),
        }
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
        assert!(changes_things(&c("password --reset")) && !changes_things(&c("password")) && changes_things(&c("home /tmp/x")) && !changes_things(&c("home")) && changes_things(&c("share on")) && !changes_things(&c("share qr")) && changes_things(&c("keys remove a")));
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
