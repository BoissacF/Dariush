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

$input = json_decode(file_get_contents("php://input"), true);

$urlComplete = trim($input["url_complete"] ?? "");
$codeUtilisateur = trim($input["code_utilisateur"] ?? "");
$dureeMode = trim($input["duree_mode"] ?? "1mois"); 
// "1mois" ou "permanent"

if ($urlComplete === "") {
    http_response_code(400);
    echo json_encode([
        "ok" => false,
        "error" => "URL manquante"
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

if (!filter_var($urlComplete, FILTER_VALIDATE_URL)) {
    http_response_code(400);
    echo json_encode([
        "ok" => false,
        "error" => "URL invalide"
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

// Longueur cible du préfixe conservé dans l’URL finale
$MAX_PREFIX_LENGTH = 1700;

if (mb_strlen($urlComplete, '8bit') <= $MAX_PREFIX_LENGTH) {
    echo json_encode([
        "ok" => true,
        "short_url" => $urlComplete,
        "stored" => false
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

$codeValide = false;
$codeStocke = null;

try {
    if ($codeUtilisateur !== "") {
        $stmt = $pdo->prepare("
            SELECT id
            FROM prof_autorise
            WHERE code_utilisateur = ?
            LIMIT 1
        ");
        $stmt->execute([$codeUtilisateur]);
        $prof = $stmt->fetch(PDO::FETCH_ASSOC);

        if ($prof) {
            $codeValide = true;
            $codeStocke = $codeUtilisateur;
        }
    }

    // Si mode permanent demandé mais code invalide => refus
    if ($dureeMode === "permanent" && !$codeValide) {
        http_response_code(403);
        echo json_encode([
            "ok" => false,
            "error" => "Code utilisateur non reconnu pour un lien permanent"
        ], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // expiration
    $dateExpiration = null;
    if (!$codeValide) {
        $dateExpiration = (new DateTime("now", new DateTimeZone("UTC")))
            ->modify("+1 month")
            ->format("Y-m-d H:i:s");
    }

    // On garde de la marge pour "&sid=..."
    $reserve = 30;
    $prefixLength = max(1000, $MAX_PREFIX_LENGTH - $reserve);

    $prefix = substr($urlComplete, 0, $prefixLength);
    $suffix = substr($urlComplete, $prefixLength);

    if ($suffix === "") {
        echo json_encode([
            "ok" => true,
            "short_url" => $urlComplete,
            "stored" => false
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    // Génération identifiant unique
    $identifiant = null;
    for ($i = 0; $i < 10; $i++) {
        $candidate = str_pad((string) random_int(0, 999999999999), 12, "0", STR_PAD_LEFT);

        $stmtCheck = $pdo->prepare("SELECT id FROM stockage_lien WHERE identifiant = ? LIMIT 1");
        $stmtCheck->execute([$candidate]);

        if (!$stmtCheck->fetch()) {
            $identifiant = $candidate;
            break;
        }
    }

    if ($identifiant === null) {
        throw new Exception("Impossible de générer un identifiant unique");
    }

    $stmtInsert = $pdo->prepare("
        INSERT INTO stockage_lien (identifiant, contenu, date_expiration, code_utilisateur)
        VALUES (?, ?, ?, ?)
    ");
    $stmtInsert->execute([
        $identifiant,
        $suffix,
        $dateExpiration,
        $codeStocke
    ]);

    $separator = (strpos($prefix, "?") !== false) ? "&" : "?";
    $shortUrl = $prefix . $separator . "sid=" . rawurlencode($identifiant);

    echo json_encode([
        "ok" => true,
        "short_url" => $shortUrl,
        "stored" => true,
        "permanent" => $codeValide
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode([
        "ok" => false,
        "error" => "Erreur serveur lors de la création du lien court",
        "details" => $e->getMessage()
    ], JSON_UNESCAPED_UNICODE);
}