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

$rawInput = file_get_contents("php://input");
$data = json_decode($rawInput, true);

if (!is_array($data)) {
    http_response_code(400);
    echo json_encode(["error" => "JSON invalide"], JSON_UNESCAPED_UNICODE);
    exit;
}

$codeUtilisateur  = trim($data["code_utilisateur"] ?? "");
$motDePasseEleve  = trim($data["mot_de_passe_eleve"] ?? "");
$lienCourt        = trim($data["lien_court"] ?? "");

if ($lienCourt === "" || ($codeUtilisateur === "" && $motDePasseEleve === "")) {
    http_response_code(400);
    echo json_encode(["error" => "Champs manquants"], JSON_UNESCAPED_UNICODE);
    exit;
}

try {
    $autorise = false;

    if ($codeUtilisateur !== "") {
        // --- Voie professeur ---
        $stmtProf = $pdo->prepare("SELECT id FROM prof_autorise WHERE code_utilisateur = ? LIMIT 1");
        $stmtProf->execute([$codeUtilisateur]);
        $prof = $stmtProf->fetch(PDO::FETCH_ASSOC);

        if (!$prof) {
            http_response_code(403);
            echo json_encode(["error" => "Code utilisateur invalide"], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $autorise = true;

    } else {
        // --- Voie élève (mot de passe provisoire) ---
        // Purge automatique des mots de passe de plus d'un mois
        $pdo->exec("DELETE FROM mots_de_passe_eleve WHERE date < (NOW() - INTERVAL 1 MONTH)");

        $stmtMdp = $pdo->prepare("SELECT id FROM mots_de_passe_eleve WHERE mot_de_passe = ? AND date >= (NOW() - INTERVAL 1 MONTH) LIMIT 1");
        $stmtMdp->execute([$motDePasseEleve]);
        $mdp = $stmtMdp->fetch(PDO::FETCH_ASSOC);

        if (!$mdp) {
            http_response_code(403);
            echo json_encode(["error" => "Mot de passe élève invalide ou expiré"], JSON_UNESCAPED_UNICODE);
            exit;
        }
        $autorise = true;
    }

    if (!$autorise) {
        http_response_code(403);
        echo json_encode(["error" => "Accès refusé"], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // Récupérer le lien de l'exercice restreint
    $stmtEx = $pdo->prepare("SELECT lien FROM exercices WHERE lien_court = ? AND acces_restreint = 1 LIMIT 1");
    $stmtEx->execute([$lienCourt]);
    $exercice = $stmtEx->fetch(PDO::FETCH_ASSOC);

    if (!$exercice) {
        http_response_code(404);
        echo json_encode(["error" => "Exercice introuvable ou non restreint"], JSON_UNESCAPED_UNICODE);
        exit;
    }

    echo json_encode([
        "ok" => true,
        "lien" => $exercice["lien"]
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode([
        "error" => "Erreur serveur",
        "details" => $e->getMessage()
    ], JSON_UNESCAPED_UNICODE);
}