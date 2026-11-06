<?php
declare(strict_types=1);

// Täglicher Sortiment-Abgleich (Martin 06.11.2026: jeden Tag 6:00 Uhr).
// Aufruf per Cronjob des Webspace:
//   https://landlinie.jm-services.de/cron.php?token=<cron_token aus data/config.php>
// oder auf der Kommandozeile: php cron.php
// Ohne gültigen Token: 403. Läuft schon ein Abgleich: 409.

require __DIR__ . '/lib/db.php';
require __DIR__ . '/lib/logic.php';
require __DIR__ . '/lib/landlinie.php';

date_default_timezone_set('Europe/Berlin');
header('Content-Type: text/plain; charset=utf-8');
header('Cache-Control: no-store');

if (PHP_SAPI !== 'cli') {
    $soll = (string)(config()['cron_token'] ?? '');
    $ist = (string)($_GET['token'] ?? '');
    if (strlen($soll) < 32 || !hash_equals($soll, $ist)) {
        http_response_code(403);
        exit("verboten\n");
    }
}

set_time_limit(600);
ignore_user_abort(true);

$lock = fopen(__DIR__ . '/data/cron.lock', 'c');
if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) {
    http_response_code(409);
    exit("läuft bereits\n");
}

try {
    $t = microtime(true);
    $r = shop_sync_all();
    printf("ok: %d Warengruppen, %d Artikel aktiv, %d ausgelistet, %.0f s\n", $r['gruppen'], $r['artikel'], $r['ausgelistet'], microtime(true) - $t);
} catch (Throwable $e) {
    if (db()->inTransaction()) {
        db()->rollBack();
    }
    log_event(null, null, 'System: automatische Sortiment-Aktualisierung fehlgeschlagen – ' . $e->getMessage());
    http_response_code(500);
    echo 'Fehler: ' . $e->getMessage() . "\n";
} finally {
    flock($lock, LOCK_UN);
}
