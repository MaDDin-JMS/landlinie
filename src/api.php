<?php
declare(strict_types=1);

require __DIR__ . '/lib/db.php';
require __DIR__ . '/lib/logic.php';
require __DIR__ . '/lib/landlinie.php';

date_default_timezone_set('Europe/Berlin');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

session_name('bg');
session_set_cookie_params([
    'lifetime' => 60 * 60 * 24 * 90,
    'path' => '/',
    'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
    'httponly' => true,
    'samesite' => 'Strict',
]);
ini_set('session.gc_maxlifetime', (string)(60 * 60 * 24 * 90));
session_start();

function out(mixed $data, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
    exit;
}

function body(): array
{
    static $b = null;
    if ($b === null) {
        $b = json_decode((string)file_get_contents('php://input'), true) ?: [];
    }
    return $b;
}

function arg(string $k, mixed $default = null): mixed
{
    return body()[$k] ?? $_GET[$k] ?? $default;
}

function me(): array
{
    $id = $_SESSION['uid'] ?? null;
    if (!$id) {
        throw new ApiError('Bitte anmelden', 401);
    }
    $st = db()->prepare('SELECT id, name, is_admin FROM users WHERE id = ? AND active = 1');
    $st->execute([$id]);
    $u = $st->fetch();
    if (!$u) {
        session_destroy();
        throw new ApiError('Bitte anmelden', 401);
    }
    return $u;
}

function admin(): array
{
    $u = me();
    if (!(int)$u['is_admin']) {
        throw new ApiError('Nur für Admins', 403);
    }
    return $u;
}

function active_user(int $id): int
{
    $st = db()->prepare('SELECT id FROM users WHERE id = ? AND active = 1');
    $st->execute([$id]);
    if (!$st->fetchColumn()) {
        throw new ApiError('Bestellerin nicht gefunden', 404);
    }
    return $id;
}

function valid_pin(string $pin): string
{
    if (!preg_match('/^\d{4}$/', $pin)) {
        throw new ApiError('Die PIN muss aus 4 Ziffern bestehen.');
    }
    return $pin;
}

function users_public(bool $all = false): array
{
    $sql = 'SELECT id, name, is_admin, active FROM users' . ($all ? '' : ' WHERE active = 1') . ' ORDER BY name COLLATE NOCASE';
    return array_map(fn($u) => ['id' => (int)$u['id'], 'name' => $u['name'], 'is_admin' => (int)$u['is_admin'], 'active' => (int)$u['active']],
        db()->query($sql)->fetchAll());
}

function book_pfand(int $roundId, int $actor): void
{
    $pdo = db();
    $pdo->prepare("DELETE FROM pfand WHERE round_id = ? AND item_id IS NOT NULL")->execute([$roundId]);
    $st = $pdo->prepare('INSERT INTO pfand (user_id, round_id, item_id, betrag, text, created_by) VALUES (?, ?, ?, ?, ?, ?)');
    $round = round_row($roundId);
    foreach (round_items($roundId) as $it) {
        if ($it['status'] !== 'aktiv' || !$it['delivered'] || $it['article']['pfand'] <= 0) {
            continue;
        }
        foreach ($it['people'] as $p) {
            $q = $p['actual'] ?? $p['eff'];
            if ($q <= EPS) {
                continue;
            }
            $betrag = round($it['article']['pfand'] * $it['cases'] * $q / max($it['total'], EPS), 2);
            $text = sprintf('%s: %s (%s)', $round['title'], $it['article']['pfand_text'] ?: 'Pfand', $it['article']['name']);
            $st->execute([$p['user_id'], $roundId, $it['id'], $betrag, $text, $actor]);
        }
    }
}

$action = (string)($_GET['a'] ?? '');
if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'fetch') {
    out(['error' => 'Ungültige Anfrage'], 400);
}

try {
    $pdo = db();
    switch ($action) {
        case 'boot':
            $hasUsers = (int)$pdo->query('SELECT COUNT(*) FROM users')->fetchColumn() > 0;
            $uid = $_SESSION['uid'] ?? null;
            out(['setup' => !$hasUsers, 'users' => users_public(), 'logged_in' => (bool)$uid]);

        case 'setup':
            if ((int)$pdo->query('SELECT COUNT(*) FROM users')->fetchColumn() > 0) {
                throw new ApiError('Bereits eingerichtet', 409);
            }
            $name = trim((string)arg('name', ''));
            if ($name === '') {
                throw new ApiError('Bitte einen Namen eingeben.');
            }
            $pdo->prepare('INSERT INTO users (name, pin_hash, is_admin) VALUES (?, ?, 1)')
                ->execute([$name, password_hash(valid_pin((string)arg('pin', '')), PASSWORD_DEFAULT)]);
            session_regenerate_id(true);
            $_SESSION['uid'] = (int)$pdo->lastInsertId();
            out(['ok' => true]);

        case 'login':
            $st = $pdo->prepare('SELECT * FROM users WHERE id = ? AND active = 1');
            $st->execute([(int)arg('user_id', 0)]);
            $u = $st->fetch();
            if (!$u) {
                throw new ApiError('Unbekannte Bestellerin', 404);
            }
            if ((int)$u['locked_until'] > time()) {
                throw new ApiError('Zu viele Fehlversuche, bitte in ' . ceil(((int)$u['locked_until'] - time()) / 60) . ' Minuten nochmal.', 429);
            }
            if (!password_verify((string)arg('pin', ''), $u['pin_hash'])) {
                $failed = (int)$u['failed'] + 1;
                $pdo->prepare('UPDATE users SET failed = ?, locked_until = ? WHERE id = ?')
                    ->execute([$failed >= 5 ? 0 : $failed, $failed >= 5 ? time() + 600 : 0, $u['id']]);
                throw new ApiError('PIN falsch', 401);
            }
            $pdo->prepare('UPDATE users SET failed = 0, locked_until = 0 WHERE id = ?')->execute([$u['id']]);
            session_regenerate_id(true);
            $_SESSION['uid'] = (int)$u['id'];
            out(['ok' => true]);

        case 'logout':
            session_destroy();
            out(['ok' => true]);

        case 'state':
            $me = me();
            $round = current_round();
            $roundId = (int)(arg('round_id') ?: ($round['id'] ?? 0));
            if ($roundId && (!$round || $roundId !== (int)$round['id'])) {
                $round = auto_close(round_row($roundId));
            }
            out([
                'me' => ['id' => (int)$me['id'], 'name' => $me['name'], 'is_admin' => (int)$me['is_admin']],
                'users' => users_public(true),
                'round' => $round,
                'rounds' => $pdo->query('SELECT id, title, deadline, status FROM rounds ORDER BY id DESC LIMIT 30')->fetchAll(),
                'items' => $round ? round_items((int)$round['id']) : [],
                'categories' => $pdo->query('SELECT code, label, top FROM categories ORDER BY sort')->fetchAll(),
                'sortiment_stand' => setting('sortiment_stand'),
                'sortiment_naechster' => ((int)setting('sortiment_ts', '0') + 6 * 3600) > time()
                    ? date('c', (int)setting('sortiment_ts', '0') + 6 * 3600) : null,
                'artikel_anzahl' => (int)$pdo->query('SELECT COUNT(*) FROM articles WHERE active = 1')->fetchColumn(),
                'export_menge' => setting('export_menge', 'gebinde'),
                'favs' => (function () use ($pdo, $me) {
                    $st = $pdo->prepare('SELECT artnr FROM favorites WHERE user_id = ?');
                    $st->execute([$me['id']]);
                    return $st->fetchAll(PDO::FETCH_COLUMN);
                })(),
                'now' => date('c'),
            ]);

        case 'articles':
            me();
            $q = trim((string)arg('q', ''));
            $cat = (string)arg('cat', '');
            $offset = max(0, (int)arg('offset', 0));
            $where = ['active = 1'];
            $params = [];
            if ($cat !== '') {
                $where[] = '(wg = ? OR artnr IN (SELECT artnr FROM article_cats WHERE code = ?))';
                $params[] = $cat;
                $params[] = $cat;
            }
            foreach (preg_split('/\s+/u', mb_strtolower($q)) as $tok) {
                if ($tok === '') {
                    continue;
                }
                $where[] = "(lower(name) LIKE ? OR lower(zusatz) LIKE ? OR lower(hersteller) LIKE ? OR artnr = ? OR ean = ?)";
                $like = '%' . str_replace(['%', '_'], ['\%', '\_'], $tok) . '%';
                array_push($params, $like, $like, $like, $tok, $tok);
            }
            if ((int)arg('pfand', 0)) {
                $where[] = 'pfand > 0';
            }
            if ($cat === '_fav') {
                array_splice($where, 1, 1);
                array_splice($params, 0, 2);
                $where[] = 'artnr IN (SELECT artnr FROM favorites WHERE user_id = ?)';
                $params[] = (int)$_SESSION['uid'];
            }
            if ($cat === '_zuletzt') {
                // Zuletzt bestellt: Artikel aus früheren und der laufenden Runde, neueste zuerst
                array_splice($where, 1, 1);
                array_splice($params, 0, 2);
                $st = $pdo->prepare('SELECT * FROM articles
                    WHERE ' . implode(' AND ', $where) . ' AND artnr IN (SELECT artnr FROM items)
                    ORDER BY (SELECT MAX(i.id) FROM items i WHERE i.artnr = articles.artnr) DESC LIMIT 41 OFFSET ' . $offset);
                $st->execute($params);
                $rows = $st->fetchAll();
                out(['items' => array_map('article_public', array_slice($rows, 0, 40)), 'more' => count($rows) > 40]);
            }
            $sql ='SELECT * FROM articles WHERE ' . implode(' AND ', $where) . " ORDER BY ltrim(name, '\"''`´ ') COLLATE NOCASE LIMIT 41 OFFSET " . $offset;
            $st = $pdo->prepare($sql);
            $st->execute($params);
            $rows = $st->fetchAll();
            out(['items' => array_map('article_public', array_slice($rows, 0, 40)), 'more' => count($rows) > 40]);

        case 'fav_toggle':
            $me = me();
            $artnr = article((string)arg('artnr', ''))['artnr'];
            $del = $pdo->prepare('DELETE FROM favorites WHERE user_id = ? AND artnr = ?');
            $del->execute([$me['id'], $artnr]);
            if ($del->rowCount() === 0) {
                $pdo->prepare('INSERT INTO favorites (user_id, artnr) VALUES (?, ?)')->execute([$me['id'], $artnr]);
                out(['fav' => true]);
            }
            out(['fav' => false]);

        case 'item_add':
            $me = me();
            $round = current_round();
            if (!$round) {
                throw new ApiError('Es gibt noch keine Bestellrunde.');
            }
            $owner = active_user((int)arg('owner_id', $me['id']));
            $id = add_item($round, (string)arg('artnr', ''), $owner, (string)arg('mode', 'allein'),
                (int)arg('cases', 1), (float)arg('qty', 0), (int)$me['id']);
            out(['ok' => true, 'id' => $id]);

        case 'alloc_set':
            $me = me();
            $item = item_row((int)arg('item_id', 0));
            set_alloc($item, active_user((int)arg('user_id', $me['id'])), (float)arg('qty', 0), (int)$me['id']);
            out(['ok' => true]);

        case 'item_update':
            $me = me();
            $item = item_row((int)arg('item_id', 0));
            $mode = arg('mode');
            $cases = arg('cases');
            update_item($item, $mode !== null ? (string)$mode : null, $cases !== null ? (int)$cases : null, (int)$me['id']);
            out(['ok' => true]);

        case 'item_delete':
            $me = me();
            delete_item(item_row((int)arg('item_id', 0)), (int)$me['id']);
            out(['ok' => true]);

        case 'log':
            me();
            $st = $pdo->prepare('SELECT ts, text FROM log WHERE round_id = ? OR round_id IS NULL ORDER BY id DESC LIMIT 200');
            $st->execute([(int)arg('round_id', 0)]);
            out(['log' => array_map(fn($r) => ['ts' => date('c', strtotime($r['ts'] . ' UTC')), 'text' => $r['text']], $st->fetchAll())]);

        // ---------------- Admin ----------------
        case 'round_create':
            $me = admin();
            $title = trim((string)arg('title', ''));
            $deadline = (string)arg('deadline', '');
            if ($title === '' || strtotime($deadline) === false) {
                throw new ApiError('Titel und Bestellschluss angeben.');
            }
            $pdo->prepare('INSERT INTO rounds (title, deadline, extra_kosten, extra_text) VALUES (?, ?, ?, ?)')
                ->execute([$title, date('Y-m-d\TH:i', strtotime($deadline)), (float)arg('extra_kosten', 0), (string)arg('extra_text', 'Kontoführung')]);
            $rid = (int)$pdo->lastInsertId();
            log_event((int)$me['id'], $rid, $me['name'] . ': Bestellrunde "' . $title . '" angelegt');
            out(['ok' => true, 'id' => $rid]);

        case 'round_update':
            $me = admin();
            $r = round_row((int)arg('id', 0));
            $deadline = (string)arg('deadline', $r['deadline']);
            if (strtotime($deadline) === false) {
                throw new ApiError('Ungültiger Bestellschluss');
            }
            $pdo->prepare('UPDATE rounds SET title = ?, deadline = ?, extra_kosten = ?, extra_text = ? WHERE id = ?')
                ->execute([trim((string)arg('title', $r['title'])), date('Y-m-d\TH:i', strtotime($deadline)),
                    (float)arg('extra_kosten', $r['extra_kosten']), (string)arg('extra_text', $r['extra_text']), $r['id']]);
            log_event((int)$me['id'], (int)$r['id'], $me['name'] . ': Runde geändert (Bestellschluss ' . date('d.m. H:i', strtotime($deadline)) . ')');
            out(['ok' => true]);

        case 'round_close':
            $me = admin();
            out(['ok' => true, 'dropped' => close_round((int)arg('id', 0), (int)$me['id'])]);

        case 'round_reopen':
            $me = admin();
            reopen_round((int)arg('id', 0), (int)$me['id']);
            out(['ok' => true]);

        case 'round_status':
            $me = admin();
            $r = round_row((int)arg('id', 0));
            $status = (string)arg('status', '');
            if (!in_array($status, ['geschlossen', 'bestellt', 'geliefert', 'abgerechnet'], true) || $r['status'] === 'offen') {
                throw new ApiError('Ungültiger Status');
            }
            $pdo->beginTransaction();
            $pdo->prepare('UPDATE rounds SET status = ? WHERE id = ?')->execute([$status, $r['id']]);
            if (in_array($status, ['geliefert', 'abgerechnet'], true)) {
                book_pfand((int)$r['id'], (int)$me['id']);
            }
            log_event((int)$me['id'], (int)$r['id'], $me['name'] . ': Status "' . $status . '"');
            $pdo->commit();
            out(['ok' => true]);

        case 'round_delete':
            $me = admin();
            $r = round_row((int)arg('id', 0));
            $pdo->prepare('DELETE FROM rounds WHERE id = ?')->execute([$r['id']]);
            log_event((int)$me['id'], null, $me['name'] . ': Runde "' . $r['title'] . '" gelöscht');
            out(['ok' => true]);

        case 'delivery':
            $me = admin();
            $item = item_row((int)arg('item_id', 0));
            $r = round_row((int)$item['round_id']);
            if ($r['status'] === 'offen') {
                throw new ApiError('Erst nach Bestellschluss möglich.');
            }
            if (arg('delivered') !== null) {
                $pdo->prepare('UPDATE items SET delivered = ? WHERE id = ?')->execute([(int)arg('delivered') ? 1 : 0, $item['id']]);
                log_event((int)$me['id'], (int)$r['id'], $me['name'] . ': ' . article($item['artnr'])['name'] . ((int)arg('delivered') ? ' geliefert' : ' nicht geliefert'));
            }
            if (arg('actual_total') !== null) {
                // Gelieferte Gesamtmenge (z. B. Käselaib 5,5 statt 6 kg): anteilig auf alle verteilen
                $total = arg('actual_total');
                $it = null;
                foreach (round_items((int)$r['id']) as $x) {
                    if ($x['id'] === (int)$item['id']) {
                        $it = $x;
                    }
                }
                $sum = array_sum(array_column($it['people'], 'eff'));
                $upd = $pdo->prepare('UPDATE allocs SET actual = ? WHERE item_id = ? AND user_id = ?');
                foreach ($it['people'] as $p) {
                    $val = ($total === null || $total === '' || $sum <= EPS) ? null : round(max(0, (float)$total) * $p['eff'] / $sum, 3);
                    $upd->execute([$val, $item['id'], $p['user_id']]);
                }
                log_event((int)$me['id'], (int)$r['id'], sprintf('%s: %s geliefert %s statt %s %s, anteilig verteilt', $me['name'],
                    $it['article']['name'], $total === '' || $total === null ? '(zurückgesetzt)' : fmt_qty((float)$total), fmt_qty($it['total']), $it['article']['einheit']));
            }
            if (arg('user_id') !== null) {
                $actual = arg('actual');
                $pdo->prepare('UPDATE allocs SET actual = ? WHERE item_id = ? AND user_id = ?')
                    ->execute([$actual === null || $actual === '' ? null : max(0, (float)$actual), $item['id'], (int)arg('user_id')]);
            }
            if (in_array($r['status'], ['geliefert', 'abgerechnet'], true)) {
                book_pfand((int)$r['id'], (int)$me['id']);
            }
            out(['ok' => true]);

        case 'settlement':
            me();
            out(['rows' => settlement((int)arg('round_id', 0))]);

        case 'payment':
            admin();
            $pdo->prepare('INSERT INTO payments (round_id, user_id, paid) VALUES (?, ?, ?)
                           ON CONFLICT(round_id, user_id) DO UPDATE SET paid = excluded.paid')
                ->execute([(int)arg('round_id'), (int)arg('user_id'), (int)arg('paid', 0) ? 1 : 0]);
            out(['ok' => true]);

        case 'export':
            admin();
            $r = round_row((int)arg('round_id', 0));
            header('Content-Type: text/csv; charset=utf-8');
            header('Content-Disposition: attachment; filename="Bestellung per ArtNr ' . date('Y-m-d', strtotime($r['deadline'])) . '.csv"');
            $lines = ["artnr;menge;kommentar"];
            foreach (order_lines((int)$r['id']) as $l) {
                $lines[] = $l['artnr'] . ';' . str_replace('.', ',', (string)(float)$l['menge']) . ';';
            }
            echo implode("\n", $lines) . "\n";
            exit;

        case 'order_lines':
            me();
            out(['lines' => order_lines((int)arg('round_id', 0)), 'mode' => setting('export_menge', 'gebinde')]);

        case 'pfand':
            me();
            $rows = $pdo->query('SELECT p.*, u.name FROM pfand p JOIN users u ON u.id = p.user_id ORDER BY p.id DESC LIMIT 500')->fetchAll();
            $bal = $pdo->query('SELECT u.id AS user_id, u.name, COALESCE(SUM(p.betrag), 0) AS saldo
                                FROM users u LEFT JOIN pfand p ON p.user_id = u.id
                                WHERE u.active = 1 GROUP BY u.id ORDER BY u.name COLLATE NOCASE')->fetchAll();
            out(['entries' => $rows, 'balances' => $bal]);

        case 'pfand_add':
            $me = me();
            $uid = active_user((int)arg('user_id', $me['id']));
            $betrag = round((float)arg('betrag', 0), 2);
            $text = trim((string)arg('text', ''));
            if (abs($betrag) < 0.005 || $text === '') {
                throw new ApiError('Betrag und Text angeben.');
            }
            $pdo->prepare('INSERT INTO pfand (user_id, betrag, text, created_by) VALUES (?, ?, ?, ?)')
                ->execute([$uid, $betrag, $text, $me['id']]);
            log_event((int)$me['id'], null, sprintf('%s: Pfand %s € bei %s (%s)', $me['name'], number_format($betrag, 2, ',', ''), user_name($uid), $text));
            out(['ok' => true]);

        case 'pfand_delete':
            $me = admin();
            $pdo->prepare('DELETE FROM pfand WHERE id = ? AND item_id IS NULL')->execute([(int)arg('id', 0)]);
            out(['ok' => true]);

        case 'article_pfand':
            $me = admin();
            $a = article((string)arg('artnr', ''));
            $pdo->prepare('UPDATE articles SET pfand = ?, pfand_text = ? WHERE artnr = ?')
                ->execute([max(0, round((float)arg('pfand', 0), 2)), trim((string)arg('pfand_text', '')), $a['artnr']]);
            log_event((int)$me['id'], null, sprintf('%s: Pfand für %s auf %s € gesetzt', $me['name'], $a['name'], number_format((float)arg('pfand', 0), 2, ',', '')));
            out(['ok' => true]);

        case 'user_save':
            $me = admin();
            $id = (int)arg('id', 0);
            $name = trim((string)arg('name', ''));
            if ($name === '') {
                throw new ApiError('Bitte einen Namen eingeben.');
            }
            $pin = (string)arg('pin', '');
            if ($id === 0) {
                $pdo->prepare('INSERT INTO users (name, pin_hash, is_admin) VALUES (?, ?, ?)')
                    ->execute([$name, password_hash(valid_pin($pin), PASSWORD_DEFAULT), (int)arg('is_admin', 0) ? 1 : 0]);
                log_event((int)$me['id'], null, $me['name'] . ': Bestellerin ' . $name . ' angelegt');
            } else {
                if ($id === (int)$me['id'] && (!(int)arg('is_admin', 1) || !(int)arg('active', 1))) {
                    throw new ApiError('Du kannst dir selbst nicht die Admin-Rechte nehmen.');
                }
                $pdo->prepare('UPDATE users SET name = ?, is_admin = ?, active = ? WHERE id = ?')
                    ->execute([$name, (int)arg('is_admin', 0) ? 1 : 0, (int)arg('active', 1) ? 1 : 0, $id]);
                if ($pin !== '') {
                    $pdo->prepare('UPDATE users SET pin_hash = ?, failed = 0, locked_until = 0 WHERE id = ?')
                        ->execute([password_hash(valid_pin($pin), PASSWORD_DEFAULT), $id]);
                }
            }
            out(['ok' => true]);

        case 'my_pin':
            $me = me();
            $pdo->prepare('UPDATE users SET pin_hash = ? WHERE id = ?')
                ->execute([password_hash(valid_pin((string)arg('pin', '')), PASSWORD_DEFAULT), $me['id']]);
            out(['ok' => true]);

        case 'settings':
            admin();
            $m = (string)arg('export_menge', 'gebinde');
            set_setting('export_menge', $m === 'einheiten' ? 'einheiten' : 'gebinde');
            out(['ok' => true]);

        case 'sync_start':
            admin();
            set_time_limit(120);
            $last = (int)setting('sortiment_ts', '0');
            if ($last > time() - 6 * 3600) {
                throw new ApiError('Das Sortiment wurde zuletzt um ' . date('H:i', $last) . ' Uhr aktualisiert. Wieder möglich ab '
                    . date('d.m. H:i', $last + 6 * 3600) . ' Uhr.', 429);
            }
            $started = (string)$pdo->query("SELECT datetime('now')")->fetchColumn();
            $cats = shop_login_and_categories();
            set_setting('sortiment_ts', (string)time());
            out(['categories' => $cats, 'started' => $started]);

        case 'sync_cat':
            admin();
            set_time_limit(120);
            out(['count' => shop_sync_category((string)arg('code', ''))]);

        case 'sync_finish':
            $me = admin();
            $hidden = shop_sync_finish((string)arg('started', ''));
            $n = (int)$pdo->query('SELECT COUNT(*) FROM articles WHERE active = 1')->fetchColumn();
            log_event((int)$me['id'], null, sprintf('%s: Sortiment aktualisiert (%d Artikel, %d ausgelistet)', $me['name'], $n, $hidden));
            out(['ok' => true, 'count' => $n, 'hidden' => $hidden]);

        default:
            out(['error' => 'Unbekannte Aktion'], 404);
    }
} catch (ApiError $e) {
    if (db()->inTransaction()) {
        db()->rollBack();
    }
    out(['error' => $e->getMessage()], $e->status);
} catch (Throwable $e) {
    if (isset($pdo) && $pdo->inTransaction()) {
        $pdo->rollBack();
    }
    error_log('bestellung: ' . $e);
    out(['error' => 'Interner Fehler: ' . $e->getMessage()], 500);
}
