<?php
/* =============================================================================
   rag_classement.php  —  Classement thematique des notebooks (DeepSeek)
   -----------------------------------------------------------------------------
   Script autonome : la table `exercices` n'est jamais modifiee.
   Lit les lignes de rag_exercices dont `themes` IS NULL, demande au
   LLM de remplir le JSON des themes, et l'enregistre.

   - Ne traite QUE les lignes themes IS NULL -> ne reecrase jamais un classement
     deja relu/corrige a la main.
   - Sortie LLM forcee en JSON (response_format) + parsing defensif.
   - On normalise toujours sur la liste figee de themes : exactement les memes
     cles, dans le meme ordre, sur toutes les lignes.

   USAGE (navigateur) :
     .../rag_classement.php?token=TON_TOKEN           -> traite tous les NULL
     .../rag_classement.php?token=TON_TOKEN&max=3     -> n'en traite que 3 (essai)
   ============================================================================= */

@set_time_limit(0);

/* ------------- Identifiants : lus dans le fichier .env --------------------- */
require_once __DIR__ . "/secrets.php";
define("RAG_TOKEN",    (string)secret("RAG_TOKEN",    ""));
define("DEEPSEEK_KEY", (string)secret("DEEPSEEK_KEY", ""));
/* -------------------------------------------------------------------------- */

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

require_once __DIR__ . "/db.php";   // $pdo

// Affichage progressif (on voit avancer dans Firefox).
@ob_end_flush();
ob_implicit_flush(true);
function ligne(string $s): void { echo $s . "\n"; @flush(); }

/* --------------------- LISTE FIGEE DES THEMES (30) ------------------------
   Cle technique => glose courte (aide le modele a juger le SENS, pas le mot). */
$THEMES = [
    "listes"               => "manipulation de listes Python",
    "tuples"               => "tuples",
    "dictionnaires"        => "dictionnaires (cle/valeur)",
    "ensembles"            => "ensembles (set)",
    "chaines"              => "chaines de caracteres",
    "conditions"           => "tests conditionnels (if/else)",
    "boucles"              => "boucles for/while",
    "fonctions"            => "definition et usage de fonctions",
    "poo"                  => "programmation orientee objet (classes)",
    "recursivite"          => "recursivite",
    "exceptions"           => "gestion d'erreurs / exceptions (try/except)",
    "fichiers"             => "lecture/ecriture de fichiers",
    "operateurs_logiques"  => "operateurs logiques (and/or/not)",
    "recherche"            => "algorithmes de recherche",
    "parcours"            => "parcours de structures (listes, arbres, graphes)",
    "tris"                 => "algorithmes de tri",
    "complexite"           => "analyse de complexite algorithmique",
    "diviser_pour_regner"  => "strategie diviser pour regner",
    "prog_dynamique"       => "programmation dynamique",
    "gloutons"             => "algorithmes gloutons",
    "dichotomie"           => "recherche dichotomique",
    "abr"                  => "arbres binaires de recherche",
    "piles_files"          => "piles et files",
    "arbres"               => "arbres (structure de donnees)",
    "graphes"              => "graphes (structure de donnees)",
    "tables_hachage"       => "tables de hachage",
    "reseaux"              => "notions de reseaux",
    "representation_donnees" => "representation des donnees (binaire, encodage)",
    "booleen_logique"      => "calcul booleen / logique",
    "type_bac"             => "ressemble a un sujet d'examen type baccalaureat NSI",
];
$CLES = array_keys($THEMES);

/* ------------------------------ PROMPT ------------------------------------ */

function construirePromptSysteme(array $themes): string {
    $liste = "";
    foreach ($themes as $cle => $glose) {
        $liste .= "- " . $cle . " : " . $glose . "\n";
    }
    $cles = implode(", ", array_keys($themes));

    return
"Tu es un classificateur de notebooks d'exercices de NSI / Python (lycee).\n" .
"On te donne le titre et le contenu d'un notebook (consignes en markdown + code Python).\n" .
"Pour CHACUN des themes ci-dessous, reponds true si le notebook PORTE REELLEMENT sur ce theme\n" .
"(le concept est central ou explicitement travaille), false sinon.\n" .
"Juge le SENS de l'exercice, pas la simple presence d'un mot : par exemple 'liste = []' qui traine\n" .
"ne suffit pas a cocher 'listes' si l'exercice ne porte pas dessus.\n\n" .
"Themes :\n" . $liste . "\n" .
"Pour 'type_bac', appuie-toi aussi sur le titre : un titre mentionnant BAC est un indice fort.\n\n" .
"REPONDS UNIQUEMENT par un objet JSON avec EXACTEMENT ces cles : " . $cles . ".\n" .
"Chaque valeur est true ou false. Aucune autre cle, aucun texte, aucun commentaire, pas de balises de code.";
}

/* ------------------------------ APPEL API --------------------------------- */

function appelDeepSeek(string $system, string $user): array {
    $payload = [
        "model" => "deepseek-chat",
        "messages" => [
            ["role" => "system", "content" => $system],
            ["role" => "user",   "content" => $user],
        ],
        "temperature" => 0.0,
        "response_format" => ["type" => "json_object"],
    ];

    $ch = curl_init("https://api.deepseek.com/chat/completions");
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        "Content-Type: application/json",
        "Authorization: Bearer " . DEEPSEEK_KEY,
    ]);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload, JSON_UNESCAPED_UNICODE));
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 60);
    $resp = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err  = curl_error($ch);
    curl_close($ch);

    if ($resp === false) {
        return [0, "", "curl: " . $err];
    }
    $j = json_decode($resp, true);
    if ($code === 200 && isset($j["choices"][0]["message"]["content"])) {
        return [200, (string)$j["choices"][0]["message"]["content"], ""];
    }
    $msg = $j["error"]["message"] ?? ("HTTP " . $code);
    return [$code, "", $msg];
}

/* --------------------- PARSING DEFENSIF DU JLE JSON ----------------------- */

function extraireThemes(string $contenuLLM, array $cles): ?array {
    $s = trim($contenuLLM);
    // retire d'eventuelles balises de code
    $s = preg_replace('/^```(?:json)?/i', "", $s);
    $s = preg_replace('/```$/', "", trim($s));
    // isole du premier { au dernier }
    $a = strpos($s, "{");
    $b = strrpos($s, "}");
    if ($a === false || $b === false || $b < $a) {
        return null;
    }
    $s = substr($s, $a, $b - $a + 1);

    $obj = json_decode($s, true);
    if (!is_array($obj)) {
        return null;
    }

    // Normalisation : exactement les cles attendues, dans l'ordre fige.
    $out = [];
    foreach ($cles as $cle) {
        $out[$cle] = (isset($obj[$cle]) && $obj[$cle] === true);
    }
    return $out;
}

/* ================================ EXECUTION ================================ */

if (DEEPSEEK_KEY === "") {
    http_response_code(400);
    ligne("Cle DeepSeek introuvable : renseigne DEEPSEEK_KEY dans le fichier .env.");
    exit;
}

$max = isset($_GET["max"]) ? max(0, (int)$_GET["max"]) : 0; // 0 = tous

ligne("=== Classement thematique (DeepSeek) ===");

try {
    $sql = "SELECT id, descriptif, contenu
            FROM rag_exercices
            WHERE source = 'python' AND themes IS NULL
            ORDER BY id ASC";
    if ($max > 0) {
        $sql .= " LIMIT " . $max;
    }
    $rows = $pdo->query($sql)->fetchAll();

    ligne("A traiter (themes NULL) : " . count($rows));
    ligne("");

    $system = construirePromptSysteme($THEMES);
    $upd = $pdo->prepare("UPDATE rag_exercices SET themes = :themes WHERE id = :id");

    $okCount = 0;
    $koCount = 0;

    foreach ($rows as $r) {
        $titre = (string)$r["descriptif"];
        $user  = "TITRE : " . $titre . "\n\nCONTENU :\n" . (string)$r["contenu"];

        [$code, $contenuLLM, $erreur] = appelDeepSeek($system, $user);

        // Une relance douce en cas de limite de debit.
        if ($code === 429) {
            sleep(3);
            [$code, $contenuLLM, $erreur] = appelDeepSeek($system, $user);
        }

        if ($code !== 200) {
            $koCount++;
            ligne("ECHEC  #" . $r["id"] . "  " . $titre . "  (" . $erreur . ")");
            continue;
        }

        $themes = extraireThemes($contenuLLM, $CLES);
        if ($themes === null) {
            $koCount++;
            ligne("ECHEC  #" . $r["id"] . "  " . $titre . "  (JSON illisible)");
            continue;
        }

        $upd->execute([
            ":themes" => json_encode($themes, JSON_UNESCAPED_UNICODE),
            ":id"     => (int)$r["id"],
        ]);

        // petit resume des themes coches
        $coches = array_keys(array_filter($themes));
        $okCount++;
        ligne("OK     #" . $r["id"] . "  " . $titre . "  -> " .
              ($coches ? implode(", ", $coches) : "(aucun)"));

        usleep(200000); // 0.2s entre deux appels, par courtoisie
    }

    ligne("");
    ligne("Classes OK : " . $okCount);
    ligne("Echecs     : " . $koCount);
    if ($koCount > 0) {
        ligne("Relance le script : il ne reprendra que les lignes restees NULL.");
    }
    ligne("Termine.");

} catch (Throwable $ex) {
    http_response_code(500);
    ligne("");
    ligne("ERREUR : " . $ex->getMessage());
}