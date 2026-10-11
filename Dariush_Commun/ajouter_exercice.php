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

const MAX_EXERCICE_LINK_BYTES = 307200; // 300 * 1024

function genererLienCourtExercice(PDO $pdo, int $longueur = 6): string
{
    $alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    $maxIndex = strlen($alphabet) - 1;

    for ($essai = 0; $essai < 30; $essai++) {
        $code = '';

        for ($i = 0; $i < $longueur; $i++) {
            $code .= $alphabet[random_int(0, $maxIndex)];
        }

        $stmtCheck = $pdo->prepare("SELECT id FROM exercices WHERE lien_court = ? LIMIT 1");
        $stmtCheck->execute([$code]);

        if (!$stmtCheck->fetch(PDO::FETCH_ASSOC)) {
            return $code;
        }
    }

    throw new Exception("Impossible de générer un lien court unique");
}

// Compte le nombre de pages d'un exercice à partir de son lien (buildLink),
// en comptant les paramètres "code", "code2", "code3", ... présents dans l'URL.
function compterPagesDepuisLien(string $lien): int
{
    $query = parse_url($lien, PHP_URL_QUERY);
    if (!$query) {
        return 1;
    }

    parse_str($query, $params);

    $nb = 0;
    foreach ($params as $cle => $valeur) {
        if ($cle === "code" || preg_match('/^code\d+$/', $cle)) {
            $nb++;
        }
    }

    return $nb > 0 ? $nb : 1;
}

$rawInput = file_get_contents("php://input");
$data = json_decode($rawInput, true);

if (!is_array($data)) {
    http_response_code(400);
    echo json_encode(["error" => "JSON invalide"], JSON_UNESCAPED_UNICODE);
    exit;
}

$codeUtilisateur = trim($data["code_utilisateur"] ?? "");
$niveau = trim($data["niveau"] ?? "");
$descriptif = trim($data["descriptif"] ?? "");
$lien = (string)($data["lien"] ?? "");
$accesRestreint = !empty($data["acces_restreint"]) ? 1 : 0;

// Récupération du paramètre source (défaut = 'python' pour rétro-compatibilité)
$sourcesValides = ['python', 'linux', 'sql', 'js', 'autre'];
$source = isset($data["source"]) ? trim($data["source"]) : 'python';
if (!in_array($source, $sourcesValides, true)) {
    $source = 'python';
}

$niveauxAutorises = ["premiere", "terminale", "debutant", "premiere2", "terminale2", "BAC", "superieur", "expert"];

if ($codeUtilisateur === "" || $niveau === "" || trim($descriptif) === "" || $lien === "") {
    http_response_code(400);
    echo json_encode(["error" => "Champs manquants"], JSON_UNESCAPED_UNICODE);
    exit;
}

if (!in_array($niveau, $niveauxAutorises, true)) {
    http_response_code(400);
    echo json_encode(["error" => "Niveau invalide"], JSON_UNESCAPED_UNICODE);
    exit;
}

if (mb_strlen($lien, '8bit') > MAX_EXERCICE_LINK_BYTES) {
    http_response_code(413);
    echo json_encode([
        "error" => "Exercice trop volumineux : limite 300 ko"
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
        echo json_encode(["error" => "Code utilisateur invalide"], JSON_UNESCAPED_UNICODE);
        exit;
    }

    $lienCourt = genererLienCourtExercice($pdo, 6);
    $nbPages = compterPagesDepuisLien($lien);

    $sqlInsert = "INSERT INTO exercices (niveau, descriptif, lien, lien_court, prof_id, acces_restreint, source, nb_pages)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
    $stmtInsert = $pdo->prepare($sqlInsert);
    $stmtInsert->execute([
        $niveau,
        trim($descriptif),
        $lien,
        $lienCourt,
        $prof["id"],
        $accesRestreint,
        $source,
        $nbPages
    ]);

    // URL de retour adaptée selon la source
    $baseUrl = ($source === 'linux')
        ? "https://physalgo.fr/Dariush_Linux/index.html?exo="
        : "https://physalgo.fr/Dariush_Python/index.html?exo=";

    echo json_encode([
        "success" => true,
        "message" => "Exercice ajouté avec succès",
        "lien_court" => $lienCourt,
        "url_courte" => $baseUrl . $lienCourt
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode([
        "error" => "Erreur serveur",
        "details" => $e->getMessage()
    ], JSON_UNESCAPED_UNICODE);
}