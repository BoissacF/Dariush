<?php

header("Content-Type: application/json; charset=utf-8");
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: GET, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type");

if ($_SERVER["REQUEST_METHOD"] === "OPTIONS") {
    http_response_code(204);
    exit;
}

if ($_SERVER["REQUEST_METHOD"] !== "GET") {
    http_response_code(405);
    echo json_encode([
        "ok" => false,
        "error" => "Méthode non autorisée"
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

require_once __DIR__ . "/db.php";

$identifiant = trim($_GET["sid"] ?? "");

if ($identifiant === "" || !preg_match('/^\d{12}$/', $identifiant)) {
    http_response_code(400);
    echo json_encode([
        "ok" => false,
        "error" => "Identifiant invalide"
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

try {
    $stmt = $pdo->prepare("
        SELECT contenu, date_expiration
        FROM stockage_lien
        WHERE identifiant = ?
        LIMIT 1
    ");
    $stmt->execute([$identifiant]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$row) {
        http_response_code(404);
        echo json_encode([
            "ok" => false,
            "error" => "Lien court introuvable"
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    if (!empty($row["date_expiration"])) {
        $nowUtc = new DateTime("now", new DateTimeZone("UTC"));
        $expirationUtc = new DateTime($row["date_expiration"], new DateTimeZone("UTC"));

        if ($nowUtc > $expirationUtc) {
            http_response_code(410);
            echo json_encode([
                "ok" => false,
                "error" => "Lien court expiré"
            ], JSON_UNESCAPED_UNICODE);
            exit;
        }
    }

    echo json_encode([
        "ok" => true,
        "suffixe" => $row["contenu"]
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode([
        "ok" => false,
        "error" => "Erreur serveur lors de la récupération du lien",
        "details" => $e->getMessage()
    ], JSON_UNESCAPED_UNICODE);
}