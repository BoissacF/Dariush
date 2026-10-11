<?php

header("Content-Type: application/json; charset=utf-8");
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type");

if ($_SERVER["REQUEST_METHOD"] === "OPTIONS") {
    http_response_code(204);
    exit;
}

if ($_SERVER["REQUEST_METHOD"] !== "POST") {
    http_response_code(405);
    echo json_encode(["error" => "Méthode non autorisée"], JSON_UNESCAPED_UNICODE);
    exit;
}

require_once __DIR__ . "/db.php";

$data = json_decode(file_get_contents("php://input"), true);
$codeUtilisateur = trim($data["code_utilisateur"] ?? "");

if ($codeUtilisateur === "") {
    http_response_code(400);
    echo json_encode(["error" => "Code utilisateur manquant"], JSON_UNESCAPED_UNICODE);
    exit;
}

try {
    $sql = "SELECT id
            FROM prof_autorise
            WHERE code_utilisateur = ?
            LIMIT 1";

    $stmt = $pdo->prepare($sql);
    $stmt->execute([$codeUtilisateur]);

    $prof = $stmt->fetch(PDO::FETCH_ASSOC);

    echo json_encode([
        "valide" => $prof ? true : false
    ], JSON_UNESCAPED_UNICODE);

} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode([
        "error" => "Erreur serveur",
        "details" => $e->getMessage()
    ], JSON_UNESCAPED_UNICODE);
}