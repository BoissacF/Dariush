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

// Suffixe identifiant une correction (4 étoiles de chaque côté)
const SUFFIXE_CORRECTION = "****correction****";

$input = json_decode(file_get_contents("php://input"), true);

$code = trim($input["code_utilisateur"] ?? "");
$exerciceId = (int)($input["exercice_id"] ?? 0);

// Récupération du paramètre source (défaut = 'python' pour rétro-compatibilité)
$sourcesValides = ['python', 'linux', 'sql', 'js', 'autre'];
$source = isset($input["source"]) ? trim($input["source"]) : 'python';
if (!in_array($source, $sourcesValides, true)) {
    $source = 'python';
}

if ($code === "" || $exerciceId <= 0) {
    http_response_code(400);
    echo json_encode([
        "ok" => false,
        "error" => "Paramètres manquants"
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

try {
    $sqlProf = "SELECT id
                FROM prof_autorise
                WHERE code_utilisateur = ?
                LIMIT 1";
    $stmtProf = $pdo->prepare($sqlProf);
    $stmtProf->execute([$code]);
    $prof = $stmtProf->fetch();

    if (!$prof) {
        http_response_code(403);
        echo json_encode([
            "ok" => false,
            "error" => "Code utilisateur non reconnu"
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $sqlCheck = "SELECT id, descriptif
                 FROM exercices
                 WHERE id = ? AND prof_id = ? AND source = ?
                 LIMIT 1";
    $stmtCheck = $pdo->prepare($sqlCheck);
    $stmtCheck->execute([$exerciceId, $prof["id"], $source]);
    $exercice = $stmtCheck->fetch(PDO::FETCH_ASSOC);

    if (!$exercice) {
        http_response_code(403);
        echo json_encode([
            "ok" => false,
            "error" => "Vous n’êtes pas autorisé à supprimer cet exercice"
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $descriptif = (string)$exercice["descriptif"];
    $estCorrection = (substr($descriptif, -strlen(SUFFIXE_CORRECTION)) === SUFFIXE_CORRECTION);

    // Suppression de l'exercice sélectionné
    $sqlDelete = "DELETE FROM exercices
                  WHERE id = ? AND prof_id = ? AND source = ?";
    $stmtDelete = $pdo->prepare($sqlDelete);
    $stmtDelete->execute([$exerciceId, $prof["id"], $source]);

    // Si on supprime un exercice NORMAL, on supprime aussi sa correction associée.
    // (Si on supprime une correction, on ne touche à rien d'autre.)
    if (!$estCorrection) {
        $descriptifCorrection = $descriptif . SUFFIXE_CORRECTION;
        $sqlDeleteCorr = "DELETE FROM exercices
                          WHERE prof_id = ? AND source = ? AND descriptif = ?";
        $stmtDeleteCorr = $pdo->prepare($sqlDeleteCorr);
        $stmtDeleteCorr->execute([$prof["id"], $source, $descriptifCorrection]);
    }

    echo json_encode([
        "ok" => true,
        "message" => "Exercice supprimé"
    ], JSON_UNESCAPED_UNICODE);

} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode([
        "ok" => false,
        "error" => "Erreur serveur lors de la suppression"
    ], JSON_UNESCAPED_UNICODE);
}