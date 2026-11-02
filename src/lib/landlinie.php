<?php
declare(strict_types=1);

// Sortiment aus dem Landlinie-Shop holen (Login mit Kundennummer aus
// data/config.php, dann je Warengruppe die JSON-Liste des Shops).

const SHOP = 'https://shop.landlinie.de';

function shop_jar(): string
{
    return __DIR__ . '/../data/shop-cookies.txt';
}

function shop_request(string $path, ?array $post = null): string
{
    $ch = curl_init(SHOP . $path);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_COOKIEJAR => shop_jar(),
        CURLOPT_COOKIEFILE => shop_jar(),
        CURLOPT_TIMEOUT => 60,
        CURLOPT_USERAGENT => 'Bestellgemeinschaft (landlinie.jm-services.de)',
        CURLOPT_HTTPHEADER => ['X-Requested-With: XMLHttpRequest'],
    ]);
    if ($post !== null) {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($post));
    }
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    if ($body === false || $code >= 400) {
        throw new ApiError('Landlinie-Shop nicht erreichbar (' . ($code ?: curl_error($ch)) . ')', 502);
    }
    return (string)$body;
}

/** Anmelden und Warengruppen von der Startseite lesen. */
function shop_login_and_categories(): array
{
    $cfg = config();
    if (empty($cfg['landlinie_user']) || empty($cfg['landlinie_password'])) {
        throw new ApiError('Zugangsdaten für den Landlinie-Shop fehlen (data/config.php).', 500);
    }
    @unlink(shop_jar());
    shop_request('/login');
    shop_request('/login_check', ['_username' => $cfg['landlinie_user'], '_password' => $cfg['landlinie_password']]);
    $home = shop_request('/');
    if (stripos($home, '/logout') === false) {
        throw new ApiError('Anmeldung im Landlinie-Shop fehlgeschlagen.', 502);
    }
    preg_match_all('#href="/shop/produkte/([^/"]+)/[^"]+"[^>]*>\s*([^<]+?)\s*<#u', $home, $m, PREG_SET_ORDER);
    $cats = [];
    $sort = 0;
    foreach ($m as $hit) {
        $code = $hit[1];
        if (isset($cats[$code])) {
            continue;
        }
        $cats[$code] = [
            'code' => $code,
            'label' => html_entity_decode(trim(preg_replace('/\s+/u', ' ', $hit[2])), ENT_QUOTES | ENT_HTML5, 'UTF-8'),
            'sort' => $sort++,
            // Hauptgruppen haben sprechende Kürzel, Untergruppen l001 ff.
            'top' => preg_match('/^l\d+$/', $code) ? 0 : 1,
        ];
    }
    $pdo = db();
    $st = $pdo->prepare('INSERT INTO categories (code, label, sort, top) VALUES (?, ?, ?, ?)
                         ON CONFLICT(code) DO UPDATE SET label = excluded.label, sort = excluded.sort, top = excluded.top');
    foreach ($cats as $c) {
        $st->execute([$c['code'], $c['label'], $c['sort'], $c['top']]);
    }
    return array_values(array_filter($cats, fn($c) => $c['top'] === 1));
}

/** Eine Hauptgruppe holen und Artikel speichern. Gibt die Anzahl zurück. */
function shop_sync_category(string $code): int
{
    if (!preg_match('/^[A-Za-z0-9_-]+$/', $code)) {
        throw new ApiError('Ungültige Warengruppe');
    }
    $json = json_decode(shop_request('/shop/produkte/' . $code . '.json'), true);
    if (!is_array($json) || !isset($json['data'])) {
        throw new ApiError('Warengruppe ' . $code . ': unerwartete Antwort (Login abgelaufen?)', 502);
    }
    $pdo = db();
    $st = $pdo->prepare(<<<SQL
        INSERT INTO articles (artnr, name, zusatz, gebinde, vpe, faktor, einheit, ek, staffel, mwst, hersteller, land,
                              qualitaet, merkmale, image, wg, top, bestand, ean, active, updated_at)
        VALUES (:artnr, :name, :zusatz, :gebinde, :vpe, :faktor, :einheit, :ek, :staffel, :mwst, :hersteller, :land,
                :qualitaet, :merkmale, :image, :wg, :top, :bestand, :ean, 1, datetime('now'))
        ON CONFLICT(artnr) DO UPDATE SET name = excluded.name, zusatz = excluded.zusatz, gebinde = excluded.gebinde,
            vpe = excluded.vpe, faktor = excluded.faktor, einheit = excluded.einheit, ek = excluded.ek,
            staffel = excluded.staffel, mwst = excluded.mwst, hersteller = excluded.hersteller, land = excluded.land,
            qualitaet = excluded.qualitaet, merkmale = excluded.merkmale, image = excluded.image, wg = excluded.wg,
            top = excluded.top, bestand = excluded.bestand, ean = excluded.ean, active = 1, updated_at = excluded.updated_at
        SQL);
    $cat = $pdo->prepare('INSERT OR IGNORE INTO article_cats (artnr, code) VALUES (?, ?)');
    $n = 0;
    $pdo->beginTransaction();
    $pdo->prepare('DELETE FROM article_cats WHERE code = ?')->execute([$code]);
    foreach ($json['data'] as $d) {
        if (empty($d['artnr']) || empty($d['staffelpreise'])) {
            continue;
        }
        $staffel = array_map(fn($s) => ['menge' => (float)$s['menge'], 'ek' => (float)$s['ek']], $d['staffelpreise']);
        $st->execute([
            'artnr' => (string)$d['artnr'],
            'name' => trim((string)($d['regaltext'] ?? '')),
            'zusatz' => trim((string)($d['regaltextzusatz'] ?? '')),
            'gebinde' => trim((string)($d['gebinde'] ?? '')),
            'vpe' => (float)($d['vpe'] ?? 1) ?: 1,
            'faktor' => isset($d['grundpreisfaktor']) ? (float)$d['grundpreisfaktor'] : null,
            'einheit' => trim((string)($d['grundpreiseinheit'] ?? 'Stk')),
            'ek' => $staffel[0]['ek'],
            'staffel' => json_encode($staffel),
            'mwst' => (int)($d['mwst'] ?? 7),
            'hersteller' => (string)($d['herkunft']['hersteller'] ?? $d['hersteller'] ?? ''),
            'land' => (string)($d['herkunft']['land'] ?? ''),
            'qualitaet' => (string)($d['herkunft']['qualitaet'] ?? ''),
            'merkmale' => json_encode(array_values(array_map(
                fn($k) => $json['merkmale'][$k]['label'] ?? $k, (array)($d['merkmale'] ?? [])))),
            'image' => (string)($d['image_src'] ?? ''),
            'wg' => (string)($d['inetwg'] ?? $code),
            'top' => $code,
            'bestand' => (int)($d['lisa']['bestand'] ?? 2),
            'ean' => (string)($d['ean'] ?? ''),
        ]);
        $cat->execute([(string)$d['artnr'], $code]);
        $n++;
    }
    $pdo->commit();
    return $n;
}

/** Nach vollständigem Abgleich: nicht mehr gelieferte Artikel ausblenden. */
function shop_sync_finish(string $startedAt): int
{
    $st = db()->prepare('UPDATE articles SET active = 0 WHERE updated_at < ? AND active = 1');
    $st->execute([$startedAt]);
    set_setting('sortiment_stand', date('Y-m-d H:i'));
    @unlink(shop_jar());
    return $st->rowCount();
}
