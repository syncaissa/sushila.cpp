#!/usr/bin/env bash
# safe_pkill: stop processes whose command line matches a pattern, but never this script, its parent shell or the
# ssh session that runs it. Plain `pkill -f <pattern>` inside `ssh host '...'` also matches the remote `bash -c`
# that carries the pattern in its own command line, kills it and drops the connection (exit code 255).
#   safe_pkill [-n] [-SIGNAL] <pattern>     -n: only list what would be stopped
# Install on a pod:  scp runpod/safe_pkill.sh root@<pod>:/usr/local/bin/safe_pkill && ssh root@<pod> chmod +x /usr/local/bin/safe_pkill
set -u
DRY=0; SIG=-TERM
while [ $# -gt 1 ]; do case "$1" in -n) DRY=1; shift;; -[A-Z0-9]*) SIG="$1"; shift;; *) break;; esac; done
PAT="${1:?usage: safe_pkill [-n] [-SIGNAL] <pattern>}"
# this process and every ancestor up to init: never touched
declare -A KEEP; p=$$
while [ -n "$p" ] && [ "$p" -gt 1 ]; do KEEP[$p]=1; p=$(awk '/^PPid:/{print $2}' /proc/$p/status 2>/dev/null); done
victims=()
for pid in $(pgrep -f -- "$PAT"); do
  [ -n "${KEEP[$pid]:-}" ] && continue
  cmd=$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null) || continue
  case "$cmd" in *safe_pkill*|sshd:*|*"bash -c"*) continue;; esac   # other helpers, ssh sessions, one-off remote shells
  victims+=("$pid")
  echo "$pid ${cmd:0:160}"
done
[ ${#victims[@]} -eq 0 ] && { echo "safe_pkill: nothing matches '$PAT'"; exit 1; }
[ $DRY = 1 ] && exit 0
kill $SIG "${victims[@]}" 2>/dev/null
sleep 2
for pid in "${victims[@]}"; do kill -0 "$pid" 2>/dev/null && echo "safe_pkill: $pid still running (try -KILL)"; done
exit 0
