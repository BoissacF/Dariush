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

// Suffixe identifiant une correction (4 étoiles de chaque côté)
const SUFFIXE_CORRECTION = "****correction****";

// Génère un lien court unique pour un nouvel exercice de correction
function genererLienCourtCorrection(PDO $pdo, int $longueur = 6): string
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

$input = json_decode(file_get_contents("php://input"), true);

$code           = trim($input["code_utilisateur"] ?? "");
$exerciceId     = (int)($input["exercice_id"] ?? 0);
$lienLong       = trim($input["lien_long"] ?? "");
$descriptif     = trim($input["descriptif"] ?? "");
$accesRestreint = isset($input["acces_restreint"]) ? (int)(bool)$input["acces_restreint"] : 0;
$correction     = !empty($input["correction"]) ? true : false;

$niveau = trim($input["niveau"] ?? "premiere");
$niveauxAutorises = ["premiere", "terminale", "debutant", "premiere2", "terminale2", "BAC", "superieur", "expert"];
if (!in_array($niveau, $niveauxAutorises, true)) $niveau = "premiere";

// Récupération du paramètre source (défaut = 'python' pour rétro-compatibilité)
$sourcesValides = ['python', 'linux', 'sql', 'js', 'autre'];
$source = isset($input["source"]) ? trim($input["source"]) : 'python';
if (!in_array($source, $sourcesValides, true)) {
    $source = 'python';
}

if ($code === "" || $exerciceId <= 0 || $lienLong === "" || $descriptif === "") {
    http_response_code(400);
    echo json_encode(["ok" => false, "error" => "Paramètres manquants"], JSON_UNESCAPED_UNICODE);
    exit;
}

try {
    $stmtProf = $pdo->prepare("SELECT id FROM prof_autorise WHERE code_utilisateur = ? LIMIT 1");
    $stmtProf->execute([$code]);
    $prof = $stmtProf->fetch();

    if (!$prof) {
        http_response_code(403);
        echo json_encode(["ok" => false, "error" => "Code utilisateur non reconnu"], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // L'exercice d'origine doit appartenir à ce prof et à cette source
    $stmtCheck = $pdo->prepare("SELECT id, descriptif, niveau FROM exercices WHERE id = ? AND prof_id = ? AND source = ? LIMIT 1");
    $stmtCheck->execute([$exerciceId, $prof["id"], $source]);
    $exercice = $stmtCheck->fetch(PDO::FETCH_ASSOC);

    if (!$exercice) {
        http_response_code(403);
        echo json_encode(["ok" => false, "error" => "Vous n'êtes pas autorisé à modifier cet exercice"], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // Nombre de pages du lien envoyé (utilisé dans les deux modes ci-dessous)
    $nbPages = compterPagesDepuisLien($lienLong);

    // ─────────────────────────────────────────────────────────────
    // MODE CORRECTION : on ne touche PAS à l'exercice sélectionné.
    // On crée (ou écrase) un exercice "correction" associé.
    // ─────────────────────────────────────────────────────────────
    if ($correction) {
        // On part TOUJOURS du descriptif de l'exercice d'origine en base,
        // pas du titre éventuellement modifié dans le champ texte côté client.
        $descriptifOrigine = (string)$exercice["descriptif"];

        // Sécurité : si jamais l'exercice sélectionné est déjà une correction,
        // on n'empile pas un second suffixe.
        if (substr($descriptifOrigine, -strlen(SUFFIXE_CORRECTION)) === SUFFIXE_CORRECTION) {
            $descriptifCorrection = $descriptifOrigine;
        } else {
            $descriptifCorrection = $descriptifOrigine . SUFFIXE_CORRECTION;
        }

        // Le niveau de la correction suit celui de l'exercice d'origine.
        $niveauCorrection = (string)$exercice["niveau"];

        // Existe-t-il déjà une correction pour cet exercice ?
        $stmtExist = $pdo->prepare("SELECT id FROM exercices WHERE prof_id = ? AND source = ? AND descriptif = ? LIMIT 1");
        $stmtExist->execute([$prof["id"], $source, $descriptifCorrection]);
        $correctionExistante = $stmtExist->fetch(PDO::FETCH_ASSOC);

        if ($correctionExistante) {
            // Écrasement de la correction existante
            $stmtUpd = $pdo->prepare("UPDATE exercices SET lien = ?, acces_restreint = ?, niveau = ?, nb_pages = ? WHERE id = ? AND prof_id = ? AND source = ?");
            $stmtUpd->execute([$lienLong, $accesRestreint, $niveauCorrection, $nbPages, $correctionExistante["id"], $prof["id"], $source]);

            echo json_encode(["ok" => true, "message" => "Correction mise à jour avec succès"], JSON_UNESCAPED_UNICODE);
        } else {
            // Création d'une nouvelle correction
            $lienCourt = genererLienCourtCorrection($pdo, 6);
            $stmtIns = $pdo->prepare("INSERT INTO exercices (niveau, descriptif, lien, lien_court, prof_id, acces_restreint, source, nb_pages) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
            $stmtIns->execute([$niveauCorrection, $descriptifCorrection, $lienLong, $lienCourt, $prof["id"], $accesRestreint, $source, $nbPages]);

            echo json_encode(["ok" => true, "message" => "Correction ajoutée avec succès"], JSON_UNESCAPED_UNICODE);
        }
        exit;
    }

    // ─────────────────────────────────────────────────────────────
    // MODE NORMAL : modification de l'exercice sélectionné
    // On NE met PAS à jour la colonne source : un exercice reste dans son type d'origine
    // ─────────────────────────────────────────────────────────────

    $ancienDescriptif = (string)$exercice["descriptif"];
    $ancienEstCorrection = (substr($ancienDescriptif, -strlen(SUFFIXE_CORRECTION)) === SUFFIXE_CORRECTION);

    // Si le prof renomme un exercice NORMAL (pas une correction) et que le titre a changé,
    // on renomme aussi sa correction associée pour ne pas casser le lien.
    if (!$ancienEstCorrection && $descriptif !== $ancienDescriptif) {
        $ancienDescriptifCorrection = $ancienDescriptif . SUFFIXE_CORRECTION;
        $nouveauDescriptifCorrection = $descriptif . SUFFIXE_CORRECTION;

        // L'ancienne correction existe-t-elle ?
        $stmtCorrExist = $pdo->prepare("SELECT id FROM exercices WHERE prof_id = ? AND source = ? AND descriptif = ? LIMIT 1");
        $stmtCorrExist->execute([$prof["id"], $source, $ancienDescriptifCorrection]);
        $corrExistante = $stmtCorrExist->fetch(PDO::FETCH_ASSOC);

        if ($corrExistante) {
            // Vérifier qu'aucune autre correction du même prof/source ne porte déjà le nouveau nom
            // (cas où un autre exercice s'appellerait déjà comme le nouveau titre et aurait sa correction)
            $stmtConflit = $pdo->prepare("SELECT id FROM exercices WHERE prof_id = ? AND source = ? AND descriptif = ? AND id <> ? LIMIT 1");
            $stmtConflit->execute([$prof["id"], $source, $nouveauDescriptifCorrection, (int)$corrExistante["id"]]);
            if ($stmtConflit->fetch(PDO::FETCH_ASSOC)) {
                http_response_code(409);
                echo json_encode([
                    "ok" => false,
                    "error" => "Un autre exercice porte déjà ce titre et possède sa propre correction. Renommage impossible."
                ], JSON_UNESCAPED_UNICODE);
                exit;
            }

            // Renommage de la correction associée
            $stmtRenomCorr = $pdo->prepare("UPDATE exercices SET descriptif = ? WHERE id = ? AND prof_id = ? AND source = ?");
            $stmtRenomCorr->execute([$nouveauDescriptifCorrection, (int)$corrExistante["id"], $prof["id"], $source]);
        }
    }

    // Mise à jour de l'exercice lui-même
    $stmtUpdate = $pdo->prepare("UPDATE exercices SET lien = ?, descriptif = ?, acces_restreint = ?, niveau = ?, nb_pages = ? WHERE id = ? AND prof_id = ? AND source = ?");
    $stmtUpdate->execute([$lienLong, $descriptif, $accesRestreint, $niveau, $nbPages, $exerciceId, $prof["id"], $source]);

    echo json_encode(["ok" => true, "message" => "Exercice modifié avec succès"], JSON_UNESCAPED_UNICODE);

} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(["ok" => false, "error" => "Erreur serveur : " . $e->getMessage()], JSON_UNESCAPED_UNICODE);
}