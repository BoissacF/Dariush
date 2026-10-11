<?php
/* =============================================================================
   rag_extraction.php  —  Remplissage de la table rag_exercices
   -----------------------------------------------------------------------------
   Script autonome : la table `exercices` n'est jamais modifiée.
   À lancer manuellement (depuis le navigateur ou en CLI)
   quand on veut (re)construire le corpus RAG.

   Ce qu'il fait :
   - lit les exercices de source 'python' dans la table `exercices`
   - apparie chaque énoncé avec son corrigé (descriptif identique + suffixe
     "****correction****")
   - ne garde que le corrigé quand il existe (a_correction=1), sinon l'énoncé
     seul (a_correction=0)
   - décode le lien (base64 URL-safe -> zlib gzuncompress), page par page
   - ignore totalement les images, et EXCLUT tout bloc markdown contenant une
     balise attachment
   - calcule niveau_rang (1..7), difficulte (facile/difficile), hash du contenu
   - reconstruit entièrement les lignes 'python' de rag_exercices
   - CONSERVE les thèmes et vecteurs déjà calculés pour un contenu inchangé
     (report par hash) : le classement thématique n'est jamais perdu
     tant que le notebook source n'a pas changé.
   ============================================================================= */

/* ----------------------------- PROTECTION ----------------------------------
   Empêche un déclenchement public. CHANGE cette valeur, et appelle l'URL avec
   ?token=TА_VALEUR. (En CLI le token n'est pas exigé.)                        */
require_once __DIR__ . "/secrets.php";
define("RAG_TOKEN", (string)secret("RAG_TOKEN", ""));

$enCli = (php_sapi_name() === "cli");
if (!$enCli) {
    header("Content-Type: text/plain; charset=utf-8");
    $token = isset($_GET["token"]) ? (string)$_GET["token"] : "";
    if (RAG_TOKEN === "" || !hash_equals(RAG_TOKEN, $token)) {
        http_response_code(403);
        echo "Acces refuse : token invalide.\n";
        exit;
    }
}

require_once __DIR__ . "/db.php";   // expose $pdo (PDO, ERRMODE_EXCEPTION, FETCH_ASSOC)

/* ----------------------- CONSTANTES & BARÈMES ------------------------------ */

// Séparateur interne des markdowns multiples (identique à outils.js).
// \u0000 cote JS == octet nul \0 cote PHP.
const MD_SEP = "\n\0===DARIUSH-MD-SEP===\0\n";

// Suffixe qui distingue un corrigé d'un énoncé.
const SUFFIXE_CORRECTION = "****correction****";

// Barème niveau brut -> rang ordonné + difficulté dérivée.
$NIVEAUX = [
    "debutant"   => ["rang" => 1, "diff" => "facile"],
    "premiere"   => ["rang" => 2, "diff" => "facile"],
    "premiere2"  => ["rang" => 3, "diff" => "difficile"],
    "terminale"  => ["rang" => 4, "diff" => "facile"],
    "terminale2" => ["rang" => 5, "diff" => "difficile"],
    "BAC"        => ["rang" => 5, "diff" => "difficile"],
    "superieur"  => ["rang" => 6, "diff" => "facile"],
    "expert"     => ["rang" => 7, "diff" => "difficile"],
];

/* --------------------------- OUTILS DE DÉCODAGE ---------------------------- */

// base64 URL-safe + zlib  ->  texte UTF-8  (inverse exact de outils.js).
// pako.deflate produit du zlib (en-tete 0x78) -> gzuncompress (PAS gzinflate).
function decode_text_deflate_b64url(string $b64url): ?string {
    $s = strtr($b64url, "-_", "+/");
    $reste = strlen($s) % 4;
    if ($reste) {
        $s .= str_repeat("=", 4 - $reste);
    }
    $raw = base64_decode($s, true);
    if ($raw === false) {
        return null;
    }
    $out = @gzuncompress($raw);
    return ($out === false) ? null : $out;
}

// Parse une query string en préservant les valeurs telles quelles.
// On n'utilise pas parse_str (qui mangerait les '+' en espaces). Le b64url
// n'ayant ni '%' ni '+', rawurldecode est un no-op sûr.
function parse_query_preserve(string $query): array {
    $params = [];
    foreach (explode("&", $query) as $pair) {
        if ($pair === "") {
            continue;
        }
        $eq = strpos($pair, "=");
        if ($eq === false) {
            $params[rawurldecode($pair)] = "";
            continue;
        }
        $cle = rawurldecode(substr($pair, 0, $eq));
        $val = rawurldecode(substr($pair, $eq + 1));
        $params[$cle] = $val;
    }
    return $params;
}

// Regex de détection d'une image attachment dans un bloc markdown.
// (équivalent de celle de gestionimages.js)
const RE_ATTACHMENT = '/!\[[^\]]*\]\(\s*attachment:[^)]+?\s*\)/';

// Décode un lien complet en texte exploitable, page par page.
// - ignore les images (param img / imgN)
// - exclut tout bloc markdown contenant une balise attachment
// Renvoie "" si rien d'exploitable.
function construire_contenu(string $lien): string {
    $query = parse_url($lien, PHP_URL_QUERY);
    if ($query === null || $query === false) {
        $pos = strpos($lien, "?");
        $query = ($pos !== false) ? substr($lien, $pos + 1) : $lien;
    }
    $params = parse_query_preserve($query);

    $pages = [];
    $index = 1;
    while (true) {
        $codeKey    = ($index === 1) ? "code" : "code{$index}";
        $commentKey = ($index === 1) ? "c"    : "c{$index}";

        if (!array_key_exists($codeKey, $params)) {
            break;
        }

        // Page 1 : le param code peut traîner un suffixe "~date" -> on coupe.
        $codePart = $params[$codeKey];
        if ($index === 1) {
            $tilde = strpos($codePart, "~");
            if ($tilde !== false) {
                $codePart = substr($codePart, 0, $tilde);
            }
        }

        $codeText = decode_text_deflate_b64url($codePart);
        if ($codeText === null) {
            $codeText = "";
        }

        // Markdowns de la page (potentiellement plusieurs, joints par MD_SEP).
        $blocs = [];
        if (array_key_exists($commentKey, $params)) {
            $commentText = decode_text_deflate_b64url($params[$commentKey]);
            if ($commentText !== null) {
                foreach (explode(MD_SEP, $commentText) as $bloc) {
                    // On saute tout bloc qui référence une image attachment.
                    if (preg_match(RE_ATTACHMENT, $bloc)) {
                        continue;
                    }
                    $bloc = trim($bloc);
                    if ($bloc !== "") {
                        $blocs[] = $bloc;
                    }
                }
            }
        }

        $pages[] = ["code" => $codeText, "markdowns" => $blocs];
        $index++;
    }

    if (!$pages) {
        return "";
    }

    // Sérialisation lisible : structure des pages préservée.
    $morceaux = [];
    foreach ($pages as $i => $p) {
        $bloc = "--- Page " . ($i + 1) . " ---";
        foreach ($p["markdowns"] as $md) {
            $bloc .= "\n" . $md;
        }
        $code = trim($p["code"]);
        if ($code !== "") {
            $bloc .= "\n\n```python\n" . $code . "\n```";
        }
        $morceaux[] = $bloc;
    }
    return implode("\n\n", $morceaux);
}

/* ----------------------- APPARIEMENT ÉNONCÉ / CORRIGÉ ---------------------- */

function est_correction(string $descriptif): bool {
    $d = trim($descriptif);
    $suf = SUFFIXE_CORRECTION;
    return (mb_substr($d, -mb_strlen($suf)) === $suf);
}

function base_descriptif(string $descriptif): string {
    $d = trim($descriptif);
    $suf = SUFFIXE_CORRECTION;
    if (mb_substr($d, -mb_strlen($suf)) === $suf) {
        $d = rtrim(mb_substr($d, 0, mb_strlen($d) - mb_strlen($suf)));
    }
    return $d;
}

/* ================================ EXÉCUTION ================================= */

$rapport = [];
$rapport[] = "=== Extraction RAG (source python) ===";

try {
    // 1) Charger l'existant pour conserver themes/vecteur par hash de contenu.
    $ancienParHash = [];
    $stmtOld = $pdo->query(
        "SELECT hash_contenu, themes, vecteur, modele_embedding
         FROM rag_exercices WHERE source = 'python'"
    );
    foreach ($stmtOld as $row) {
        $ancienParHash[$row["hash_contenu"]] = $row;
    }
    $rapport[] = "Lignes RAG existantes : " . count($ancienParHash);

    // 2) Lire les exercices python.
    $stmt = $pdo->prepare(
        "SELECT id, niveau, descriptif, lien
         FROM exercices
         WHERE source = 'python'"
    );
    $stmt->execute();
    $exos = $stmt->fetchAll();
    $rapport[] = "Exercices python lus : " . count($exos);

    // 3) Regrouper par descriptif de base.
    $groupes = []; // base => ['enonce'=>row|null, 'corrige'=>row|null]
    foreach ($exos as $e) {
        $base = base_descriptif($e["descriptif"]);
        if (!isset($groupes[$base])) {
            $groupes[$base] = ["enonce" => null, "corrige" => null];
        }
        if (est_correction($e["descriptif"])) {
            $groupes[$base]["corrige"] = $e;
        } else {
            $groupes[$base]["enonce"] = $e;
        }
    }
    $rapport[] = "Exercices logiques (groupes) : " . count($groupes);

    // 4) Reconstruction complète des lignes python (dans une transaction).
    $pdo->beginTransaction();
    $pdo->exec("DELETE FROM rag_exercices WHERE source = 'python'");

    $ins = $pdo->prepare(
        "INSERT INTO rag_exercices
            (exercice_id, source, descriptif, contenu, a_correction,
             niveau_rang, niveau_origine, difficulte, themes,
             hash_contenu, vecteur, modele_embedding)
         VALUES
            (:exercice_id, 'python', :descriptif, :contenu, :a_correction,
             :niveau_rang, :niveau_origine, :difficulte, :themes,
             :hash_contenu, :vecteur, :modele_embedding)"
    );

    $nbInseres   = 0;
    $nbCorriges  = 0;
    $nbEnonces   = 0;
    $nbSautes    = 0;   // vides / indécodables
    $nbConserves = 0;   // themes/vecteur repris par hash
    $niveauxInconnus = [];

    foreach ($groupes as $base => $g) {
        $src   = $g["corrige"] ?: $g["enonce"];
        if (!$src) {
            continue;
        }
        $aCorr = $g["corrige"] ? 1 : 0;

        $contenu = construire_contenu((string)$src["lien"]);
        if ($contenu === "") {
            $nbSautes++;
            continue;
        }

        $niv = (string)$src["niveau"];
        if (isset($GLOBALS["NIVEAUX"][$niv])) {
            $rang = $GLOBALS["NIVEAUX"][$niv]["rang"];
            $diff = $GLOBALS["NIVEAUX"][$niv]["diff"];
        } else {
            // Niveau hors barème (ne devrait pas arriver) : on insère quand même
            // avec rang 0 et on le signale.
            $rang = 0;
            $diff = "facile";
            $niveauxInconnus[] = $base . " (niveau=" . $niv . ")";
        }

        $hash = hash("sha256", $contenu);

        // Conservation du travail déjà fait si le contenu n'a pas changé.
        $themes = null; $vecteur = null; $modele = null;
        if (isset($ancienParHash[$hash])) {
            $themes  = $ancienParHash[$hash]["themes"];
            $vecteur = $ancienParHash[$hash]["vecteur"];
            $modele  = $ancienParHash[$hash]["modele_embedding"];
            if ($themes !== null || $vecteur !== null) {
                $nbConserves++;
            }
        }

        $ins->execute([
            ":exercice_id"     => (int)$src["id"],
            ":descriptif"      => $base,
            ":contenu"         => $contenu,
            ":a_correction"    => $aCorr,
            ":niveau_rang"     => $rang,
            ":niveau_origine"  => $niv,
            ":difficulte"      => $diff,
            ":themes"          => $themes,
            ":hash_contenu"    => $hash,
            ":vecteur"         => $vecteur,
            ":modele_embedding"=> $modele,
        ]);

        $nbInseres++;
        if ($aCorr) { $nbCorriges++; } else { $nbEnonces++; }
    }

    $pdo->commit();

    $rapport[] = "";
    $rapport[] = "Lignes inserees      : " . $nbInseres;
    $rapport[] = "  dont corriges      : " . $nbCorriges;
    $rapport[] = "  dont enonces seuls : " . $nbEnonces;
    $rapport[] = "Sautes (vides/illisibles) : " . $nbSautes;
    $rapport[] = "Themes/vecteurs conserves : " . $nbConserves;

    if ($niveauxInconnus) {
        $rapport[] = "";
        $rapport[] = "ATTENTION - niveaux hors bareme (inseres en rang 0) :";
        foreach ($niveauxInconnus as $x) {
            $rapport[] = "  - " . $x;
        }
    }

    $rapport[] = "";
    $rapport[] = "Termine.";

} catch (Throwable $ex) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    http_response_code(500);
    $rapport[] = "";
    $rapport[] = "ERREUR : " . $ex->getMessage();
}

echo implode("\n", $rapport) . "\n";