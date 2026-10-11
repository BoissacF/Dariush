<?php

require_once __DIR__ . "/db.php";

try {
    $stmt = $pdo->prepare("
        DELETE FROM stockage_lien
        WHERE date_expiration IS NOT NULL
          AND date_expiration < UTC_TIMESTAMP()
    ");
    $stmt->execute();

    echo "OK - " . $stmt->rowCount() . " lien(s) supprimé(s)";
} catch (Throwable $e) {
    http_response_code(500);
    echo "ERREUR - " . $e->getMessage();
}