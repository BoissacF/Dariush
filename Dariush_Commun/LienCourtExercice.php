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

$code = trim($_GET["code"] ?? "");

// Filtrage optionnel par source : si non fourni, on ne filtre pas
$sourcesValides = ['python', 'linux', 'sql', 'js', 'autre'];
$source = isset($_GET["source"]) ? trim($_GET["source"]) : null;
if ($source !== null && !in_array($source, $sourcesValides, true)) {
    $source = null;
}

if ($code === "" || !preg_match('/^[A-Za-z0-9]{6}$/', $code)) {
    http_response_code(400);
    echo json_encode([
        "ok" => false,
        "error" => "Code de lien court invalide"
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

try {
    if ($source !== null) {
        $stmt = $pdo->prepare("SELECT id, lien, descriptif, source FROM exercices WHERE lien_court = ? AND source = ? LIMIT 1");
        $stmt->execute([$code, $source]);
    } else {
        $stmt = $pdo->prepare("SELECT id, lien, descriptif, source FROM exercices WHERE lien_court = ? LIMIT 1");
        $stmt->execute([$code]);
    }
    $exercice = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$exercice) {
        http_response_code(404);
        echo json_encode([
            "ok" => false,
            "error" => "Exercice introuvable"
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    echo json_encode([
        "ok" => true,
        "lien" => $exercice["lien"],
        "descriptif" => $exercice["descriptif"],
        "source" => $exercice["source"]
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode([
        "ok" => false,
        "error" => "Erreur serveur lors de la récupération du lien court d'exercice",
        "details" => $e->getMessage()
    ], JSON_UNESCAPED_UNICODE);
}