for p in $(ps -eo pid,args | grep -E 'SushilaStation|/root/StA|/root/StB' | grep -v grep | awk '{print $1}'); do kill $p; done
HOME=/root/tA /root/sb/cli/target/release/sushila stop >/dev/null 2>&1; for i in $(seq 1 120); do curl -sf localhost:7874/health >/dev/null || break; sleep 1; done
export HOME=/root/tA DISPLAY=:9 WEBKIT_DISABLE_COMPOSITING_MODE=1; eval $(dbus-launch --sh-syntax)
pgrep -x Xvfb >/dev/null || { Xvfb :9 -screen 0 1440x900x24 >/dev/null 2>&1 & sleep 2; }
cp /root/sb/station/target/release/SushilaStation /root/StB; /root/StB > /root/stB.log 2>&1 &
for i in $(seq 1 90); do curl -sf localhost:7874/health >/dev/null && break; sleep 1; done; sleep 12
W=$(xdotool search --name "Sushila Station" | head -1); xdotool windowmove $W 0 0; sleep 1
import -window root /root/B1-main.png
xdotool mousemove 140 135 click 1; sleep 3; import -window root /root/B2-setup.png
xdotool key Escape; sleep 1; xdotool mousemove 1240 870 click 1; sleep 1
xdotool mousemove 108 735 click 1; sleep 4; import -window root /root/B3-link.png
xdotool mousemove 108 233 click 1; sleep 3; import -window root /root/B4-images.png; xdotool mousemove 108 417 click 1; sleep 3; import -window root /root/B5-chat.png
