// The server window (`sushila serve` in a terminal, or a double-click): one screen, drawn by the supervisor and nothing
// else. The server runs as its child with its output (and the output of commands typed here) in a pipe; this process
// draws that output in the top part, the input line "sushila> " on the line above the last one, and the ticker on the
// last line. Keys are read one at a time (raw mode), so typing is never mixed with output, a resize redraws, and no
// log line or progress bar can move the prompt. PgUp/PgDn scroll back through the output.
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitCode, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use crossterm::{cursor, event::{self, Event, KeyCode, KeyEventKind, KeyModifiers}, queue, style, terminal};
use unicode_width::UnicodeWidthChar;

/// Whether this window gets the screen: a real terminal on both ends, not --quiet, not TERM=dumb, not SUSHILA_TUI=0.
pub fn wanted(quiet: bool) -> bool {
    !quiet && std::io::IsTerminal::is_terminal(&std::io::stdin()) && std::io::IsTerminal::is_terminal(&std::io::stdout())
        && std::env::var("TERM").map(|t| t != "dumb").unwrap_or(true)
        && std::env::var("SUSHILA_TUI").map(|v| v != "0" && v != "off").unwrap_or(true)
}
/// This process writes into the screen's pipe (the server under the screen, or a command typed in it).
pub fn in_screen() -> bool { std::env::var("SUSHILA_UI").is_ok() }

const PROMPT: &str = "sushila> ";
const KEEP: usize = 5000;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind { Text, Typed, Note }
#[derive(Debug)]
pub struct Line { pub text: String, pub kind: Kind }
enum Esc { None, Start, Csi, Osc(String), OscEnd(String) }

/// The output: whole lines, the last one possibly still open (a progress bar rewritten with \r, a question waiting for
/// its answer). Escape sequences are removed (OSC 52, the clipboard, is passed on), blank lines are dropped.
/// `bar`: the open line is being rewritten (\r), so lines from the screen go above it; otherwise (a question) below it.
pub struct Pane { pub lines: Vec<Line>, open: bool, bar: bool, cr: bool, esc: Esc, utf: Vec<u8>, pub clipboard: Vec<String> }
impl Pane {
    pub fn new() -> Self { Pane { lines: vec![], open: false, bar: false, cr: false, esc: Esc::None, utf: vec![], clipboard: vec![] } }
    pub fn feed(&mut self, bytes: &[u8]) {
        self.utf.extend_from_slice(bytes);
        let text = match std::str::from_utf8(&self.utf) {
            Ok(s) => { let s = s.to_string(); self.utf.clear(); s }
            Err(e) if e.error_len().is_none() => {  // a character cut in two by the pipe: keep its start for the next read
                let s = String::from_utf8_lossy(&self.utf[..e.valid_up_to()]).into_owned(); self.utf.drain(..e.valid_up_to()); s }
            Err(_) => { let s = String::from_utf8_lossy(&self.utf).into_owned(); self.utf.clear(); s }
        };
        for c in text.chars() { self.char(c); }
    }
    fn char(&mut self, c: char) {
        match std::mem::replace(&mut self.esc, Esc::None) {
            Esc::Start => match c { '[' => self.esc = Esc::Csi, ']' => self.esc = Esc::Osc(String::new()), _ => {} },
            Esc::Csi => if !('\x40'..='\x7e').contains(&c) { self.esc = Esc::Csi },
            Esc::Osc(mut o) => match c { '\x07' => self.osc(o), '\x1b' => self.esc = Esc::OscEnd(o), c => { o.push(c); self.esc = Esc::Osc(o) } },
            Esc::OscEnd(o) => self.osc(o),
            Esc::None => match c {
                '\x1b' => self.esc = Esc::Start,
                '\n' => self.end_line(),
                '\r' => self.cr = true,
                '\t' => for _ in 0..4 { self.push(' ') },
                c if c.is_control() => {}
                c => self.push(c),
            },
        }
    }
    fn osc(&mut self, o: String) { if o.starts_with("52;") { self.clipboard.push(o); } }
    fn push(&mut self, c: char) {
        // a line started or rewritten after \r is a progress line
        let cr = std::mem::take(&mut self.cr);
        if cr && self.open { if let Some(l) = self.lines.last_mut() { l.text.clear(); } }
        if !self.open { self.lines.push(Line { text: String::new(), kind: Kind::Text }); self.open = true; self.bar = cr; } else if cr { self.bar = true; }
        self.lines.last_mut().unwrap().text.push(c);
    }
    fn end_line(&mut self) {
        self.cr = false;
        if !self.open { return; }  // an empty line: dropped
        self.open = false;
        let l = self.lines.last_mut().unwrap();
        let t = l.text.trim_end().to_string();
        if t.trim().is_empty() { self.lines.pop(); } else { l.text = t; }
        self.trim();
    }
    /// A line from the screen itself (what was typed, a note), never mixed into an open line.
    pub fn add(&mut self, text: &str, kind: Kind) {
        for t in text.lines().filter(|t| !t.trim().is_empty()) {
            let line = Line { text: t.trim_end().to_string(), kind };
            if self.open && self.bar { let n = self.lines.len() - 1; self.lines.insert(n, line); }
            else { if self.open { self.end_line(); } self.lines.push(line); }
        }
        self.trim();
    }
    fn trim(&mut self) { if self.lines.len() > KEEP { self.lines.drain(..KEEP / 5); } }
    /// The screen rows of the output, wrapped at `cols`, the open line only when it has text.
    pub fn rows(&self, cols: usize, max: usize) -> Vec<(Kind, String)> {
        let mut out: Vec<(Kind, String)> = vec![];
        for (i, l) in self.lines.iter().enumerate().rev() {
            if self.open && i + 1 == self.lines.len() && l.text.trim().is_empty() { continue; }
            let mut w = wrap(&l.text, cols); w.reverse();
            out.extend(w.into_iter().map(|t| (l.kind, t)));
            if out.len() >= max { break; }
        }
        out.reverse();
        out
    }
}
fn width(s: &str) -> usize { s.chars().map(|c| c.width().unwrap_or(0)).sum() }
/// The text cut into rows of at most `cols` columns, between words where a row would not end too early.
pub fn wrap(text: &str, cols: usize) -> Vec<String> {
    let (mut rows, mut cur, mut w): (Vec<String>, Vec<char>, usize) = (vec![], vec![], 0);
    for c in text.chars() {
        let cw = c.width().unwrap_or(0);
        if w + cw > cols {
            // the last space in the second half of the row: the word after it moves to the next row
            let cut = cur.iter().rposition(|&x| x == ' ').filter(|&i| i >= cur.len() / 2 && i > 0);
            match cut {
                Some(i) => { let rest: Vec<char> = cur.split_off(i + 1); rows.push(cur.iter().collect::<String>().trim_end().to_string()); cur = rest; }
                None => rows.push(std::mem::take(&mut cur).into_iter().collect()),
            }
            w = cur.iter().map(|x| x.width().unwrap_or(0)).sum();
        }
        cur.push(c); w += cw;
    }
    rows.push(cur.into_iter().collect());
    rows
}

enum Ev { Key(Event), Out(Vec<u8>), OutEnd }
enum Got { Line(String), Stop, Skip }

struct Screen {
    pane: Pane, input: Vec<char>, pos: usize, history: Vec<String>, hpos: Option<usize>, secret: Option<String>,
    back: usize, feed: crate::ticker::Feed, ticker_on: bool, port: u16, data: PathBuf,
    prev: Vec<String>, cursor: (u16, u16), dirty: bool, tick: Instant, port_read: Instant,
    rx: mpsc::Receiver<Ev>, tx: mpsc::Sender<Ev>, out: std::io::Stdout, stopping: bool,
    ready: bool,  // the server reads typed lines (its address banner was shown)
}

impl Screen {
    fn note(&mut self, s: &str) { crate::core::log(true, s); self.pane.add(s, Kind::Note); self.dirty = true; }
    fn size() -> (usize, usize) { terminal::size().map(|(c, r)| (c.max(20) as usize, r.max(3) as usize)).unwrap_or((80, 24)) }

    /// Draws what changed: output rows, the input line, the ticker; the cursor ends where typing goes.
    fn render(&mut self) {
        let (cols, rows) = Self::size();
        let tick = self.ticker_on && rows >= 5;
        let input_row = if tick { rows - 2 } else { rows - 1 };
        let area = input_row;
        let all = self.pane.rows(cols, area + self.back + 1);
        self.back = self.back.min(all.len().saturating_sub(area));
        let end = all.len() - self.back;
        let view = &all[end.saturating_sub(area)..end];
        let out = &mut self.out;
        let _ = queue!(out, cursor::Hide);
        if self.prev.len() != rows { self.prev = vec!["\u{0}".into(); rows]; let _ = queue!(out, terminal::Clear(terminal::ClearType::All)); }
        for r in 0..area {
            let (kind, text) = view.get(r).cloned().unwrap_or((Kind::Text, String::new()));
            let key = format!("{kind:?}{text}");
            if self.prev[r] == key { continue; }
            let _ = queue!(out, cursor::MoveTo(0, r as u16));
            match kind {
                Kind::Typed => { let _ = queue!(out, style::SetForegroundColor(style::Color::Cyan), style::Print(&text), style::ResetColor); }
                Kind::Note => { let _ = queue!(out, style::SetForegroundColor(style::Color::Yellow), style::Print(&text), style::ResetColor); }
                Kind::Text => { let _ = queue!(out, style::Print(&text)); }
            }
            let _ = queue!(out, terminal::Clear(terminal::ClearType::UntilNewLine));
            self.prev[r] = key;
        }
        // the input line: the prompt, then the typed text (stars for a password), scrolled sideways when long
        let prompt = self.secret.clone().unwrap_or_else(|| PROMPT.into());
        let shown: Vec<char> = if self.secret.is_some() { vec!['*'; self.input.len()] } else { self.input.clone() };
        let room = cols.saturating_sub(width(&prompt) + 1).max(5);
        let before: usize = shown[..self.pos].iter().map(|c| c.width().unwrap_or(0)).sum();
        let mut start = 0; let mut skipped = 0;
        while before - skipped >= room && start < self.pos { skipped += shown[start].width().unwrap_or(0); start += 1; }
        let mut vis = String::new(); let mut w = 0;
        for c in &shown[start..] { let cw = c.width().unwrap_or(0); if w + cw > room { break; } vis.push(*c); w += cw; }
        let _ = queue!(out, cursor::MoveTo(0, input_row as u16), style::SetForegroundColor(style::Color::Cyan), style::SetAttribute(style::Attribute::Bold),
            style::Print(&prompt), style::SetAttribute(style::Attribute::Reset), style::ResetColor, style::Print(&vis), terminal::Clear(terminal::ClearType::UntilNewLine));
        self.prev[input_row] = "\u{0}".into();
        self.cursor = ((width(&prompt) + before - skipped) as u16, input_row as u16);
        if tick { self.draw_ticker(cols, rows, false); }
        let _ = queue!(self.out, cursor::MoveTo(self.cursor.0, self.cursor.1), cursor::Show);
        let _ = self.out.flush();
        self.dirty = false;
    }
    fn draw_ticker(&mut self, cols: usize, rows: usize, alone: bool) {
        if self.port_read.elapsed() > Duration::from_secs(5) {
            self.port_read = Instant::now();
            let st = crate::webserver::read_state(&self.data);
            self.port = st["owner"]["port"].as_u64().or(st["settings"]["port"].as_u64()).unwrap_or(8765) as u16;
            if crate::ticker::off_setting(&st["settings"]["ticker"]) && self.ticker_on { self.ticker_on = false; self.prev.clear(); self.dirty = true; return; }
        }
        let text = if self.back > 0 { crate::ticker::fit(&format!("scrolled back {} rows: PgDn goes forward, End returns to the newest", self.back), cols - 1) }
                   else { self.feed.next(self.port, cols - 1) };
        if alone { let _ = queue!(self.out, cursor::Hide); }
        let _ = queue!(self.out, cursor::MoveTo(0, (rows - 1) as u16), style::SetAttribute(style::Attribute::Reverse), style::Print(text),
            style::SetAttribute(style::Attribute::Reset), terminal::Clear(terminal::ClearType::UntilNewLine));
        if alone { let _ = queue!(self.out, cursor::MoveTo(self.cursor.0, self.cursor.1), cursor::Show); let _ = self.out.flush(); }
    }

    /// Waits up to `t` for keys or output and handles them; returns a finished input line, Ctrl+C or nothing.
    fn pump(&mut self, t: Duration, child: Option<&mut Child>) -> Option<Got> {
        let mut got = None;
        let first = self.rx.recv_timeout(t).ok();
        let mut evs: Vec<Ev> = first.into_iter().collect();
        while evs.len() < 500 { match self.rx.try_recv() { Ok(e) => evs.push(e), Err(_) => break } }
        let mut stdin = child.and_then(|c| c.stdin.as_mut());
        for ev in evs {
            match ev {
                Ev::Out(b) => { self.pane.feed(&b); self.dirty = true; if !self.ready && self.pane.lines.iter().rev().take(40).any(|l| l.text.contains(" is running")) { self.ready = true; } }
                Ev::OutEnd => {}
                Ev::Key(Event::Resize(..)) => { self.prev.clear(); self.dirty = true; }
                Ev::Key(Event::Paste(s)) => {
                    let parts: Vec<&str> = s.split(['\n', '\r']).collect();
                    for (i, p) in parts.iter().enumerate() {
                        for c in p.chars().filter(|c| !c.is_control()) { self.input.insert(self.pos, c); self.pos += 1; }
                        if i + 1 < parts.len() && !p.is_empty() { if let Some(g) = self.submit(stdin.as_deref_mut()) { got = Some(g); } }
                    }
                    self.dirty = true;
                }
                Ev::Key(Event::Key(k)) if k.kind != KeyEventKind::Release => {
                    if let Some(g) = self.key(k, stdin.as_deref_mut()) { got = Some(g); }
                    self.dirty = true;
                }
                _ => {}
            }
        }
        for o in std::mem::take(&mut self.pane.clipboard) { let _ = write!(self.out, "\x1b]{o}\x07"); }
        if self.dirty { self.render(); }
        else if self.ticker_on && self.tick.elapsed() >= Duration::from_millis(110) {
            self.tick = Instant::now();
            let (cols, rows) = Self::size();
            if rows >= 5 { self.draw_ticker(cols, rows, true); }
        }
        got
    }
    fn key(&mut self, k: event::KeyEvent, stdin: Option<&mut std::process::ChildStdin>) -> Option<Got> {
        let ctrl = k.modifiers == KeyModifiers::CONTROL;
        match k.code {
            KeyCode::Char('c') if ctrl => { if !self.input.is_empty() { self.input.clear(); self.pos = 0; return None; } return Some(Got::Stop); }
            KeyCode::Char('u') if ctrl => { self.input.drain(..self.pos); self.pos = 0; }
            KeyCode::Char('a') if ctrl => self.pos = 0,
            KeyCode::Char('e') if ctrl => self.pos = self.input.len(),
            KeyCode::Char('l') if ctrl => self.prev.clear(),
            KeyCode::Char(_) if ctrl => {}
            KeyCode::Char(c) => { self.input.insert(self.pos, c); self.pos += 1; self.hpos = None; }
            KeyCode::Backspace => if self.pos > 0 { self.pos -= 1; self.input.remove(self.pos); },
            KeyCode::Delete => if self.pos < self.input.len() { self.input.remove(self.pos); },
            KeyCode::Left => self.pos = self.pos.saturating_sub(1),
            KeyCode::Right => self.pos = (self.pos + 1).min(self.input.len()),
            KeyCode::Home => self.pos = 0,
            KeyCode::End => { if self.input.is_empty() { self.back = 0; } self.pos = self.input.len(); }
            KeyCode::Up | KeyCode::Down if self.secret.is_none() && !self.history.is_empty() => {
                let n = self.history.len();
                let h = match (k.code, self.hpos) { (KeyCode::Up, None) => Some(n - 1), (KeyCode::Up, Some(i)) => Some(i.saturating_sub(1)),
                    (_, Some(i)) if i + 1 < n => Some(i + 1), _ => None };
                self.hpos = h;
                self.input = h.map(|i| self.history[i].chars().collect()).unwrap_or_default(); self.pos = self.input.len();
            }
            KeyCode::PageUp => { let (_, rows) = Self::size(); self.back += rows.saturating_sub(4).max(1); }
            KeyCode::PageDown => { let (_, rows) = Self::size(); self.back = self.back.saturating_sub(rows.saturating_sub(4).max(1)); }
            KeyCode::Esc => { if self.secret.is_some() { self.input.clear(); self.pos = 0; return Some(Got::Skip); } self.input.clear(); self.pos = 0; self.back = 0; }
            KeyCode::Enter => return self.submit(stdin),
            _ => {}
        }
        None
    }
    fn submit(&mut self, stdin: Option<&mut std::process::ChildStdin>) -> Option<Got> {
        let line: String = std::mem::take(&mut self.input).into_iter().collect();
        self.pos = 0; self.hpos = None; self.back = 0;
        if self.secret.is_some() { return Some(Got::Line(line)); }
        let t = line.trim().to_string();
        if t.is_empty() { return Some(Got::Line(t)); }  // Enter alone: nothing to run (hold() waits for it)
        if self.history.last() != Some(&t) { self.history.push(t.clone()); }
        self.pane.add(&format!("{PROMPT}{t}"), Kind::Typed);
        match t.to_lowercase().as_str() {
            "ticker off" => { self.ticker_on = false; self.prev.clear(); self.note("ticker off (ticker on shows it again; sushila config set ticker off keeps it off)"); }
            "ticker on" => { self.ticker_on = true; self.prev.clear(); }
            "clear" | "cls" => { self.pane.lines.clear(); self.prev.clear(); }
            _ => match stdin {
                Some(i) => {
                    if !self.ready { self.note("the server is still starting: this runs as soon as it is up"); }
                    if i.write_all(format!("{t}\n").as_bytes()).and_then(|_| i.flush()).is_err() { self.note("the server is not reading input right now; try again in a moment"); } }
                None => self.note("the server is not running right now; try again in a moment"),
            },
        }
        Some(Got::Line(t))
    }
    /// Asks for a line without showing it (stars). None: Ctrl+C; Some(None): skipped with Esc.
    fn ask_secret(&mut self, prompt: &str) -> Option<Option<String>> {
        self.secret = Some(prompt.into()); self.input.clear(); self.pos = 0; self.dirty = true;
        let r = loop {
            match self.pump(Duration::from_millis(100), None) {
                Some(Got::Line(l)) => break Some(Some(l)),
                Some(Got::Skip) => break Some(None),
                Some(Got::Stop) => break None,
                None => {}
            }
        };
        self.secret = None; self.dirty = true;
        r
    }
}

/// Puts the terminal back: normal screen, line input, the usual cursor.
fn restore() {
    let mut o = std::io::stdout();
    let _ = crossterm::execute!(o, cursor::SetCursorStyle::DefaultUserShape, cursor::Show, terminal::LeaveAlternateScreen);
    #[cfg(not(windows))] { let _ = crossterm::execute!(o, event::DisableBracketedPaste); }
    let _ = terminal::disable_raw_mode();
}

/// The supervisor with the screen: starts the server as its child, restarts it after a crash, draws everything.
/// None: this terminal cannot be put in raw mode (the caller uses the plain window instead).
pub fn supervise(data: PathBuf, exe: PathBuf, args: Vec<String>) -> Option<ExitCode> {
    crate::ticker::console_prepare();
    if terminal::enable_raw_mode().is_err() { return None; }
    let mut o = std::io::stdout();
    let _ = crossterm::execute!(o, terminal::EnterAlternateScreen, terminal::SetTitle("Sushila"), cursor::SetCursorStyle::BlinkingBlock, cursor::Show);
    #[cfg(not(windows))] { let _ = crossterm::execute!(o, event::EnableBracketedPaste); }
    let hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |i| { restore(); hook(i); }));
    let (tx, rx) = mpsc::channel();
    { let tx = tx.clone(); std::thread::spawn(move || loop { match event::read() { Ok(e) => { if tx.send(Ev::Key(e)).is_err() { return; } } Err(_) => std::thread::sleep(Duration::from_millis(50)) } }); }
    let mut s = Screen { pane: Pane::new(), input: vec![], pos: 0, history: vec![], hpos: None, secret: None, back: 0,
        feed: crate::ticker::Feed::new(data.clone()), ticker_on: !crate::ticker::off_setting(&crate::webserver::read_state(&data)["settings"]["ticker"]),
        port: 8765, data: data.clone(), prev: vec![], cursor: (0, 0), dirty: true, tick: Instant::now(), port_read: Instant::now() - Duration::from_secs(60),
        rx, tx, out: std::io::stdout(), stopping: false, ready: false };
    s.note(&format!("Sushila {}: starting the server. Type a command or a question below; ? lists the important commands.", env!("CARGO_PKG_VERSION")));
    let code = run(&mut s, &data, &exe, &args);
    restore();
    // what stays in the normal window after the screen closes: the last lines (an error, or that it stopped)
    for (_, t) in s.pane.rows(Screen::size().0, 12) { eprintln!("{t}"); }
    Some(code)
}

fn run(s: &mut Screen, data: &Path, exe: &Path, args: &[String]) -> ExitCode {
    // the Admin password, asked here (the server under the screen has no terminal to ask in)
    if !crate::webserver::password_set(data) {
        s.note(&format!("First start: choose the admin password for the Admin tab of the web page (at least 8 characters; Esc = later, on the Admin page). Lost it later? Delete {} and restart: it is asked again.", data.join("adminpassword").display()));
        for _ in 0..3 {
            let Some(a) = s.ask_secret("Admin password: ") else { return ExitCode::SUCCESS };
            let Some(a) = a else { s.note("no password yet: set it on the Admin page (this computer only)"); break };
            let Some(b) = s.ask_secret("Again: ") else { return ExitCode::SUCCESS };
            let Some(b) = b else { s.note("no password yet: set it on the Admin page (this computer only)"); break };
            if a != b { s.note("The two do not match; try again."); continue; }
            match crate::webserver::set_password(data, &a) { Ok(()) => { s.note("Admin password saved."); break; } Err(e) => s.note(&e) }
        }
    }
    let mut recent: Vec<Instant> = vec![];
    let mut restarts = 0u32;
    loop {
        let (reader, writer) = match os_pipe::pipe() { Ok(p) => p, Err(e) => { s.note(&format!("could not start the server: {e}")); return hold(s, 1); } };
        let mut c = Command::new(exe);
        c.args(args).env("SUSHILA_WORKER", "1").env("SUSHILA_UI", "1").stdin(Stdio::piped());
        match writer.try_clone() { Ok(w2) => { c.stdout(w2).stderr(writer); } Err(e) => { s.note(&format!("could not start the server: {e}")); return hold(s, 1); } }
        if restarts > 0 { c.env("SUSHILA_NO_BROWSER", "1"); }
        let t0 = Instant::now();
        s.ready = false;
        let mut child = match c.spawn() { Ok(ch) => ch, Err(e) => { s.note(&format!("could not start the server: {e}")); return hold(s, 1); } };
        drop(c);  // the parent's copies of the pipe's write end: the reader sees the end when the server's are closed
        { let tx = s.tx.clone(); let mut r = reader; std::thread::spawn(move || { let mut b = [0u8; 8192]; loop { match r.read(&mut b) { Ok(0) | Err(_) => { let _ = tx.send(Ev::OutEnd); return; } Ok(n) => { if tx.send(Ev::Out(b[..n].to_vec())).is_err() { return; } } } } }); }
        let mut stop_at: Option<Instant> = None;
        let status = loop {
            match s.pump(Duration::from_millis(30), Some(&mut child)) {
                Some(Got::Stop) => {
                    if stop_at.is_some() { s.note("stopping now"); let _ = child.kill(); }
                    else { s.stopping = true; stop_at = Some(Instant::now()); s.note("stopping... (Ctrl+C again stops at once)"); let _ = std::fs::write(data.join("shutdown-request.json"), "{}"); }
                }
                Some(Got::Line(l)) if ["stop", "quit", "exit", "q"].contains(&l.to_lowercase().as_str()) => { s.stopping = true; stop_at.get_or_insert(Instant::now()); }
                _ => {}
            }
            if stop_at.map(|t| t.elapsed() > Duration::from_secs(20)).unwrap_or(false) { let _ = child.kill(); }
            if let Ok(Some(st)) = child.try_wait() { break st; }
        };
        // the rest of its output (the pipe ends when the server and the commands it started are gone)
        let until = Instant::now() + Duration::from_millis(400);
        while Instant::now() < until { s.pump(Duration::from_millis(20), None); }
        let up = t0.elapsed();
        if status.success() || s.stopping { s.note("Sushila stopped."); s.render(); return ExitCode::SUCCESS; }
        if status.code() == Some(crate::START_FAILED as i32) || (restarts == 0 && up < Duration::from_secs(8) && status.code() == Some(1)) {
            s.note("Sushila did not start. Fix the problem above and start it again (downloads resume where they stopped).");
            return hold(s, 1);
        }
        let msg = crate::server_crashed(data, &status, up);
        recent.retain(|t| t.elapsed() < Duration::from_secs(300)); recent.push(Instant::now());
        let wait = if recent.len() > 5 { 60 } else { 1 };
        s.note(&format!("{msg}; restarting in {wait} s (details: Admin tab -> Logs -> Crashes)"));
        restarts += 1;
        let until = Instant::now() + Duration::from_secs(wait);
        while Instant::now() < until { if let Some(Got::Stop) = s.pump(Duration::from_millis(50), None) { return ExitCode::SUCCESS; } }
    }
}
/// Keeps the screen until Enter or Ctrl+C, so the message can be read (a double-clicked window closes at the end).
fn hold(s: &mut Screen, code: u8) -> ExitCode {
    s.note("Press Enter to close.");
    loop { if let Some(Got::Line(_) | Got::Stop) = s.pump(Duration::from_millis(100), None) { return ExitCode::from(code); } }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn texts(p: &Pane) -> Vec<String> { p.lines.iter().map(|l| l.text.clone()).collect() }
    #[test] fn output_is_cleaned() {
        let mut p = Pane::new();
        p.feed(b"\x1b[1;36mhello\x1b[0m\n\n\n  \nworld\r\n");
        assert_eq!(texts(&p), vec!["hello", "world"], "colors removed, blank lines dropped, CRLF ends a line");
        p.feed(b"  file: [##..] 10%"); p.feed(b"\r  file: [###.] 70%");
        assert_eq!(texts(&p).last().unwrap(), "  file: [###.] 70%");
        p.feed(b"\r     \r"); p.feed(b"  file: done\n");
        assert_eq!(texts(&p), vec!["hello", "world", "  file: done"], "a progress line is replaced, not stacked");
        p.feed(b"Run this? [y/N] "); p.add("sushila> y", Kind::Typed); p.feed(b"not run.\n");
        assert_eq!(texts(&p), vec!["hello", "world", "  file: done", "Run this? [y/N]", "sushila> y", "not run."], "the answer goes below its question");
        p.feed(b"\r  bar 10%"); p.add("sushila> ps", Kind::Typed);
        assert_eq!(texts(&p)[6..], ["sushila> ps", "  bar 10%"], "typed during a progress bar: above the bar, which keeps going");
        p.feed(b"\r  bar done\n");
        p.feed("caf\u{e9}".as_bytes().split_at(4).0); p.feed(&"caf\u{e9}".as_bytes()[4..]); p.feed(b"\n");
        assert_eq!(texts(&p).last().unwrap(), "caf\u{e9}", "a character cut by the pipe is joined");
        p.feed(b"\x1b]52;c;aGk=\x07x\n");
        assert_eq!(p.clipboard, vec!["52;c;aGk="]); assert_eq!(texts(&p).last().unwrap(), "x");
    }
    #[test] fn rows_wrap() {
        assert_eq!(wrap("abcdef", 4), vec!["abcd", "ef"]); assert_eq!(wrap("", 4), vec![""]);
        assert_eq!(wrap("the important commands", 15), vec!["the important", "commands"]);
        let mut p = Pane::new(); p.feed(b"one\ntwo three\nfour\n");
        let r: Vec<String> = p.rows(5, 2).into_iter().map(|r| r.1).collect();
        assert_eq!(r[r.len() - 2..], ["three", "four"], "the newest rows, wrapped between words at 5 columns");
    }
}
