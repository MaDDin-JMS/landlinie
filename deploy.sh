#!/bin/bash
# Lädt src/ per FTPS auf den Webspace (landlinie.jm-services.de).
# Zugangsdaten aus der Umgebung: LL_FTP_HOST, LL_FTP_USER, LL_FTP_PW
# (z. B. vorher ll-env.sh aus der Passwortablage laden). Nie die
# lokale Datenbank hochladen; data/config.php nur mit --config.
set -euo pipefail
cd "$(dirname "$0")/src"
: "${LL_FTP_HOST:?}" "${LL_FTP_USER:?}" "${LL_FTP_PW:?}"

NETRC=$(mktemp)
trap 'rm -f "$NETRC"' EXIT
chmod 600 "$NETRC"
printf 'machine %s login %s password %s\n' "$LL_FTP_HOST" "$LL_FTP_USER" "$LL_FTP_PW" > "$NETRC"
W() { command -v cygpath >/dev/null && cygpath -w "$1" || printf '%s' "$1"; }

dateien=(index.html api.php cron.php manifest.webmanifest .htaccess
         assets/app.js assets/app.css assets/icon.svg
         assets/vendor/pdf.min.mjs assets/vendor/pdf.worker.min.mjs assets/vendor/LICENSE
         lib/db.php lib/logic.php lib/landlinie.php lib/.htaccess
         data/.htaccess)
[ "${1:-}" = --config ] && dateien+=(data/config.php)

for f in "${dateien[@]}"; do
  curl -sS --ssl-reqd --netrc-file "$(W "$NETRC")" --ftp-create-dirs -T "$(W "$f")" "ftp://$LL_FTP_HOST/$f"
  echo "hochgeladen: $f"
done
