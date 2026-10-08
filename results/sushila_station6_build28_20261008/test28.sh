# build 28 / Station 6 on Linux: state paths follow a moved home, /health build, Station replaces an older engine,
# a second Station copy takes over, screenshots
set -u
ok() { if eval "$1"; then echo "PASS $2"; else echo "FAIL $2"; fi; }
B=/root/sb/cli/target/release/sushila; ST=/root/sb/station/target/release/SushilaStation
ok "$B --version | grep -q '(build 28)'" "sushila --version shows build 28"
# A: a home moved by build 27 whose state.json still names the old roaming home
export HOME=/root/t28; mkdir -p $HOME; cd $HOME
NEW=$HOME/.local/share/sushila; OLD=$HOME/.local/share/ai.sushila.hoststation
mkdir -p $NEW/runtime/image-nunchaku/0.1.0/python $NEW/logs $HOME/.config/sushila; echo $NEW > $HOME/.config/sushila/home
cat > $NEW/state.json <<J
{"runtimes":{"image-nunchaku":{"version":"0.1.0","python":"$OLD/runtime/image-nunchaku/0.1.0/python/bin/python3","script":"$OLD/runtime/image-nunchaku/0.1.0/server/server.py","dir":"$OLD/runtime/image-nunchaku/0.1.0"}},"settings":{}}
J
SUSHILA_NO_BROWSER=1 $B serve > serve.log 2>&1 &
for i in $(seq 1 30); do curl -sf localhost:7874/health >/dev/null && break; sleep 1; done
ok "grep -q '$NEW/runtime/image-nunchaku/0.1.0/python/bin/python3' $NEW/state.json && ! grep -q ai.sushila.hoststation $NEW/state.json" "state.json paths follow the moved home"
ok "curl -s localhost:7874/health | grep -q '\"build\":28'" "/health reports build 28"
$B stop >/dev/null 2>&1; for i in $(seq 1 120); do curl -sf localhost:7874/health >/dev/null || break; sleep 1; done
# B: an older engine (build 27) running when Station 6 opens -> replaced by the engine inside Station
export HOME=/root/t28s; mkdir -p $HOME; cd $HOME
SUSHILA_NO_BROWSER=1 /root/sushila27 serve > old.log 2>&1 &
for i in $(seq 1 30); do curl -sf localhost:7874/health >/dev/null && break; sleep 1; done
ok "curl -s localhost:7874/health | grep -q '\"app\":\"sushila\"' && ! curl -s localhost:7874/health | grep -q '\"build\"'" "build 27 engine running (no build number)"
Xvfb :9 -screen 0 1440x900x24 >/dev/null 2>&1 & sleep 2
export DISPLAY=:9 WEBKIT_DISABLE_COMPOSITING_MODE=1
eval $(dbus-launch --sh-syntax)   # one session bus: the one-instance check of both copies meets there
mkdir -p /root/a /root/b; cp $ST /root/a/SushilaStation; cp $ST /root/b/SushilaStation
/root/a/SushilaStation > /root/a.log 2>&1 &
for i in $(seq 1 60); do curl -s localhost:7874/health | grep -q '"build":28' && break; sleep 1; done
ok "curl -s localhost:7874/health | grep -q '\"build\":28'" "Station replaced the older engine with build 28"
sleep 6; import -window root /root/shot-main.png
# C: opening another copy of Station: the running one hands over to it
/root/b/SushilaStation > /root/b.log 2>&1 &
sleep 8
ok "ps -eo args | grep -q '^/root/b/SushilaStation' && ! ps -eo args | grep -q '^/root/a/SushilaStation'" "a different Station copy replaces the running one"
ps -eo pid,args | grep SushilaStation | grep -v grep
sleep 4; import -window root /root/shot-b.png
