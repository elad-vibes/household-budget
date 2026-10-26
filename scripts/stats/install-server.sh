#!/usr/bin/env bash
# Admin dashboard → Elad's server. Run from the Linux shell on Elad's PC (the bridge),
# where $HOME/vs runs one command as root on the server. Safe to run again (updates in place).
#
#   bash ~/mnt/brain/documents/"פרויקטים אישיים"/"הכסף של הבית"/scripts/stats/install-server.sh
#   … --new-password    new sign-in password for the page (the old one stops working)
#
# What it does on the server:
#   /home/vibes/household-stats/collect.mjs  the bundled collector (npm run stats:bundle on Windows first)
#   /home/vibes/household-stats/.env         hb_stats DB password etc. (vibes only, chmod 600)
#   /srv/tools/bayit-admin/                  index.html + stats.json, rebuilt every 5 minutes (crontab of vibes)
#   /etc/caddy/Caddyfile                     + a password (basicauth) on /bayit-admin — backup, validate, reload;
#                                            nothing else in the Caddyfile changes
# Never prints the DB password. The page password is printed ONCE, here, for Elad to save.
set -euo pipefail
P="$HOME/mnt/brain/documents/פרויקטים אישיים/הכסף של הבית"
VS="$HOME/vs"
APP=/home/vibes/household-stats
WEB=/srv/tools/bayit-admin
URL_PAGE="https://95-217-135-115.sslip.io/bayit-admin/"
NEWPASS=0; [ "${1:-}" = "--new-password" ] && NEWPASS=1

[ -x "$VS" ] || { echo "STOP: $VS not found — the server shortcut is missing on this bridge."; exit 2; }
[ -f "$P/dist-stats/collect.mjs" ] || { echo "STOP: dist-stats/collect.mjs missing — on Windows run: npm run stats:bundle"; exit 2; }
val() { grep -E "^$1=" "$P/.env.local" | tail -1 | cut -d= -f2- | tr -d '\r'; }
PW=$(val STATS_DB_PASSWORD); SUPA=$(val SUPABASE_URL)
HOST=$(tr -d '\r\n' < "$P/supabase/.temp/pooler-host")
REF=$(printf '%s' "$SUPA" | sed -E 's#^https://([a-z0-9]{20})\.supabase\.co/?$#\1#')
[ -n "$PW" ] || { echo "STOP: STATS_DB_PASSWORD missing — on Windows run: node scripts/stats/role.mjs"; exit 2; }
{ [ ${#REF} -eq 20 ] && [ -n "$HOST" ]; } || { echo "STOP: SUPABASE_URL / pooler host not found in the project folder"; exit 2; }

echo "1/5 collector + settings → $APP"
$VS "install -d -o vibes -g vibes -m 700 $APP"
$VS "cat > $APP/collect.mjs.new && chown vibes:vibes $APP/collect.mjs.new && mv $APP/collect.mjs.new $APP/collect.mjs" < "$P/dist-stats/collect.mjs"
printf 'STATS_DB_HOST=%s\nSTATS_DB_USER=hb_stats.%s\nSTATS_DB_PASSWORD=%s\nSTATS_OUT_DIR=%s\n' "$HOST" "$REF" "$PW" "$WEB" \
  | $VS "umask 077 && cat > $APP/.env && chown vibes:vibes $APP/.env && chmod 600 $APP/.env"
echo "   md5 here:   $(md5sum "$P/dist-stats/collect.mjs" | cut -d' ' -f1)"
echo "   md5 server: $($VS "md5sum $APP/collect.mjs" | cut -d' ' -f1)"

echo "2/5 web folder → $WEB"
$VS "install -d -o vibes -g caddy -m 755 $WEB"

echo "3/5 first run"
$VS "su vibes -s /bin/bash -c 'cd $APP && STATS_ENV_FILE=$APP/.env /usr/bin/node collect.mjs'" \
  || { echo "STOP: the first run failed (message above). The page is not live yet; nothing in Caddy changed."; exit 3; }

echo "4/5 every 5 minutes (crontab of vibes)"
$VS "su vibes -s /bin/bash -c '(crontab -l 2>/dev/null | grep -v household-stats; echo \"*/5 * * * * cd $APP && STATS_ENV_FILE=$APP/.env /usr/bin/node collect.mjs > $APP/last-run.log 2>&1\") | crontab -'"
$VS "su vibes -s /bin/bash -c 'crontab -l | grep household-stats'"

echo "5/5 password on the page (Caddy)"
$VS "NEWPASS=$NEWPASS bash -s" <<'REMOTE'
set -euo pipefail
CF=/etc/caddy/Caddyfile
if grep -q '@hbadmin' "$CF" && [ "$NEWPASS" != 1 ]; then
  echo "   already protected — keeping the existing password (use --new-password for a new one)"
  exit 0
fi
PASS=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 20)
HASH=$(caddy hash-password --plaintext "$PASS")
BAK="$CF.bak-$(date +%Y%m%d-%H%M%S)-bayit"
cp -p "$CF" "$BAK"
python3 - "$CF" "$HASH" <<'PY'
import re, sys
path, hsh = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
# remove an earlier copy of our block (re-run / --new-password), then add it right after "encode gzip"
text = re.sub(r"\t@hbadmin path[^\n]*\n\tbasicauth @hbadmin \{\n\t\telad [^\n]*\n\t\}\n\theader @hbadmin [^\n]*\n", "", text)
block = ("\t@hbadmin path /bayit-admin /bayit-admin/*\n"
         "\tbasicauth @hbadmin {\n\t\telad " + hsh + "\n\t}\n"
         "\theader @hbadmin Cache-Control \"no-store\"\n")
new, n = re.subn(r"\n\tencode gzip\n", lambda m: m.group(0) + block, text, count=1)
if n != 1:
    sys.exit("anchor 'encode gzip' not found")
open(path, "w", encoding="utf-8").write(new)
PY
if ! caddy validate --config "$CF" --adapter caddyfile >/dev/null 2>&1; then
  cp -p "$BAK" "$CF"; echo "   STOP: Caddy did not accept the change — restored the backup, nothing changed."; exit 4
fi
systemctl reload caddy
echo "   Caddyfile backup: $BAK"
echo
echo "   ==============================================="
echo "     user:      elad"
echo "     password:  $PASS"
echo "   ==============================================="
echo "   Save it in your password manager now. It is not shown again."
REMOTE

echo
code_no=$($VS "curl -s -o /dev/null -w '%{http_code}' $URL_PAGE")
echo "check without a password: $code_no (expected 401)"
[ "$code_no" = 401 ] || { echo "ALERT: the page is not password protected!"; exit 5; }
echo "OK. Open: $URL_PAGE"
