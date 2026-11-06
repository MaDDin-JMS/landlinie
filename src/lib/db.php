<?php
declare(strict_types=1);

// Datenbank (SQLite in data/, per .htaccess gesperrt) und Schema-Migration.

function config(): array
{
    static $cfg = null;
    if ($cfg === null) {
        $f = __DIR__ . '/../data/config.php';
        $cfg = is_file($f) ? (require $f) : [];
    }
    return $cfg;
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo !== null) {
        return $pdo;
    }
    $file = config()['db_file'] ?? (__DIR__ . '/../data/bestellung.sqlite');
    $pdo = new PDO('sqlite:' . $file, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $pdo->exec('PRAGMA foreign_keys = ON');
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA busy_timeout = 5000');
    migrate($pdo);
    return $pdo;
}

function migrate(PDO $pdo): void
{
    $version = (int)$pdo->query('PRAGMA user_version')->fetchColumn();
    $steps = [
        1 => <<<SQL
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                pin_hash TEXT NOT NULL,
                is_admin INTEGER NOT NULL DEFAULT 0,
                active INTEGER NOT NULL DEFAULT 1,
                failed INTEGER NOT NULL DEFAULT 0,
                locked_until INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE categories (
                code TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                sort INTEGER NOT NULL DEFAULT 0,
                top INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE articles (
                artnr TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                zusatz TEXT NOT NULL DEFAULT '',
                gebinde TEXT NOT NULL DEFAULT '',
                vpe REAL NOT NULL DEFAULT 1,
                faktor REAL,
                einheit TEXT NOT NULL DEFAULT 'Stk',
                ek REAL NOT NULL DEFAULT 0,
                staffel TEXT NOT NULL DEFAULT '[]',
                mwst INTEGER NOT NULL DEFAULT 7,
                hersteller TEXT NOT NULL DEFAULT '',
                land TEXT NOT NULL DEFAULT '',
                qualitaet TEXT NOT NULL DEFAULT '',
                merkmale TEXT NOT NULL DEFAULT '[]',
                image TEXT NOT NULL DEFAULT '',
                wg TEXT NOT NULL DEFAULT '',
                top TEXT NOT NULL DEFAULT '',
                bestand INTEGER NOT NULL DEFAULT 2,
                ean TEXT NOT NULL DEFAULT '',
                active INTEGER NOT NULL DEFAULT 1,
                pfand REAL NOT NULL DEFAULT 0,
                pfand_text TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX articles_wg ON articles(wg);
            CREATE INDEX articles_top ON articles(top);
            CREATE TABLE rounds (
                id INTEGER PRIMARY KEY,
                title TEXT NOT NULL,
                deadline TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'offen',
                extra_kosten REAL NOT NULL DEFAULT 0,
                extra_text TEXT NOT NULL DEFAULT 'Kontoführung',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                closed_at TEXT
            );
            CREATE TABLE items (
                id INTEGER PRIMARY KEY,
                round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
                artnr TEXT NOT NULL REFERENCES articles(artnr),
                owner_id INTEGER NOT NULL REFERENCES users(id),
                mode TEXT NOT NULL CHECK (mode IN ('allein','muss','kann')),
                cases INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'aktiv',
                delivered INTEGER NOT NULL DEFAULT 1,
                note TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX items_round ON items(round_id);
            CREATE TABLE allocs (
                id INTEGER PRIMARY KEY,
                item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id),
                qty REAL NOT NULL,
                actual REAL,
                UNIQUE (item_id, user_id)
            );
            CREATE TABLE payments (
                round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
                user_id INTEGER NOT NULL REFERENCES users(id),
                paid INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (round_id, user_id)
            );
            CREATE TABLE pfand (
                id INTEGER PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id),
                round_id INTEGER REFERENCES rounds(id) ON DELETE SET NULL,
                item_id INTEGER,
                betrag REAL NOT NULL,
                text TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                created_by INTEGER
            );
            CREATE TABLE log (
                id INTEGER PRIMARY KEY,
                ts TEXT NOT NULL DEFAULT (datetime('now')),
                user_id INTEGER,
                round_id INTEGER,
                text TEXT NOT NULL
            );
            CREATE TABLE settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            INSERT INTO settings (key, value) VALUES ('export_menge', 'gebinde');
        SQL,
        // Ein Artikel kann in mehreren Hauptgruppen stehen (z. B. Trocken und Großgebinde)
        2 => <<<SQL
            CREATE TABLE article_cats (
                artnr TEXT NOT NULL,
                code TEXT NOT NULL,
                PRIMARY KEY (artnr, code)
            );
        SQL,
        3 => <<<SQL
            CREATE TABLE favorites (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                artnr TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                PRIMARY KEY (user_id, artnr)
            );
        SQL,
        // Pfand wird nicht berechnet, nur nachgehalten: je Eintrag "zurückgegeben"
        4 => <<<SQL
            ALTER TABLE pfand ADD COLUMN qty REAL NOT NULL DEFAULT 1;
            ALTER TABLE pfand ADD COLUMN returned_at TEXT;
        SQL,
        // Landlinie-Rechnung je Runde: E-Preis (netto je Einheit) prüfen.
        // round_prices friert den Preis der Runde ein: ek_bestellt = Shop-Preis
        // bei der ersten Prüfung, ek = endgültiger Preis (teurer auf der
        // Rechnung → Rechnungspreis, sonst bleibt der bestellte Preis).
        5 => <<<SQL
            CREATE TABLE invoices (
                round_id INTEGER PRIMARY KEY REFERENCES rounds(id) ON DELETE CASCADE,
                nr TEXT NOT NULL,
                datum TEXT NOT NULL DEFAULT '',
                netto REAL,
                uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
                uploaded_by INTEGER
            );
            CREATE TABLE invoice_lines (
                round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
                artnr TEXT NOT NULL,
                epreis REAL,
                gpreis REAL,
                gesamt REAL,
                me TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (round_id, artnr)
            );
            CREATE TABLE round_prices (
                round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
                artnr TEXT NOT NULL,
                ek_bestellt REAL NOT NULL,
                ek_rechnung REAL,
                ek REAL NOT NULL,
                PRIMARY KEY (round_id, artnr)
            );
        SQL,
    ];
    foreach ($steps as $v => $sql) {
        if ($v > $version) {
            $pdo->beginTransaction();
            $pdo->exec($sql);
            $pdo->exec('PRAGMA user_version = ' . $v);
            $pdo->commit();
        }
    }
}

function setting(string $key, ?string $default = null): ?string
{
    $st = db()->prepare('SELECT value FROM settings WHERE key = ?');
    $st->execute([$key]);
    $v = $st->fetchColumn();
    return $v === false ? $default : (string)$v;
}

function set_setting(string $key, string $value): void
{
    db()->prepare('INSERT INTO settings (key, value) VALUES (?, ?)
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value')->execute([$key, $value]);
}

function log_event(?int $userId, ?int $roundId, string $text): void
{
    db()->prepare('INSERT INTO log (user_id, round_id, text) VALUES (?, ?, ?)')
        ->execute([$userId, $roundId, $text]);
}
