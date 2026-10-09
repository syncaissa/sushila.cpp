// Network rules of the sushila command: where downloads may come from, and the HTTP client that enforces it on every
// redirect.
use std::time::Duration;

fn err<E: std::fmt::Display>(e: E) -> String { e.to_string() }

/// "SushilaHostStation/0.1.0 (windows; x86_64)": sushila.ai counts downloads per system from it (no other data is sent).
pub static AGENT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
pub fn ua() -> String {
    let name = AGENT.get().cloned().unwrap_or_else(|| format!("SushilaHostStation/{}", env!("CARGO_PKG_VERSION")));
    format!("{name} ({}; {})", std::env::consts::OS, std::env::consts::ARCH)
}
/// Where Host Station may download from, checked here (not in the page) for the first request and every redirect:
///   https://sushila.ai                         the catalog
///   https://files.sushila.ai/public/...      the public folder of Sushila's storage, and only that folder
///   https://huggingface.co, *.huggingface.co, *.hf.co    Hugging Face and its file CDNs
///   https://registry.ollama.ai, ollama.com, and Ollama's registry storage (one Cloudflare R2 bucket, /ollama/)
///   http://127.0.0.1, localhost                this computer's own model servers (http_text only)
/// Everything installed must also match a Sushila-signed index (sha256), wherever it comes from.
pub const OLLAMA_STORAGE: &str = "dd20bb891979d25aebc8bec07b2b3bbc.r2.cloudflarestorage.com";
tokio::task_local! {
    /// Set (true) only around a download the person asked for themselves ("Install Unlisted Model Pack"): GitHub and
    /// Dropbox are allowed too, for that download only. Every other download keeps the list above.
    pub static USER_SOURCE: bool;
}
/// GitHub (release assets, raw files) and Dropbox (shared links) and their file servers: for user-chosen models only.
pub fn allowed_user_host(u: &reqwest::Url) -> bool {
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    u.scheme() == "https" && (host == "github.com" || host == "raw.githubusercontent.com" || host == "objects.githubusercontent.com"
        || host == "release-assets.githubusercontent.com" || host == "www.dropbox.com" || host == "dropbox.com" || host == "dl.dropboxusercontent.com"
        || (host.ends_with(".dl.dropboxusercontent.com") && host.matches('.').count() == 3))
}
pub fn allowed_url(u: &reqwest::Url, local_ok: bool) -> bool {
    if USER_SOURCE.try_with(|v| *v).unwrap_or(false) && allowed_user_host(u) { return true; }
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    if local_ok && u.scheme() == "http" && (host == "127.0.0.1" || host == "localhost") { return true; }
    if u.scheme() != "https" { return false; }
    let under = |d: &str| host == d || host.ends_with(&format!(".{d}"));
    host == "sushila.ai" || host == "www.sushila.ai"
        || (host == "files.sushila.ai" && u.path().starts_with("/public/"))
        || under("huggingface.co") || under("hf.co")
        || host == "registry.ollama.ai" || host == "ollama.com" || host == "registry.ollama.com"
        || (host == OLLAMA_STORAGE && u.path().starts_with("/ollama/"))
}
pub fn check_url(url: &str, local_ok: bool) -> Result<reqwest::Url, String> {
    let u = reqwest::Url::parse(url).map_err(|_| format!("not a valid address: {url}"))?;
    if allowed_url(&u, local_ok) { Ok(u) } else {
        Err(format!("Host Station only downloads from sushila.ai, files.sushila.ai, Hugging Face and Ollama; refusing {}", u.host_str().unwrap_or("?")))
    }
}

pub fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().user_agent(ua()).connect_timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() > 5 { attempt.error("too many redirects") }
            else if allowed_url(attempt.url(), false) { attempt.follow() }
            else { let host = attempt.url().host_str().unwrap_or("?").to_string(); attempt.error(format!("redirect to a source that is not allowed: {host}")) }
        }))
        .build().map_err(err)
}

