# live test of build 27's folders on Linux: old home moves, the question, move, choose, the queue route
set -u
B=/root/sb/cli/target/release/sushila
export HOME=/root/t27; mkdir -p $HOME; cd $HOME
OLD=$HOME/.local/share/ai.sushila.hoststation
mkdir -p $OLD/outputs/images/2026-10-01 $OLD/outputs/music/2026-10-02 $OLD/logs
echo '{}' > $OLD/state.json
printf 'PNGDATA' > $OLD/outputs/images/2026-10-01/101010-a-cat.png
printf 'MP3DATA' > $OLD/outputs/music/2026-10-02/111111-a-song.mp3
printf '{"rel":"images/2026-10-01/101010-a-cat.png","kind":"image","prompt":"a cat"}\n{"rel":"music/2026-10-02/111111-a-song.mp3","kind":"music","prompt":"a song"}\n' > $OLD/outputs/library.jsonl
mkdir -p $HOME/.config/sushila; echo $OLD > $HOME/.config/sushila/home     # remembered old home, as on a real install
ok() { if eval "$1"; then echo "PASS $2"; else echo "FAIL $2"; fi; }
SUSHILA_NO_BROWSER=1 $B serve > serve.log 2>&1 &
for i in $(seq 1 30); do curl -sf localhost:7874/health >/dev/null && break; sleep 1; done
NEW=$HOME/.local/share/sushila
ok "[ -d $NEW/outputs/images ] && [ ! -d $OLD ]" "old home moved to ~/.local/share/sushila"
ok "grep -q '$NEW' $HOME/.config/sushila/home" "new home remembered"
TOK=$(curl -s localhost:7874/ | grep -o 'SUSHILA_TOKEN="[^"]*"' | cut -d'"' -f2)
A=(-H "x-sushila-token: $TOK" -H 'content-type: application/json')
S=$(curl -s "${A[@]}" localhost:7874/api/files-folder); echo "$S"
ok "echo '$S' | grep -q '\"old\":\"$NEW/outputs\"'" "question shown for files from before"
ok "echo '$S' | grep -q '\"default\":\"$HOME/Documents/Sushila\"'" "default is ~/Documents/Sushila"
L=$(curl -s "${A[@]}" localhost:7874/api/library); ok "echo '$L' | grep -q 'a cat'" "library lists old file with its prompt"
M=$(curl -s "${A[@]}" -X POST -d '{"action":"move"}' localhost:7874/api/files-folder); echo "$M"
ok "[ -f $HOME/Documents/Sushila/Images/2026-10-01/101010-a-cat.png ] && [ -f $HOME/Documents/Sushila/Music/2026-10-02/111111-a-song.mp3 ]" "files moved into Images/ and Music/"
ok "grep -q '\"rel\":\"Images/2026-10-01/101010-a-cat.png\"' $HOME/Documents/Sushila/library.jsonl" "index paths follow"
ok "echo '$M' | grep -q '\"moved\":' && ! echo '$M' | grep -q '\"old\":\"'" "question gone after moving"
L=$(curl -s "${A[@]}" localhost:7874/api/library); ok "echo '$L' | grep -q 'a cat' && echo '$L' | grep -q 'Documents/Sushila'" "library reads the new folder with prompts"
REL=Images/2026-10-01/101010-a-cat.png
ok "[ \"\$(curl -s \"\${A[@]}\" 'localhost:7874/api/library/file?rel=$REL')\" = PNGDATA ]" "file served from the new folder"
D=$(curl -s "${A[@]}" -X POST -d "{\"rel\":\"$REL\"}" localhost:7874/api/library/delete -o /dev/null -w '%{http_code}'); R=$(curl -s "${A[@]}" -X POST -d "{\"rel\":\"$REL\"}" localhost:7874/api/library/restore -o /dev/null -w '%{http_code}')
ok "[ $D = 200 ] && [ $R = 200 ] && [ -f $HOME/Documents/Sushila/$REL ]" "trash and restore in the new folder"
mkdir -p /root/other
C=$(curl -s "${A[@]}" -X POST -d '{"action":"choose","folder":"/root/other","move":true}' localhost:7874/api/files-folder); echo "$C"
ok "[ -f /root/other/Images/2026-10-01/101010-a-cat.png ]" "choose another folder and move"
X=$(curl -s "${A[@]}" -X POST -d '{"action":"choose","folder":"relative/dir"}' localhost:7874/api/files-folder -o /dev/null -w '%{http_code}'); ok "[ $X = 409 ]" "relative folder refused"
Y=$(curl -s -H 'host: example.com' -H "x-sushila-token: $TOK" -X POST -d '{"action":"keep"}' localhost:7874/api/files-folder -o /dev/null -w '%{http_code}'); ok "[ $Y = 403 ]" "foreign host cannot change it"
Z=$(curl -s -X POST -d '{"action":"keep"}' localhost:7874/api/files-folder -o /dev/null -w '%{http_code}'); echo "no-token: $Z"
B2=$(curl -s "${A[@]}" -X POST -d '{"action":"default","move":true}' localhost:7874/api/files-folder); ok "[ -f $HOME/Documents/Sushila/Images/2026-10-01/101010-a-cat.png ] && [ ! -e /root/other/Images ]" "back to Documents with files"
chmod 500 /root/ro 2>/dev/null || { mkdir -p /root/ro; chmod 500 /root/ro; }
echo "(root ignores permissions, so the blocked-folder case is shown as unit logic only)"
kill %1; sleep 1; grep -i 'moved\|files folder' serve.log $NEW/logs/sushila.log 2>/dev/null | tail -5
