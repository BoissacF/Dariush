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
    echo json_encode(["error" => "Méthode non autorisée"], JSON_UNESCAPED_UNICODE);
    exit;
}

require_once __DIR__ . "/db.php";

// Récupération du paramètre source (défaut = 'python' pour rétro-compatibilité)
$sourcesValides = ['python', 'linux', 'sql', 'js', 'autre'];
$source = isset($_GET['source']) ? trim($_GET['source']) : 'python';
if (!in_array($source, $sourcesValides, true)) {
    $source = 'python';
}

try {
    $sql = "SELECT
                e.id,
                e.niveau,
                e.descriptif,
                e.lien_court,
                e.acces_restreint,
                e.prof_id,
                e.source,
                e.nb_pages,
                p.nom,
                p.prenom
            FROM exercices e
            LEFT JOIN prof_autorise p ON e.prof_id = p.id
            WHERE e.source = :source
            ORDER BY e.descriptif ASC";

    $stmt = $pdo->prepare($sql);
    $stmt->execute([':source' => $source]);

    $resultats = $stmt->fetchAll();

    // On ne renvoie PAS le lien complet pour les exercices restreints
    foreach ($resultats as &$row) {
        $row['acces_restreint'] = (int)($row['acces_restreint'] ?? 0);
        $row['nb_pages'] = (int)($row['nb_pages'] ?? 1);
    }
    unset($row);

    echo json_encode($resultats, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode([
        "error" => "Erreur SQL lors du chargement des exercices",
        "details" => $e->getMessage()
    ], JSON_UNESCAPED_UNICODE);
}