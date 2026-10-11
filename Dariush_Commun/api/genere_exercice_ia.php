<?php
/* =============================================================================
   genere_exercice_ia.php  —  Generation d'un notebook d'exercices
   -----------------------------------------------------------------------------
   Ne contient AUCUNE cle API : l'appel au moteur est delegue
   a ia.php (action "raw_chat"), qui gere le provider choisi et les codes
   raccourcis. La table `exercices` n'est jamais modifiee.

   Recoit (JSON POST) :
     provider, apiKey       -> transmis tels quels a ia.php
     themes        (array)  -> cles de themes cochees (logique OU)
     niveau_max    (int)    -> rang plafond : 1, 3, 5 ou 7
     nombre        (int)    -> nombre d'exercices voulus (1..20)
     pct_difficile (int)    -> % de difficiles (0..100)

   Renvoie :
     { ok:true, notebook:{ cells:[...] } }   ou   { ok:false, error:"..." }
   ============================================================================= */

header("Content-Type: application/json; charset=utf-8");
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Authorization");
ini_set("display_errors", 0);
@set_time_limit(120);

if ($_SERVER["REQUEST_METHOD"] === "OPTIONS") { http_response_code(204); exit; }
if ($_SERVER["REQUEST_METHOD"] !== "POST") {
    echo json_encode(["ok" => false, "error" => "Methode non autorisee"]); exit;
}

require_once __DIR__ . "/../db.php";   // $pdo

// URL de ia.php (meme serveur).
const IA_ENDPOINT = "https://physalgo.fr/Dariush_Commun/api/ia.php";

// Nombre maxi d'exemples injectes dans le prompt.
const MAX_EXEMPLES = 4;

// Liste figee des 30 themes valides (garde-fou contre des cles inattendues).
$THEMES_VALIDES = [
    "listes","tuples","dictionnaires","ensembles","chaines","conditions","boucles",
    "fonctions","poo","recursivite","exceptions","fichiers","operateurs_logiques",
    "recherche","parcours","tris","complexite","diviser_pour_regner","prog_dynamique",
    "gloutons","dichotomie","abr","piles_files","arbres","graphes","tables_hachage",
    "reseaux","representation_donnees","booleen_logique","type_bac",
];

/* ----------------------------- ENTREE ------------------------------------- */

$data = json_decode(file_get_contents("php://input"), true);
if (!is_array($data)) {
    echo json_encode(["ok" => false, "error" => "Requete invalide"]); exit;
}

$provider = trim((string)($data["provider"] ?? ""));
$apiKey   = trim((string)($data["apiKey"]   ?? ""));
$themes   = is_array($data["themes"] ?? null) ? $data["themes"] : [];
$niveauMax = (int)($data["niveau_max"] ?? 5);
$nombre    = (int)($data["nombre"] ?? 5);
$pctDiff   = (int)($data["pct_difficile"] ?? 50);

if ($apiKey === "") {
    echo json_encode(["ok" => false, "error" => "Aucune cle API : validez un moteur dans le panneau IA."]); exit;
}

// Nettoyage / bornage.
$themes = array_values(array_intersect($themes, $THEMES_VALIDES));
if (!$themes) {
    echo json_encode(["ok" => false, "error" => "Cochez au moins un theme."]); exit;
}
if (!in_array($niveauMax, [1, 3, 5, 7], true)) { $niveauMax = 5; }
$nombre  = max(1, min(20, $nombre));
$pctDiff = max(0, min(100, $pctDiff));

// Repartition facile/difficile demandee.
$nbDiff   = (int)round($nombre * $pctDiff / 100);
$nbFacile = $nombre - $nbDiff;

/* ------------------- SELECTION DES EXEMPLES (le RAG) ----------------------
   On prend des notebooks <= niveau plafond, ayant AU MOINS un theme coche a
   true (logique OU). On privilegie les corriges, et on essaie d'avoir un
   melange facile/difficile proche du ratio demande. */

function lignesParDifficulte(PDO $pdo, int $niveauMax, array $themes, string $difficulte, int $limit): array {
    if ($limit <= 0) return [];
    // Construit un OR de JSON_EXTRACT pour les themes coches.
    $conds = [];
    $params = [":niv" => $niveauMax, ":diff" => $difficulte];
    foreach ($themes as $i => $t) {
        $cle = ":t$i";
        $conds[] = "JSON_EXTRACT(themes, CONCAT('$.', $cle)) = true";
        $params[$cle] = $t;
    }
    $orThemes = implode(" OR ", $conds);

    $sql = "SELECT descriptif, contenu, a_correction, difficulte
            FROM rag_exercices
            WHERE source = 'python'
              AND themes IS NOT NULL
              AND niveau_rang <= :niv
              AND difficulte = :diff
              AND ($orThemes)
            ORDER BY a_correction DESC, RAND()
            LIMIT $limit";
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    return $stmt->fetchAll();
}

try {
    // On vise un melange refletant le curseur, dans la limite de MAX_EXEMPLES.
    $voulusDiff   = (int)round(MAX_EXEMPLES * $pctDiff / 100);
    $voulusFacile = MAX_EXEMPLES - $voulusDiff;

    $exDiff   = lignesParDifficulte($pdo, $niveauMax, $themes, "difficile", $voulusDiff);
    $exFacile = lignesParDifficulte($pdo, $niveauMax, $themes, "facile",   $voulusFacile);

    $exemples = array_merge($exDiff, $exFacile);

    // Si on n'a pas atteint MAX_EXEMPLES, on complete sans contrainte de difficulte.
    if (count($exemples) < MAX_EXEMPLES) {
        $manque = MAX_EXEMPLES - count($exemples);
        $dejaPris = array_column($exemples, "descriptif");
        $comp = lignesParDifficulte($pdo, $niveauMax, $themes, "facile", $manque + count($exemples));
        $comp = array_merge($comp, lignesParDifficulte($pdo, $niveauMax, $themes, "difficile", $manque + count($exemples)));
        foreach ($comp as $c) {
            if (count($exemples) >= MAX_EXEMPLES) break;
            if (!in_array($c["descriptif"], $dejaPris, true)) {
                $exemples[] = $c;
                $dejaPris[] = $c["descriptif"];
            }
        }
    }
} catch (Throwable $e) {
    echo json_encode(["ok" => false, "error" => "Erreur base : " . $e->getMessage()]); exit;
}

/* Quels themes coches (hors type_bac) n'ont AUCUN exemple a ce niveau ? */
$themesAbsents = [];
try {
    $themesAVerifier = array_values(array_diff($themes, ["type_bac"]));
    foreach ($themesAVerifier as $t) {
        $chemin = '$.' . $t;   // construit en PHP ; $t vient de la liste blanche
        $sql = "SELECT COUNT(*) FROM rag_exercices
                WHERE source = 'python' AND themes IS NOT NULL
                  AND niveau_rang <= :niv
                  AND JSON_EXTRACT(themes, :chemin) = true";
        $st = $pdo->prepare($sql);
        $st->execute([":niv" => $niveauMax, ":chemin" => $chemin]);
        if ((int)$st->fetchColumn() === 0) {
            $themesAbsents[] = $t;
        }
    }
} catch (Throwable $e) {
    // non bloquant : si le calcul echoue, on n'avertit simplement pas
    $themesAbsents = [];
}

/* ----------------------- ASSEMBLAGE DU PROMPT ------------------------------ */

$libelleNiveau = ["1" => "seconde", "3" => "premiere", "5" => "terminale", "7" => "superieur"][(string)$niveauMax] ?? "terminale";

// "type_bac" sert de commutateur de mode ; on l'enleve de la liste des themes a couvrir.
$modeBac = in_array("type_bac", $themes, true);
$themesContenu = array_values(array_diff($themes, ["type_bac"]));
$listeThemes = $themesContenu ? implode(", ", $themesContenu) : "notions de base";

if ($modeBac) {
    /* ----- MODE SUJET BAC : fil narratif unique + progression stricte ----- */
    $system =
"Tu es un concepteur de sujets de type baccalaureat NSI (niveau " . $libelleNiveau . ").\n" .
"Tu produis UN sujet construit et coherent, inspire du style des exemples fournis mais JAMAIS recopie.\n\n" .
"REGLES DU SUJET :\n" .
"- Invente UN contexte d'application concret, unique et ORIGINAL (sciences, transports, jeux,\n" .
"  commerce, biologie, musique, sport...), et garde CE MEME contexte sur tout le sujet.\n" .
"  Varie les univers a chaque generation. Ne reprends PAS les exemples cites ici : ce ne sont\n" .
"  que des illustrations de format.\n" .
"- Genere EXACTEMENT " . $nombre . " questions (une question = un exercice).\n" .
"- Environ " . $nbDiff . " difficiles et " . $nbFacile . " faciles (pour le niveau vise).\n" .
"- La structure centrale du sujet est : " . $listeThemes . ".\n" .
"- PROGRESSION OBLIGATOIRE : chaque question prolonge la precedente. Les questions reutilisent\n" .
"  les MEMES objets, classes ou donnees, les ameliorent ou les font evoluer. Il doit toujours y\n" .
"  avoir un lien explicite d'une question a la suivante (ex : Q1 construire la structure,\n" .
"  Q2 y inserer un element, Q3 la parcourir, etc.).\n" .
"- Toute structure annexe (file, pile...) n'est admise QUE si elle sert l'etude de la structure\n" .
"  centrale du sujet. Aucune question independante ni hors-sujet.\n" .
"- ALTERNE questions de cours/analyse (sans code) et questions avec code a ecrire.\n" .
"- Tout en francais. Enonces clairs. Code Python correct.\n\n" .
"GRAPHES ET ARBRES (si le theme s'y prete : graphes, arbres, arbres binaires, files de priorite,\n" .
"  reseaux, parcours...) :\n" .
"- Tu PEUX illustrer un enonce avec un schema en inserant, DANS une cellule markdown, un bloc\n" .
"  de code delimite par ```mermaid ... ``` (syntaxe Mermaid 'graph TD' ou 'graph LR').\n" .
"- Exemple d'arbre : ```mermaid\\ngraph TD\\n  A --> B\\n  A --> C\\n```\n" .
"- Exemple de graphe pondere : ```mermaid\\ngraph LR\\n  A ---|4| B\\n  B ---|2| C\\n```\n" .
"- N'utilise les graphes Mermaid QUE lorsqu'ils aident vraiment la comprehension. Pas de schema gratuit.\n" .
"- Le bloc mermaid doit etre du TEXTE valide a l'interieur de la cellule markdown (pas une cellule de code).\n\n" .
"FORMAT DE SORTIE (imperatif) :\n" .
"FORMAT DE SORTIE (imperatif) :\n" .
"- Reponds UNIQUEMENT par un objet JSON de notebook Jupyter : {\"cells\": [ ... ]}.\n" .
"- Une cellule d'introduction markdown peut presenter le contexte du sujet.\n" .
"- Question SANS code = cellule {\"cell_type\":\"markdown\",\"source\":\"...enonce...\"}.\n" .
"- Question AVEC code = cellule markdown (l'enonce) SUIVIE d'une cellule\n" .
"  {\"cell_type\":\"code\",\"source\":\"# a completer\\n...\"}.\n" .
"- N'ajoute aucune cle hors 'cells'. Pas de texte ni de balises hors du JSON.";
} else {
    /* ----- MODE INDEPENDANT : exercices autonomes sur le(s) theme(s) ----- */
    $system =
"Tu es un generateur d'exercices de NSI / Python pour le lycee (niveau " . $libelleNiveau . ").\n" .
"Tu produis des exercices NEUFS et INDEPENDANTS, inspires du style des exemples fournis mais JAMAIS recopies.\n\n" .
"REGLES DE CONTENU :\n" .
"- Genere EXACTEMENT " . $nombre . " questions (une question = un exercice).\n" .
"- Environ " . $nbDiff . " difficiles et " . $nbFacile . " faciles (pour le niveau vise).\n" .
"- CHAQUE exercice porte centralement sur : " . $listeThemes . ".\n" .
"- Les exercices sont AUTONOMES : pas de lien obligatoire entre eux, chacun se suffit a lui-meme.\n" .
"- ALTERNE des questions de cours (sans code) et des questions avec code a ecrire.\n" .
"- Tout en francais. Enonces clairs. Code Python correct.\n\n" .
"GRAPHES ET ARBRES (si le theme s'y prete : graphes, arbres, arbres binaires, files de priorite,\n" .
"  reseaux, parcours...) :\n" .
"- Tu PEUX illustrer un enonce avec un schema en inserant, DANS une cellule markdown, un bloc\n" .
"  de code delimite par ```mermaid ... ``` (syntaxe Mermaid 'graph TD' ou 'graph LR').\n" .
"- Exemple d'arbre : ```mermaid\\ngraph TD\\n  A --> B\\n  A --> C\\n```\n" .
"- Exemple de graphe pondere : ```mermaid\\ngraph LR\\n  A ---|4| B\\n  B ---|2| C\\n```\n" .
"- N'utilise les graphes Mermaid QUE lorsqu'ils aident vraiment la comprehension. Pas de schema gratuit.\n" .
"- Le bloc mermaid doit etre du TEXTE valide a l'interieur de la cellule markdown (pas une cellule de code).\n\n" .
"FORMAT DE SORTIE (imperatif) :\n" .
"FORMAT DE SORTIE (imperatif) :\n" .
"- Reponds UNIQUEMENT par un objet JSON de notebook Jupyter : {\"cells\": [ ... ]}.\n" .
"- Question SANS code = cellule {\"cell_type\":\"markdown\",\"source\":\"...enonce...\"}.\n" .
"- Question AVEC code = cellule markdown (l'enonce) SUIVIE d'une cellule\n" .
"  {\"cell_type\":\"code\",\"source\":\"# a completer\\n...\"}.\n" .
"- N'ajoute aucune cle hors 'cells'. Pas de texte ni de balises hors du JSON.";
}

$user = "Genere le notebook maintenant.";
if ($exemples) {
    $user .= "\n\nVoici des exemples de notebooks existants (modeles de style et de niveau, a NE PAS recopier) :\n";
    foreach ($exemples as $i => $ex) {
        $user .= "\n===== EXEMPLE " . ($i + 1) . " (" . $ex["difficulte"] . ") : " . $ex["descriptif"] . " =====\n";
        $user .= $ex["contenu"] . "\n";
    }
} else {
    $user .= "\n\n(Aucun exemple disponible dans la base pour ces criteres : appuie-toi sur les themes et le niveau.)";
}

/* ------------------- DELEGATION DE L'APPEL A ia.php ------------------------ */

$payload = json_encode([
    "provider" => $provider,
    "apiKey"   => $apiKey,
    "action"   => "raw_chat",
    "system"   => $system,
    "user"     => $user,
], JSON_UNESCAPED_UNICODE);

$ch = curl_init(IA_ENDPOINT);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, ["Content-Type: application/json"]);
curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_TIMEOUT, 110);
$resp = curl_exec($ch);
$err  = curl_error($ch);
curl_close($ch);

if ($resp === false) {
    echo json_encode(["ok" => false, "error" => "Appel ia.php impossible : " . $err]); exit;
}

$j = json_decode($resp, true);
if (!is_array($j)) {
    echo json_encode(["ok" => false, "error" => "Reponse ia.php illisible"]); exit;
}
if (isset($j["error"])) {
    echo json_encode(["ok" => false, "error" => $j["error"]]); exit;
}
$texteLLM = (string)($j["result"] ?? "");
if ($texteLLM === "") {
    echo json_encode(["ok" => false, "error" => "Reponse vide du moteur"]); exit;
}

/* -------------------- EXTRACTION DU NOTEBOOK JSON -------------------------- */

function extraireNotebook(string $texte): ?array {
    $s = trim($texte);
    // retire d'eventuelles balises de code
    $s = preg_replace('/^```(?:json)?/i', "", $s);
    $s = preg_replace('/```$/', "", trim($s));
    // isole du premier { au dernier }
    $a = strpos($s, "{");
    $b = strrpos($s, "}");
    if ($a === false || $b === false || $b < $a) return null;
    $s = substr($s, $a, $b - $a + 1);

    $obj = json_decode($s, true);
    if (!is_array($obj) || !isset($obj["cells"]) || !is_array($obj["cells"])) return null;

    // Normalisation minimale des cellules (cell_type + source string).
    $cells = [];
    foreach ($obj["cells"] as $c) {
        if (!is_array($c)) continue;
        $type = ($c["cell_type"] ?? "") === "code" ? "code" : "markdown";
        $src  = $c["source"] ?? "";
        if (is_array($src)) { $src = implode("", $src); }
        $cells[] = ["cell_type" => $type, "source" => (string)$src, "metadata" => new stdClass()];
    }
    if (!$cells) return null;

    return [
        "cells" => $cells,
        "metadata" => new stdClass(),
        "nbformat" => 4,
        "nbformat_minor" => 5,
    ];
}

$notebook = extraireNotebook($texteLLM);
if ($notebook === null) {
    echo json_encode(["ok" => false, "error" => "Le moteur n'a pas renvoye un notebook valide."]); exit;
}

$reponse = ["ok" => true, "notebook" => $notebook];
if ($themesAbsents) {
    $reponse["themes_absents"] = $themesAbsents;
    $reponse["niveau_libelle"] = $libelleNiveau;
}
echo json_encode($reponse, JSON_UNESCAPED_UNICODE);