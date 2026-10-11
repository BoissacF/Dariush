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
    echo json_encode([
        "ok" => false,
        "error" => "Méthode non autorisée"
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

require_once __DIR__ . "/db.php";

$data = json_decode(file_get_contents("php://input"), true);
$codeUtilisateur = trim($data["code_utilisateur"] ?? "");

// Récupération du paramètre source (défaut = 'python' pour rétro-compatibilité)
$sourcesValides = ['python', 'linux', 'sql', 'js', 'autre'];
$source = isset($data["source"]) ? trim($data["source"]) : 'python';
if (!in_array($source, $sourcesValides, true)) {
    $source = 'python';
}

if ($codeUtilisateur === "") {
    http_response_code(400);
    echo json_encode([
        "ok" => false,
        "error" => "Code utilisateur manquant"
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

try {
    $sqlProf = "SELECT id
                FROM prof_autorise
                WHERE code_utilisateur = ?
                LIMIT 1";
    $stmtProf = $pdo->prepare($sqlProf);
    $stmtProf->execute([$codeUtilisateur]);
    $prof = $stmtProf->fetch(PDO::FETCH_ASSOC);

    if (!$prof) {
        http_response_code(403);
        echo json_encode([
            "ok" => false,
            "error" => "Code utilisateur non reconnu"
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // Tri pedagogique et non alphabetique : sans FIELD(), 'BAC' passerait
    // avant 'debutant' dans la liste "Vos exercices".
    $sqlExercices = "SELECT id, niveau, descriptif, lien_court, acces_restreint, source
                 FROM exercices
                 WHERE prof_id = ? AND source = ?
                 ORDER BY FIELD(niveau, 'debutant', 'premiere', 'premiere2',
                                        'terminale', 'terminale2', 'BAC',
                                        'superieur', 'expert'),
                          descriptif ASC";
    $stmtExercices = $pdo->prepare($sqlExercices);
    $stmtExercices->execute([$prof["id"], $source]);
    $exercices = $stmtExercices->fetchAll(PDO::FETCH_ASSOC);

    echo json_encode([
        "ok" => true,
        "exercices" => $exercices
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode([
        "ok" => false,
        "error" => "Erreur serveur lors du chargement des exercices",
        "details" => $e->getMessage()
    ], JSON_UNESCAPED_UNICODE);
}