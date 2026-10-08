for p in $(ps -eo pid,args | grep -E 'SushilaStation|/root/StA' | grep -v grep | awk '{print $1}'); do kill $p; done
HOME=/root/tA /root/sb/cli/target/release/sushila stop >/dev/null 2>&1; for i in $(seq 1 120); do curl -sf localhost:7874/health >/dev/null || break; sleep 1; done
rm -rf /root/tA; export HOME=/root/tA; mkdir -p $HOME; cd $HOME
SUSHILA_NO_BROWSER=1 /root/sushila27 serve > old.log 2>&1 &
for i in $(seq 1 30); do curl -sf localhost:7874/health >/dev/null && break; sleep 1; done; curl -s localhost:7874/health; echo
pgrep -x Xvfb >/dev/null || { Xvfb :9 -screen 0 1440x900x24 >/dev/null 2>&1 & sleep 2; }
export DISPLAY=:9 WEBKIT_DISABLE_COMPOSITING_MODE=1; eval $(dbus-launch --sh-syntax)
cp /root/sb/station/target/release/SushilaStation /root/StA; /root/StA > /root/stA.log 2>&1 &
sleep 15; import -window root /root/shotA15.png
for i in $(seq 1 400); do curl -s localhost:7874/health | grep -q '"build":28' && { echo "replaced after $((15+i)) s"; break; }; sleep 1; done
curl -s localhost:7874/health; echo; import -window root /root/shotA2.png; grep -E "stop requested|stopped$|serving on|installed$" /root/tA/.local/share/sushila/logs/sushila.log | cut -c1-90; tail -3 /root/stA.log
