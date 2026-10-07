// The server window (`sushila serve` in a terminal, or a double-click), in the terminal's normal flow: everything the
// server and the commands typed here print becomes ordinary lines of the terminal, so its own scroll bar, mouse wheel,
// selection and copy work on every system and nothing is lost. Only the last rows are kept live and redrawn: the
// progress bars, the input line "sushila> " and the ticker. The server runs as this process's child with its output
// in a pipe, so nothing else writes to the terminal and a log line can never land in the middle of the typing; keys
// are read one at a time (raw mode).
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
/// The ticker's pace: one character every 0.44 s (about 2 a second).
const TICK: Duration = Duration::from_millis(440);

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind { Text, Typed, Note }
#[derive(Debug)]
pub struct Line { pub text: String, pub kind: Kind }
enum Esc { None, Start, Csi, Osc(String), OscEnd(String) }

/// The output, cleaned: finished lines wait in `lines` until they are printed; the line still being written (a question
/// waiting for its answer, or a line rewritten with \r) is `open`. Escape sequences are removed (OSC 52, the clipboard,
/// is passed on; OSC 7770 is a progress event), blank lines are dropped.
/// `bar`: the open line is rewritten with \r, so lines from the screen go before it; otherwise (a question) after it.
pub struct Pane { pub lines: Vec<Line>, pub open: Option<String>, bar: bool, cr: bool, esc: Esc, utf: Vec<u8>, pub clipboard: Vec<String>, pub progress: Vec<serde_json::Value>, pub signals: Vec<String> }
impl Pane {
    pub fn new() -> Self { Pane { lines: vec![], open: None, bar: false, cr: false, esc: Esc::None, utf: vec![], clipboard: vec![], progress: vec![], signals: vec![] } }
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
    /// OSC 52: the clipboard (passed on); OSC 7770: a progress event of a download (util.rs), drawn as a bar row.
    fn osc(&mut self, o: String) {
        if o.starts_with("52;") { self.clipboard.push(o); }
        else if let Some(j) = o.strip_prefix("7770;") { if let Ok(v) = serde_json::from_str(j) { self.progress.push(v); } }
        // OSC 7771: the server's window loop: "idle" (ready for the next line) or "ask" (waits for an answer)
        else if let Some(x) = o.strip_prefix("7771;") { self.signals.push(x.to_string()); }
    }
    fn push(&mut self, c: char) {
        // a line started or rewritten after \r is a progress line
        let cr = std::mem::take(&mut self.cr);
        match &mut self.open {
            Some(t) => { if cr { t.clear(); self.bar = true; } t.push(c); }
            None => { self.open = Some(c.to_string()); self.bar = cr; }
        }
    }
    fn end_line(&mut self) {
        self.cr = false;
        if let Some(t) = self.open.take() {
            let t = t.trim_end();
            if !t.trim().is_empty() { self.lines.push(Line { text: t.to_string(), kind: Kind::Text }); }
        }
    }
    /// A line from the screen itself (what was typed, a note): after an open question, before an open progress line.
    pub fn add(&mut self, text: &str, kind: Kind) {
        if self.open.is_some() && !self.bar { self.end_line(); }
        for t in text.lines().filter(|t| !t.trim().is_empty()) { self.lines.push(Line { text: t.trim_end().to_string(), kind }); }
    }
    /// The open line, when it has text.
    pub fn open_text(&self) -> Option<&str> { self.open.as_deref().filter(|t| !t.trim().is_empty()) }
}
fn width(s: &str) -> usize { s.chars().map(|c| c.width().unwrap_or(0)).sum() }
/// At most `cols` columns (a live row must never wrap).
fn cut(s: &str, cols: usize) -> String {
    let mut w = 0;
    s.chars().take_while(|c| { w += c.width().unwrap_or(0); w <= cols }).collect()
}

enum Ev { Key(Event), Out(Vec<u8>), OutEnd }
enum Got { Line(String), Stop, Skip }

struct Screen {
    pane: Pane, input: Vec<char>, pos: usize, history: Vec<String>, hpos: Option<usize>, secret: Option<String>,
    feed: crate::ticker::Feed, ticker_on: bool, port: u16, data: PathBuf,
    up: u16,  // rows of the live part above the input line (to find its top again)
    dirty: bool, tick: Instant, port_read: Instant, step: bool,
    rx: mpsc::Receiver<Ev>, tx: mpsc::Sender<Ev>, out: std::io::Stdout, stopping: bool,
    ready: bool,  // the server reads typed lines (its address banner was shown)
    bars: Vec<(String, String, Option<f64>, Instant)>,  // progress rows above the input line: id, text, fraction, last update
    busy: Option<Instant>,  // a typed line is being processed (until the server says it is done)
    spin: Instant,
    queue: std::collections::VecDeque<String>,  // lines entered while busy: run in order when it is done
}

impl Screen {
    fn note(&mut self, s: &str) { crate::core::log(true, s); self.pane.add(s, Kind::Note); self.dirty = true; }
    fn size() -> (usize, usize) { terminal::size().map(|(c, r)| (c.max(20) as usize, r.max(3) as usize)).unwrap_or((80, 24)) }

    /// Erases the live rows, prints the finished lines (they scroll into the terminal's history like any output), and
    /// draws the live rows again: the open line, the progress bars, the input line, the ticker.
    fn render(&mut self) {
        let (cols, rows) = Self::size();
        let o = &mut self.out;
        let _ = queue!(o, cursor::Hide, cursor::MoveToColumn(0));
        if self.up > 0 { let _ = queue!(o, cursor::MoveUp(self.up)); }
        let _ = queue!(o, terminal::Clear(terminal::ClearType::FromCursorDown));
        for l in self.pane.lines.drain(..) {
            match l.kind {
                Kind::Typed => { let _ = queue!(o, style::SetForegroundColor(style::Color::Cyan), style::Print(&l.text), style::ResetColor); }
                Kind::Note => { let _ = queue!(o, style::SetForegroundColor(style::Color::Yellow), style::Print(&l.text), style::ResetColor); }
                Kind::Text => { let _ = queue!(o, style::Print(&l.text)); }
            }
            let _ = queue!(o, style::Print("\r\n"));
        }
        // the live rows (never more than the window minus 2)
        let mut up = 0u16;
        let room = rows.saturating_sub(3);
        if let Some(t) = self.pane.open_text() { if room > 0 { let _ = queue!(o, style::Print(cut(t, cols - 1)), style::Print("\r\n")); up += 1; } }
        self.bars.retain(|b| b.3.elapsed() < Duration::from_secs(60));
        for (_, text, frac, _) in self.bars.iter().take(3) {
            if (up as usize) >= room { break; }
            let line = crate::ticker::fit(&format!("{} {}", crate::ticker::bar(*frac, 20), text.trim_start()), cols - 1);
            let _ = queue!(o, style::SetForegroundColor(style::Color::Green), style::Print(line.trim_end()), style::ResetColor, style::Print("\r\n"));
            up += 1;
        }
        // the input line: the prompt, then the typed text (stars for a password), scrolled sideways when long
        let prompt = self.secret.clone().unwrap_or_else(|| PROMPT.into());
        let shown: Vec<char> = if self.secret.is_some() { vec!['*'; self.input.len()] } else { self.input.clone() };
        let space = cols.saturating_sub(width(&prompt) + 1).max(5);
        let before: usize = shown[..self.pos].iter().map(|c| c.width().unwrap_or(0)).sum();
        let (mut start, mut skipped) = (0, 0);
        while before - skipped >= space && start < self.pos { skipped += shown[start].width().unwrap_or(0); start += 1; }
        let mut vis = String::new(); let mut w = 0;
        for c in &shown[start..] { let cw = c.width().unwrap_or(0); if w + cw > space { break; } vis.push(*c); w += cw; }
        let busy = self.busy.map(|t| t.elapsed().as_secs());
        let mut busy_col = 0u16;
        if let Some(secs) = busy {
            const SPIN: [char; 10] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
            let f = (self.spin.duration_since(self.busy.unwrap()).as_millis() / 150) as usize % SPIN.len();
            let q = if self.queue.is_empty() { String::new() } else { format!(", {} waiting", self.queue.len()) };
            let msg = format!("{} processing request... {secs} s (Ctrl+C cancels{q}) > ", SPIN[f]);
            let typed: String = self.input.iter().collect();
            let line = cut(&format!("{msg}{typed}"), cols - 1);
            let mw = width(&msg).min(width(&line));
            let (m, t): (String, String) = (line.chars().take(msg.chars().count().min(line.chars().count())).collect(), line.chars().skip(msg.chars().count()).collect());
            let _ = queue!(o, style::SetForegroundColor(style::Color::Yellow), style::SetAttribute(style::Attribute::Bold), style::Print(m),
                style::SetAttribute(style::Attribute::Reset), style::ResetColor, style::Print(&t));
            busy_col = mw.saturating_add(width(&t)).min(cols - 1) as u16;
        } else {
            let _ = queue!(o, style::SetForegroundColor(style::Color::Cyan), style::SetAttribute(style::Attribute::Bold), style::Print(&prompt),
                style::SetAttribute(style::Attribute::Reset), style::ResetColor, style::Print(&vis));
        }
        let col = if busy.is_some() { busy_col } else { (width(&prompt) + before - skipped) as u16 };
        if self.ticker_on && rows >= 5 {
            let text = self.ticker_text(cols);
            let _ = queue!(self.out, style::Print("\r\n"), style::SetAttribute(style::Attribute::Reverse), style::Print(text), style::SetAttribute(style::Attribute::Reset), cursor::MoveUp(1));
        }
        let _ = queue!(self.out, cursor::MoveToColumn(col), cursor::Show);
        let _ = self.out.flush();
        self.up = up;
        self.dirty = false;
    }
    fn ticker_text(&mut self, cols: usize) -> String {
        if self.port_read.elapsed() > Duration::from_secs(5) {
            self.port_read = Instant::now();
            let st = crate::webserver::read_state(&self.data);
            self.port = st["owner"]["port"].as_u64().or(st["settings"]["port"].as_u64()).unwrap_or(8765) as u16;
            if !crate::ticker::on_setting(&st["settings"]["ticker"]) { self.ticker_on = false; }
        }
        self.feed.next(self.port, cols - 1, std::mem::take(&mut self.step))
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
                Ev::Out(b) => {
                    self.pane.feed(&b); self.dirty = true;
                    for v in std::mem::take(&mut self.pane.progress) {
                        let id = v["id"].as_str().unwrap_or("").to_string();
                        if v["done"] == true { self.bars.retain(|b| b.0 != id); continue; }
                        let (text, frac) = (v["text"].as_str().unwrap_or("").to_string(), v["frac"].as_f64());
                        match self.bars.iter_mut().find(|b| b.0 == id) { Some(b) => { b.1 = text; b.2 = frac; b.3 = Instant::now(); } None => self.bars.push((id, text, frac, Instant::now())) }
                    }
                    if !self.ready && self.pane.lines.iter().any(|l| l.text.contains(" is running")) { self.ready = true; }
                    for sig in std::mem::take(&mut self.pane.signals) { if sig == "idle" { self.ready = true; } self.busy = None; }
                    // done: the next line typed ahead runs now
                    if self.busy.is_none() && self.secret.is_none() {
                        if let Some(next) = self.queue.pop_front() {
                            let keep = std::mem::replace(&mut self.input, next.chars().collect());
                            if let Some(g) = self.submit(stdin.as_deref_mut()) { got = Some(g); }
                            self.input = keep; self.pos = self.pos.min(self.input.len());
                        }
                    }
                }
                Ev::OutEnd => {}
                Ev::Key(Event::Resize(..)) => self.dirty = true,
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
        // while busy the message moves (spinner and seconds), so it is clear the window is working
        if self.busy.is_some() && self.spin.elapsed() >= Duration::from_millis(150) { self.spin = Instant::now(); self.dirty = true; }
        // the ticker moves one character every 0.44 s, however often the rows are drawn
        if self.ticker_on && self.tick.elapsed() >= TICK { self.tick = Instant::now(); self.step = true; self.dirty = true; }
        if self.dirty { self.render(); }
        got
    }
    fn key(&mut self, k: event::KeyEvent, stdin: Option<&mut std::process::ChildStdin>) -> Option<Got> {
        let ctrl = k.modifiers == KeyModifiers::CONTROL;
        // processing: typing goes on (shown after the message); Enter queues the line, it runs when this one is done;
        // Ctrl+C cancels the running command (the server's window loop sees the file)
        if self.busy.is_some() {
            if ctrl && k.code == KeyCode::Char('c') {
                let _ = std::fs::write(self.data.join("window-cancel"), "");
                self.note("cancelling... (a command is stopped; an answer that is being written ends by itself in a moment)");
                return None;
            }
            if k.code == KeyCode::Enter {
                let l: String = std::mem::take(&mut self.input).into_iter().collect();
                self.pos = 0;
                if !l.trim().is_empty() { self.queue.push_back(l.trim().to_string()); }
                return None;
            }
        }
        match k.code {
            KeyCode::Char('c') if ctrl => { if !self.input.is_empty() { self.input.clear(); self.pos = 0; return None; } return Some(Got::Stop); }
            KeyCode::Char('u') if ctrl => { self.input.drain(..self.pos); self.pos = 0; }
            KeyCode::Char('a') if ctrl => self.pos = 0,
            KeyCode::Char('e') if ctrl => self.pos = self.input.len(),
            // Ctrl+V reaches the program in some terminals instead of pasting there: the clipboard is read and typed in
            KeyCode::Char('v') if ctrl => { for c in crate::window::from_clipboard().chars().filter(|c| !c.is_control() || *c == ' ') { self.input.insert(self.pos, c); self.pos += 1; } }
            KeyCode::Char(_) if ctrl => {}
            KeyCode::Char(c) => { self.input.insert(self.pos, c); self.pos += 1; self.hpos = None; }
            KeyCode::Backspace => if self.pos > 0 { self.pos -= 1; self.input.remove(self.pos); },
            KeyCode::Delete => if self.pos < self.input.len() { self.input.remove(self.pos); },
            KeyCode::Left => self.pos = self.pos.saturating_sub(1),
            KeyCode::Right => self.pos = (self.pos + 1).min(self.input.len()),
            KeyCode::Home => self.pos = 0,
            KeyCode::End => self.pos = self.input.len(),
            KeyCode::Up | KeyCode::Down if self.secret.is_none() && !self.history.is_empty() => {
                let n = self.history.len();
                let h = match (k.code, self.hpos) { (KeyCode::Up, None) => Some(n - 1), (KeyCode::Up, Some(i)) => Some(i.saturating_sub(1)),
                    (_, Some(i)) if i + 1 < n => Some(i + 1), _ => None };
                self.hpos = h;
                self.input = h.map(|i| self.history[i].chars().collect()).unwrap_or_default(); self.pos = self.input.len();
            }
            KeyCode::Esc => { self.input.clear(); self.pos = 0; if self.secret.is_some() { return Some(Got::Skip); } }
            KeyCode::Enter => return self.submit(stdin),
            _ => {}
        }
        None
    }
    fn submit(&mut self, stdin: Option<&mut std::process::ChildStdin>) -> Option<Got> {
        let line: String = std::mem::take(&mut self.input).into_iter().collect();
        self.pos = 0; self.hpos = None;
        if self.secret.is_some() { return Some(Got::Line(line)); }
        let t = line.trim().to_string();
        if t.is_empty() { return Some(Got::Line(t)); }  // Enter alone: nothing to run (hold() waits for it)
        if self.history.last() != Some(&t) { self.history.push(t.clone()); }
        self.pane.add(&format!("{PROMPT}{t}"), Kind::Typed);
        match t.to_lowercase().as_str() {
            "ticker off" => { self.ticker_on = false; self.note("ticker off (ticker on shows it again; sushila config set ticker off keeps it off)"); }
            "ticker on" => self.ticker_on = true,
            "clear" | "cls" => { let _ = queue!(self.out, terminal::Clear(terminal::ClearType::Purge), terminal::Clear(terminal::ClearType::All), cursor::MoveTo(0, 0)); self.pane.lines.clear(); self.up = 0; }
            _ => match stdin {
                Some(i) => {
                    if !self.ready { self.note("the server is still starting: this runs as soon as it is up"); }
                    self.busy = Some(Instant::now());
                    if i.write_all(format!("{t}\n").as_bytes()).and_then(|_| i.flush()).is_err() { self.note("the server is not reading input right now; try again in a moment"); }
                }
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
    /// The live rows erased (the lines above stay in the terminal), for the end.
    fn close(&mut self) {
        self.bars.clear(); self.ticker_on = false; self.secret = None; self.input.clear(); self.pos = 0;
        if let Some(t) = self.pane.open.take() { if !t.trim().is_empty() { self.pane.lines.push(Line { text: t, kind: Kind::Text }); } }
        self.render();
        let _ = queue!(self.out, cursor::MoveToColumn(0), terminal::Clear(terminal::ClearType::FromCursorDown));
        let _ = self.out.flush();
    }
}

/// Puts the terminal back: line input, the usual cursor.
fn restore() {
    let mut o = std::io::stdout();
    let _ = crossterm::execute!(o, cursor::SetCursorStyle::DefaultUserShape, cursor::Show);
    #[cfg(not(windows))] { let _ = crossterm::execute!(o, event::DisableBracketedPaste); }
    let _ = terminal::disable_raw_mode();
}

/// The supervisor with the screen: starts the server as its child, restarts it after a crash, draws everything.
/// None: this terminal cannot be put in raw mode (the caller uses the plain window instead).
pub fn supervise(data: PathBuf, exe: PathBuf, args: Vec<String>) -> Option<ExitCode> {
    crate::ticker::console_prepare();
    if terminal::enable_raw_mode().is_err() { return None; }
    let mut o = std::io::stdout();
    let _ = crossterm::execute!(o, terminal::SetTitle("Sushila"), cursor::SetCursorStyle::BlinkingBlock, cursor::Show, cursor::MoveToColumn(0));
    #[cfg(not(windows))] { let _ = crossterm::execute!(o, event::EnableBracketedPaste); }
    let hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |i| { restore(); hook(i); }));
    let (tx, rx) = mpsc::channel();
    { let tx = tx.clone(); std::thread::spawn(move || loop { match event::read() { Ok(e) => { if tx.send(Ev::Key(e)).is_err() { return; } } Err(_) => std::thread::sleep(Duration::from_millis(50)) } }); }
    let mut s = Screen { pane: Pane::new(), input: vec![], pos: 0, history: vec![], hpos: None, secret: None,
        feed: crate::ticker::Feed::new(data.clone()), ticker_on: crate::ticker::on_setting(&crate::webserver::read_state(&data)["settings"]["ticker"]),
        port: 8765, data: data.clone(), up: 0, dirty: true, tick: Instant::now(), port_read: Instant::now() - Duration::from_secs(60), step: false,
        rx, tx, out: std::io::stdout(), stopping: false, ready: false, bars: vec![], busy: None, spin: Instant::now(), queue: Default::default() };
    s.note(&format!("Sushila {}: starting the server. Type a command or a question below; ? lists the important commands.", env!("CARGO_PKG_VERSION")));
    let code = run(&mut s, &data, &exe, &args);
    s.close();
    restore();
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
        if status.success() || s.stopping { s.note("Sushila stopped."); return ExitCode::SUCCESS; }
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
    fn texts(p: &Pane) -> Vec<String> { p.lines.iter().map(|l| l.text.clone()).chain(p.open_text().map(String::from)).collect() }
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
        assert_eq!(texts(&p)[6..], ["sushila> ps", "  bar 10%"], "typed during a progress bar: before the bar, which keeps going");
        p.feed(b"\r  bar done\n");
        p.feed("caf\u{e9}".as_bytes().split_at(4).0); p.feed(&"caf\u{e9}".as_bytes()[4..]); p.feed(b"\n");
        assert_eq!(texts(&p).last().unwrap(), "caf\u{e9}", "a character cut by the pipe is joined");
        p.feed(b"\x1b]52;c;aGk=\x07x\n");
        assert_eq!(p.clipboard, vec!["52;c;aGk="]); assert_eq!(texts(&p).last().unwrap(), "x");
        p.feed(b"\x1b]7770;{\"id\":\"j\",\"text\":\"pack: 40%\",\"frac\":0.4}\x07");
        assert_eq!(p.progress.len(), 1); assert_eq!(p.progress[0]["frac"], 0.4); assert_eq!(texts(&p).last().unwrap(), "x", "a progress event adds no line");
    }
    #[test] fn cuts() { assert_eq!(cut("abcdef", 4), "abcd"); assert_eq!(cut("ab", 4), "ab"); assert_eq!(width("a█"), 2); }
}
