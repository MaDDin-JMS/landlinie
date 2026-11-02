<?php
declare(strict_types=1);

// Fachlogik: Gebinde, Teilen, Bestellrunde, Abrechnung.

const EPS = 0.0001;

final class ApiError extends RuntimeException
{
    public function __construct(string $message, public readonly int $status = 400)
    {
        parent::__construct($message);
    }
}

/*
 * Einheiten im Shop-JSON: vpe = Ladeneinheiten je Bestelleinheit (Gebinde),
 * ek = Preis je Ladeneinheit. grundpreisfaktor gibt es nur, wenn die
 * Ladeneinheit nicht die Grundpreis-Einheit ist:
 *   - Joghurt 10x150g: vpe 10, ek je Becher, faktor 6,667 (Grundpreis je kg)
 *     -> geteilt wird in Stück (Becher), 10 je Gebinde
 *   - Blumenkohl 8er: vpe 1, ek je Kiste, faktor 0,125 -> 8 Stück je Kiste
 *   - Süßkartoffeln 6,0kg: vpe 6, ek je kg, kein faktor -> 6 kg
 */

/** Einheiten je Gebinde (geteilt wird in diesen Einheiten, z. B. kg oder Stk). */
function units_per_case(array $a): float
{
    $vpe = (float)$a['vpe'];
    $f = $a['faktor'] !== null ? (float)$a['faktor'] : null;
    if ($f !== null && $f > 0 && $f < 1 && $vpe <= 1) {
        return round($vpe / $f);
    }
    return $vpe > 0 ? $vpe : 1;
}

/** Einheit, in der geteilt wird. */
function share_unit(array $a): string
{
    $f = $a['faktor'] !== null ? (float)$a['faktor'] : null;
    if ($f !== null && $f > 0 && abs($f - 1) > EPS) {
        return 'Stk';
    }
    $e = trim((string)$a['einheit']);
    return $e === '' ? 'Stk' : $e;
}

/** Schrittweite beim Teilen: kg/l in 0,1, sonst ganze Stück. */
function share_step(array $a): float
{
    $e = strtolower(share_unit($a));
    return in_array($e, ['kg', 'l', 'ltr', 'liter'], true) ? 0.1 : 1.0;
}

/** Netto-Preis je geteilter Einheit (Staffel 1). */
function unit_price_net(array $a): float
{
    $units = units_per_case($a);
    return round((float)$a['ek'] * (float)$a['vpe'] / $units, 4);
}

function unit_price_gross(array $a): float
{
    return round(unit_price_net($a) * (1 + (int)$a['mwst'] / 100), 4);
}

function case_price_gross(array $a): float
{
    return round((float)$a['ek'] * (float)$a['vpe'] * (1 + (int)$a['mwst'] / 100), 2);
}

function article(string $artnr): array
{
    $st = db()->prepare('SELECT * FROM articles WHERE artnr = ?');
    $st->execute([$artnr]);
    $a = $st->fetch();
    if (!$a) {
        throw new ApiError('Artikel nicht gefunden', 404);
    }
    return $a;
}

function round_row(int $id): array
{
    $st = db()->prepare('SELECT * FROM rounds WHERE id = ?');
    $st->execute([$id]);
    $r = $st->fetch();
    if (!$r) {
        throw new ApiError('Bestellrunde nicht gefunden', 404);
    }
    return $r;
}

/** Aktuelle Runde: die neueste nicht abgerechnete, sonst die neueste. */
function current_round(): ?array
{
    $r = db()->query("SELECT * FROM rounds WHERE status <> 'abgerechnet' ORDER BY id DESC LIMIT 1")->fetch();
    if (!$r) {
        $r = db()->query('SELECT * FROM rounds ORDER BY id DESC LIMIT 1')->fetch();
    }
    if ($r) {
        $r = auto_close($r);
    }
    return $r ?: null;
}

/** Nach Bestellschluss wird die Runde automatisch geschlossen. */
function auto_close(array $r): array
{
    if ($r['status'] === 'offen' && strtotime($r['deadline']) !== false && strtotime($r['deadline']) <= time()) {
        close_round((int)$r['id'], null);
        return round_row((int)$r['id']);
    }
    return $r;
}

function item_row(int $id): array
{
    $st = db()->prepare('SELECT * FROM items WHERE id = ?');
    $st->execute([$id]);
    $i = $st->fetch();
    if (!$i) {
        throw new ApiError('Position nicht gefunden', 404);
    }
    return $i;
}

function require_open(array $round): void
{
    if ($round['status'] !== 'offen') {
        throw new ApiError('Die Bestellrunde ist geschlossen, Änderungen sind nicht mehr möglich.', 409);
    }
}

function allocs_of(int $itemId): array
{
    $st = db()->prepare('SELECT * FROM allocs WHERE item_id = ?');
    $st->execute([$itemId]);
    return $st->fetchAll();
}

/**
 * Berechnet für eine Position: Gesamtmenge, frei, effektive Menge je Person.
 * allein: Ersteller bekommt alles. muss: jede bekommt ihre Menge, Rest ist frei
 * (bleibt Rest, entfällt der Artikel). kann: Ersteller nimmt mindestens ihre
 * Menge und zusätzlich alles, was die anderen nicht nehmen.
 */
function item_calc(array $item, array $article, array $allocs): array
{
    $units = units_per_case($article);
    $total = $units * (int)$item['cases'];
    $owner = (int)$item['owner_id'];
    $ownerQty = 0.0;
    $others = 0.0;
    foreach ($allocs as $al) {
        if ((int)$al['user_id'] === $owner) {
            $ownerQty = (float)$al['qty'];
        } else {
            $others += (float)$al['qty'];
        }
    }
    $eff = [];
    foreach ($allocs as $al) {
        $uid = (int)$al['user_id'];
        $q = (float)$al['qty'];
        if ($uid === $owner) {
            $q = match ($item['mode']) {
                'allein' => $total,
                'kann' => $total - $others,
                default => $q,
            };
        }
        $eff[$uid] = round($q, 3);
    }
    if (!isset($eff[$owner])) {
        $eff[$owner] = $item['mode'] === 'allein' ? $total : ($item['mode'] === 'kann' ? $total - $others : 0.0);
    }
    $free = match ($item['mode']) {
        'allein' => 0.0,
        default => $total - $ownerQty - $others,
    };
    return [
        'units' => $units,
        'total' => round($total, 3),
        'owner_qty' => round($ownerQty, 3),
        'others' => round($others, 3),
        'free' => round(max($free, 0), 3),
        'eff' => $eff,
    ];
}

function round_to_step(float $q, float $step): float
{
    return round(round($q / $step) * $step, 3);
}

/** Neue Position (Ersteller = $ownerId). */
function add_item(array $round, string $artnr, int $ownerId, string $mode, int $cases, float $qty, int $actor): int
{
    require_open($round);
    $a = article($artnr);
    if (!in_array($mode, ['allein', 'muss', 'kann'], true)) {
        throw new ApiError('Ungültige Art');
    }
    $cases = max(1, min($cases, 99));
    $total = units_per_case($a) * $cases;
    $qty = round_to_step($qty, share_step($a));
    if ($mode === 'allein') {
        $qty = $total;
    }
    if ($mode === 'muss' && ($qty <= EPS || $qty > $total + EPS)) {
        throw new ApiError(sprintf('Menge muss zwischen %s und %s %s liegen.', fmt_qty(share_step($a)), fmt_qty($total), share_unit($a)));
    }
    if ($mode === 'kann' && ($qty < -EPS || $qty > $total + EPS)) {
        throw new ApiError(sprintf('Mindestmenge muss zwischen 0 und %s %s liegen.', fmt_qty($total), share_unit($a)));
    }
    $pdo = db();
    $pdo->prepare('INSERT INTO items (round_id, artnr, owner_id, mode, cases) VALUES (?, ?, ?, ?, ?)')
        ->execute([$round['id'], $artnr, $ownerId, $mode, $cases]);
    $id = (int)$pdo->lastInsertId();
    $pdo->prepare('INSERT INTO allocs (item_id, user_id, qty) VALUES (?, ?, ?)')->execute([$id, $ownerId, $qty]);
    log_event($actor, (int)$round['id'], sprintf('%s: %s für %s angelegt (%s, %d Gebinde)',
        user_name($actor), $a['name'], user_name($ownerId), mode_label($mode), $cases));
    return $id;
}

/** Menge einer Person an einer Position setzen (0 = austragen). */
function set_alloc(array $item, int $userId, float $qty, int $actor): void
{
    $round = round_row((int)$item['round_id']);
    require_open($round);
    $a = article($item['artnr']);
    $qty = round_to_step(max($qty, 0), share_step($a));
    $allocs = allocs_of((int)$item['id']);
    $c = item_calc($item, $a, $allocs);
    $owner = (int)$item['owner_id'];
    $unit = share_unit($a);

    $current = 0.0;
    foreach ($allocs as $al) {
        if ((int)$al['user_id'] === $userId) {
            $current = (float)$al['qty'];
        }
    }
    if ($userId === $owner) {
        if ($item['mode'] === 'allein') {
            throw new ApiError('Bei "allein" bitte die Anzahl Gebinde ändern.');
        }
        $max = $c['total'] - $c['others'];
        if ($item['mode'] === 'muss' && $qty <= EPS) {
            throw new ApiError('Die eigene Menge muss größer als 0 sein. Zum Entfernen die Position löschen.');
        }
        if ($qty > $max + EPS) {
            throw new ApiError(sprintf('Höchstens %s %s möglich (andere haben schon %s %s).', fmt_qty($max), $unit, fmt_qty($c['others']), $unit));
        }
    } else {
        if ($item['mode'] === 'allein') {
            throw new ApiError('Dieser Artikel ist nicht zum Teilen freigegeben.');
        }
        $max = $c['free'] + $current;
        if ($qty > $max + EPS) {
            throw new ApiError(sprintf('Es sind nur noch %s %s frei.', fmt_qty($max), $unit));
        }
    }
    $pdo = db();
    if ($qty <= EPS && $userId !== $owner) {
        $pdo->prepare('DELETE FROM allocs WHERE item_id = ? AND user_id = ?')->execute([$item['id'], $userId]);
    } else {
        $pdo->prepare('INSERT INTO allocs (item_id, user_id, qty) VALUES (?, ?, ?)
                       ON CONFLICT(item_id, user_id) DO UPDATE SET qty = excluded.qty')
            ->execute([$item['id'], $userId, $qty]);
    }
    $pdo->prepare("UPDATE items SET updated_at = datetime('now') WHERE id = ?")->execute([$item['id']]);
    log_event($actor, (int)$round['id'], sprintf('%s: %s bei %s auf %s %s gesetzt (vorher %s)',
        user_name($actor), $a['name'], user_name($userId), fmt_qty($qty), $unit, fmt_qty($current)));
}

function update_item(array $item, ?string $mode, ?int $cases, int $actor): void
{
    $round = round_row((int)$item['round_id']);
    require_open($round);
    $a = article($item['artnr']);
    $allocs = allocs_of((int)$item['id']);
    $new = $item;
    if ($mode !== null) {
        if (!in_array($mode, ['allein', 'muss', 'kann'], true)) {
            throw new ApiError('Ungültige Art');
        }
        $new['mode'] = $mode;
    }
    if ($cases !== null) {
        $new['cases'] = max(1, min($cases, 99));
    }
    $c = item_calc($new, $a, $allocs);
    if ($new['mode'] === 'allein' && $c['others'] > EPS) {
        throw new ApiError('Andere haben sich schon eingetragen, "allein" geht dann nicht.');
    }
    if ($new['mode'] !== 'allein' && $c['owner_qty'] + $c['others'] > $c['total'] + EPS) {
        throw new ApiError(sprintf('Eingetragen sind schon %s %s, das passt nicht in %d Gebinde.',
            fmt_qty($c['owner_qty'] + $c['others']), share_unit($a), $new['cases']));
    }
    $pdo = db();
    // Wechsel von "allein": eigene Menge bleibt das ganze Gebinde
    if ($item['mode'] === 'allein' && $new['mode'] !== 'allein') {
        $pdo->prepare('UPDATE allocs SET qty = ? WHERE item_id = ? AND user_id = ?')
            ->execute([$c['total'], $item['id'], $item['owner_id']]);
    }
    if ($new['mode'] === 'allein') {
        $pdo->prepare('UPDATE allocs SET qty = ? WHERE item_id = ? AND user_id = ?')
            ->execute([$c['total'], $item['id'], $item['owner_id']]);
    }
    $pdo->prepare("UPDATE items SET mode = ?, cases = ?, updated_at = datetime('now') WHERE id = ?")
        ->execute([$new['mode'], $new['cases'], $item['id']]);
    log_event($actor, (int)$round['id'], sprintf('%s: %s (%s) geändert auf %s, %d Gebinde',
        user_name($actor), $a['name'], user_name((int)$item['owner_id']), mode_label($new['mode']), $new['cases']));
}

function delete_item(array $item, int $actor): void
{
    $round = round_row((int)$item['round_id']);
    require_open($round);
    $a = article($item['artnr']);
    $others = array_filter(allocs_of((int)$item['id']), fn($al) => (int)$al['user_id'] !== (int)$item['owner_id']);
    db()->prepare('DELETE FROM items WHERE id = ?')->execute([$item['id']]);
    $names = implode(', ', array_map(fn($al) => user_name((int)$al['user_id']), $others));
    log_event($actor, (int)$round['id'], sprintf('%s: %s von %s gelöscht%s', user_name($actor), $a['name'],
        user_name((int)$item['owner_id']), $names ? " (mitbestellt hatten: $names)" : ''));
}

/** Bestellschluss: nicht aufgegangene "muss teilen" entfallen. */
function close_round(int $roundId, ?int $actor): array
{
    $pdo = db();
    $round = round_row($roundId);
    if ($round['status'] !== 'offen') {
        return [];
    }
    $dropped = [];
    $st = $pdo->prepare("SELECT * FROM items WHERE round_id = ? AND status = 'aktiv'");
    $st->execute([$roundId]);
    foreach ($st->fetchAll() as $item) {
        if ($item['mode'] !== 'muss') {
            continue;
        }
        $a = article($item['artnr']);
        $c = item_calc($item, $a, allocs_of((int)$item['id']));
        if ($c['free'] > EPS) {
            $pdo->prepare("UPDATE items SET status = 'entfallen' WHERE id = ?")->execute([$item['id']]);
            $dropped[] = sprintf('%s (%s %s von %s %s offen)', $a['name'], fmt_qty($c['free']), share_unit($a), fmt_qty($c['total']), share_unit($a));
        }
    }
    $pdo->prepare("UPDATE rounds SET status = 'geschlossen', closed_at = datetime('now') WHERE id = ?")->execute([$roundId]);
    log_event($actor, $roundId, ($actor ? user_name($actor) : 'System') . ': Bestellschluss'
        . ($dropped ? '. Entfallen: ' . implode('; ', $dropped) : ', alles ist aufgegangen.'));
    return $dropped;
}

function reopen_round(int $roundId, int $actor): void
{
    $pdo = db();
    $pdo->prepare("UPDATE items SET status = 'aktiv' WHERE round_id = ? AND status = 'entfallen'")->execute([$roundId]);
    $pdo->prepare("UPDATE rounds SET status = 'offen', closed_at = NULL WHERE id = ?")->execute([$roundId]);
    log_event($actor, $roundId, user_name($actor) . ': Runde wieder geöffnet');
}

/** Alle Positionen einer Runde mit Artikel, Berechnung und Personen. */
function round_items(int $roundId): array
{
    $pdo = db();
    $st = $pdo->prepare('SELECT i.*, a.name, a.zusatz, a.gebinde, a.vpe, a.faktor, a.einheit, a.ek, a.mwst, a.image,
                                a.hersteller, a.land, a.qualitaet, a.pfand, a.pfand_text, a.bestand, a.staffel, a.merkmale, a.wg, a.top, a.ean
                         FROM items i JOIN articles a ON a.artnr = i.artnr
                         WHERE i.round_id = ? ORDER BY a.name, i.id');
    $st->execute([$roundId]);
    $items = $st->fetchAll();
    if (!$items) {
        return [];
    }
    $ids = array_column($items, 'id');
    $in = implode(',', array_fill(0, count($ids), '?'));
    $st = $pdo->prepare("SELECT * FROM allocs WHERE item_id IN ($in) ORDER BY id");
    $st->execute($ids);
    $byItem = [];
    foreach ($st->fetchAll() as $al) {
        $byItem[(int)$al['item_id']][] = $al;
    }
    $out = [];
    foreach ($items as $it) {
        $allocs = $byItem[(int)$it['id']] ?? [];
        $c = item_calc($it, $it, $allocs);
        $people = [];
        foreach ($allocs as $al) {
            $uid = (int)$al['user_id'];
            $people[] = [
                'user_id' => $uid,
                'qty' => (float)$al['qty'],
                'eff' => $c['eff'][$uid] ?? 0,
                'actual' => $al['actual'] !== null ? (float)$al['actual'] : null,
                'owner' => $uid === (int)$it['owner_id'],
            ];
        }
        usort($people, fn($x, $y) => ($y['owner'] <=> $x['owner']) ?: ($x['user_id'] <=> $y['user_id']));
        $out[] = [
            'id' => (int)$it['id'],
            'artnr' => $it['artnr'],
            'owner_id' => (int)$it['owner_id'],
            'mode' => $it['mode'],
            'cases' => (int)$it['cases'],
            'status' => $it['status'],
            'delivered' => (int)$it['delivered'],
            'units' => $c['units'],
            'total' => $c['total'],
            'free' => $c['free'],
            'owner_qty' => $c['owner_qty'],
            'people' => $people,
            'article' => article_public($it),
        ];
    }
    return $out;
}

/** Artikel für die Oberfläche. */
function article_public(array $a): array
{
    return [
        'artnr' => $a['artnr'],
        'name' => $a['name'],
        'zusatz' => $a['zusatz'],
        'gebinde' => $a['gebinde'],
        'einheit' => share_unit($a),
        'units' => units_per_case($a),
        'step' => share_step($a),
        'unit_price' => unit_price_gross($a),
        'case_price' => case_price_gross($a),
        'mwst' => (int)$a['mwst'],
        'hersteller' => $a['hersteller'],
        'land' => $a['land'],
        'qualitaet' => $a['qualitaet'],
        'image' => $a['image'],
        'bestand' => (int)$a['bestand'],
        'pfand' => (float)$a['pfand'],
        'pfand_text' => $a['pfand_text'],
        'merkmale' => json_decode($a['merkmale'] ?: '[]', true) ?: [],
        'staffel' => json_decode($a['staffel'] ?: '[]', true) ?: [],
        'wg' => $a['wg'],
        'ean' => $a['ean'],
    ];
}

/** Abrechnung je Person: Ware brutto (geliefert/gewogen), Pfand, Zusatzkosten. */
function settlement(int $roundId): array
{
    $round = round_row($roundId);
    $items = round_items($roundId);
    $per = [];
    foreach ($items as $it) {
        if ($it['status'] !== 'aktiv' || !$it['delivered']) {
            continue;
        }
        $a = $it['article'];
        foreach ($it['people'] as $p) {
            $q = $p['actual'] ?? $p['eff'];
            if ($q <= EPS) {
                continue;
            }
            $uid = $p['user_id'];
            $per[$uid] ??= ['user_id' => $uid, 'ware' => 0.0, 'pfand' => 0.0, 'zeilen' => []];
            $betrag = round($q * $a['unit_price'], 2);
            $pf = $a['pfand'] > 0 ? round($a['pfand'] * $it['cases'] * $q / max($it['total'], EPS), 2) : 0.0;
            $per[$uid]['ware'] += $betrag;
            $per[$uid]['pfand'] += $pf;
            $per[$uid]['zeilen'][] = [
                'artnr' => $a['artnr'], 'name' => $a['name'], 'qty' => $q, 'einheit' => $a['einheit'],
                'unit_price' => $a['unit_price'], 'betrag' => $betrag, 'pfand' => $pf,
                'gewogen' => $p['actual'] !== null,
            ];
        }
    }
    $n = count($per);
    $extra = $n > 0 ? round((float)$round['extra_kosten'] / $n, 2) : 0.0;
    $st = db()->prepare('SELECT user_id, paid FROM payments WHERE round_id = ?');
    $st->execute([$roundId]);
    $paid = array_column($st->fetchAll(), 'paid', 'user_id');
    foreach ($per as $uid => &$row) {
        $row['name'] = user_name($uid);
        $row['ware'] = round($row['ware'], 2);
        $row['pfand'] = round($row['pfand'], 2);
        $row['extra'] = $extra;
        $row['summe'] = round($row['ware'] + $row['pfand'] + $extra, 2);
        $row['paid'] = (int)($paid[$uid] ?? 0);
    }
    unset($row);
    uasort($per, fn($x, $y) => strcasecmp($x['name'], $y['name']));
    return array_values($per);
}

/** Bestellliste für den Shop-Import (je Artikelnummer zusammengefasst). */
function order_lines(int $roundId): array
{
    $mode = setting('export_menge', 'gebinde');
    $lines = [];
    foreach (round_items($roundId) as $it) {
        if ($it['status'] !== 'aktiv') {
            continue;
        }
        $a = $it['article'];
        $menge = $mode === 'einheiten' ? $it['total'] : $it['cases'];
        $lines[$a['artnr']] ??= ['artnr' => $a['artnr'], 'name' => $a['name'], 'gebinde' => $a['gebinde'], 'cases' => 0, 'menge' => 0, 'betrag' => 0.0];
        $lines[$a['artnr']]['cases'] += $it['cases'];
        $lines[$a['artnr']]['menge'] += $menge;
        $lines[$a['artnr']]['betrag'] += $a['case_price'] * $it['cases'];
    }
    ksort($lines, SORT_NATURAL);
    return array_values($lines);
}

function user_name(?int $id): string
{
    static $cache = [];
    if ($id === null) {
        return 'System';
    }
    if (!isset($cache[$id])) {
        $st = db()->prepare('SELECT name FROM users WHERE id = ?');
        $st->execute([$id]);
        $cache[$id] = (string)($st->fetchColumn() ?: '?');
    }
    return $cache[$id];
}

function mode_label(string $mode): string
{
    return ['allein' => 'allein', 'muss' => 'muss teilen', 'kann' => 'kann teilen'][$mode] ?? $mode;
}

function fmt_qty(float $q): string
{
    return rtrim(rtrim(number_format($q, 3, ',', ''), '0'), ',');
}
