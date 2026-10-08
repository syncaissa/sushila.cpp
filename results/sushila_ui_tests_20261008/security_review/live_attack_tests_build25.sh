# live attack tests against build 25 (run on the pod)
B=/root/sb/cli/target/release/sushila; D=/root/h25; K=$(cat /root/key25); IP=$(ip -4 addr show | grep -o "inet 1[0-9.]*" | grep -v 127 | head -1 | cut -d" " -f2)

for i in $(seq 1 60); do grep -q "is ready on port" /root/s25b.log && break; sleep 5; done
T=$(python3 -c "import json;print(json.load(open('$D/state.json'))['token'])")
c() { curl -s -o /tmp/body -w "%{http_code}" "$@"; }
pass=0; fail=0; chk() { if [ "$1" = "$2" ]; then echo "ok   $3 ($1)"; pass=$((pass+1)); else echo "FAIL $3 (got $1, want $2) $(head -c 160 /tmp/body)"; fail=$((fail+1)); fi; }
grep -q "took over" /root/s25b.log && echo "info: build 25 took over from the running one"
chk $(c -H "authorization: Bearer $K" "http://$IP:7874/v1/models") 200 "a key holder: the models list works"
chk $(c -H "authorization: Bearer $K" -H "content-type: application/json" -d '{"messages":[{"role":"user","content":"say hi"}],"max_tokens":5}' "http://$IP:7874/v1/chat/completions") 200 "a key holder: chat works"
chk $(c -H "authorization: Bearer $K" "http://$IP:7874/v1/music@127.0.0.1:7874/") 404 "SSRF /v1/music@127.0.0.1:7874/ refused"
chk $(c -H "authorization: Bearer $K" "http://$IP:7874/v1/music@169.254.169.254/latest/meta-data/") 404 "SSRF to cloud metadata refused"
chk $(c -H "authorization: Bearer $K" "http://$IP:7874/v1/video@127.0.0.1:7874/x") 404 "SSRF via /v1/video@ refused"
chk $(c -H "authorization: Bearer $K" "http://$IP:7874/v1/music/slots") 404 "other model-server paths refused"
chk $(c -H "authorization: Bearer $K" "http://$IP:7874/v1/music%40127.0.0.1:7874/") 404 "encoded @ refused"
chk $(curl -s -o /tmp/body -H "authorization: Bearer $K" "http://$IP:7874/api/admin" -o /dev/null; grep -o '"loggedIn":true' /tmp/body >/dev/null && echo yes || echo no) no "a key holder is never admin"
# requests as they arrive through cloudflared: from 127.0.0.1, with Cloudflare headers and the tunnel host
TH="Host: abc-def-ghi.trycloudflare.com"; CF="cf-connecting-ip: 203.0.113.9"
chk $(curl -s -o /tmp/body -H "$TH" -H "$CF" -H "x-sushila-token: $T" http://127.0.0.1:7874/api/admin; grep -q '"loggedIn":true' /tmp/body && echo admin || echo no) no "tunnel request with the stolen local token: not admin"
chk $(curl -s -o /tmp/body -H "$TH" -H "x-sushila-token: $T" http://127.0.0.1:7874/api/admin; grep -q '"loggedIn":true' /tmp/body && echo admin || echo no) no "tunnel host without Cloudflare headers + local token: not admin"
chk $(curl -s -o /tmp/body -H "$TH" -H "$CF" http://127.0.0.1:7874/; grep -q SUSHILA_TOKEN /tmp/body && echo leak || echo none) none "the page through the tunnel never carries the local token"
# media tokens: files only, one hour
M=$(curl -s -H "x-sushila-token: $T" http://127.0.0.1:7874/api/media-token | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")
chk $(c "http://127.0.0.1:7874/api/library?t=$M") 403 "media token: never the Library list"
chk $(c "http://127.0.0.1:7874/api/library/file?rel=images/none.png&t=$M") 404 "media token: a file (passes the check, the file does not exist)"
chk $(c "http://127.0.0.1:7874/api/library/file?rel=images/none.png&t=media.1.abc") 403 "a forged media token: refused"
chk $(c -H "$TH" -H "$CF" "http://127.0.0.1:7874/api/media-token") 403 "no media token for a tunnel request without the owner pass"
# this computer's state: no CORS for other sites; admin needs the token
chk $(curl -s -D - -o /dev/null -H "x-sushila-token: $T" -H "origin: https://evil.example" http://127.0.0.1:7874/api/state | grep -ci "access-control-allow-origin") 0 "this computer's full state is not readable by other sites"
chk $(c -X POST -H "content-type: text/plain" -d '{"action":"settings","values":{}}' http://127.0.0.1:7874/api/control) 401 "a simple cross-site POST to /api/control (no token): refused"
chk $(curl -s -o /tmp/body -H "x-sushila-token: $T" http://127.0.0.1:7874/api/admin; grep -q '"loggedIn":true' /tmp/body && echo admin || echo no) admin "this computer's own page: admin, no password"
echo "RESULT pass=$pass fail=$fail"
