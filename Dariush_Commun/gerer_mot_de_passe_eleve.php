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
    echo json_encode(["ok" => false, "error" => "Méthode non autorisée"], JSON_UNESCAPED_UNICODE);
    exit;
}

require_once __DIR__ . "/db.php";

$data = json_decode(file_get_contents("php://input"), true);
if (!is_array($data)) {
    http_response_code(400);
    echo json_encode(["ok" => false, "error" => "JSON invalide"], JSON_UNESCAPED_UNICODE);
    exit;
}

$codeUtilisateur = trim($data["code_utilisateur"] ?? "");
$motDePasse      = trim($data["mot_de_passe"] ?? "");

if ($codeUtilisateur === "" || $motDePasse === "") {
    http_response_code(400);
    echo json_encode(["ok" => false, "error" => "Champs manquants"], JSON_UNESCAPED_UNICODE);
    exit;
}

if (mb_strlen($motDePasse) < 6) {
    http_response_code(400);
    echo json_encode(["ok" => false, "error" => "Le mot de passe doit faire au moins 6 caractères"], JSON_UNESCAPED_UNICODE);
    exit;
}

try {
    // Purge automatique des mots de passe de plus d'un mois
    $pdo->exec("DELETE FROM mots_de_passe_eleve WHERE date < (NOW() - INTERVAL 1 MONTH)");

    // Vérifier le code utilisateur du prof et récupérer son nom
    $stmtProf = $pdo->prepare("SELECT id, nom, prenom FROM prof_autorise WHERE code_utilisateur = ? LIMIT 1");
    $stmtProf->execute([$codeUtilisateur]);
    $prof = $stmtProf->fetch(PDO::FETCH_ASSOC);

    if (!$prof) {
        http_response_code(403);
        echo json_encode(["ok" => false, "error" => "Code utilisateur non reconnu"], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $nomProf = trim(($prof["prenom"] ?? "") . " " . ($prof["nom"] ?? ""));
    if ($nomProf === "") $nomProf = "Professeur #" . $prof["id"];

    // Enregistrer le nouveau mot de passe provisoire
    $stmtIns = $pdo->prepare("INSERT INTO mots_de_passe_eleve (nom_prof, mot_de_passe, date) VALUES (?, ?, NOW())");
    $stmtIns->execute([$nomProf, $motDePasse]);

    // Date d'expiration indicative (création + 1 mois)
    $expire = (new DateTime())->modify("+1 month")->format("d/m/Y");

    echo json_encode([
        "ok" => true,
        "message" => "Mot de passe enregistré",
        "mot_de_passe" => $motDePasse,
        "expire_le" => $expire
    ], JSON_UNESCAPED_UNICODE);

} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(["ok" => false, "error" => "Erreur serveur", "details" => $e->getMessage()], JSON_UNESCAPED_UNICODE);
}