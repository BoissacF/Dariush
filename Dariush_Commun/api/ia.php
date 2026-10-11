<?php

header("Content-Type: application/json; charset=utf-8");
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Authorization");

ini_set("display_errors", 0);

if ($_SERVER["REQUEST_METHOD"] === "OPTIONS") {
    http_response_code(204);
    exit;
}

if ($_SERVER["REQUEST_METHOD"] !== "POST") {
    echo json_encode(["error" => "Méthode non autorisée"]);
    exit;
}

$data = json_decode(file_get_contents("php://input"), true);

$provider     = $data["provider"] ?? "";
$apiKey       = $data["apiKey"] ?? "";
$action       = $data["action"] ?? "";
$code         = $data["code"] ?? "";
$question     = $data["question"] ?? "";
$errorMessage = $data["errorMessage"] ?? "";

/* Source de l'app cliente (python, linux, ...). Défaut python pour rétro-compatibilité. */
$sourcesValides = ['python', 'linux', 'sql', 'js', 'autre'];
$source = isset($data["source"]) ? trim($data["source"]) : 'python';
if (!in_array($source, $sourcesValides, true)) {
    $source = 'python';
}

/* ==================================================
   Clés et codes raccourcis : lus dans le fichier .env
   (voir Dariush_Commun/secrets.php)
   ================================================== */
require_once __DIR__ . "/../secrets.php";

/* Code raccourci élève -> remplacé par la vraie clé DeepSeek */
$teacherShortcutCode = secret("TEACHER_SHORTCUT_CODE");
$teacherRealApiKey   = secret("DEEPSEEK_KEY");

if ($teacherShortcutCode !== null && $apiKey === $teacherShortcutCode) {
    $apiKey = $teacherRealApiKey;
}


/* Code raccourci Groq */
$groqShortcutCode = secret("GROQ_SHORTCUT_CODE");
$groqRealApiKey   = secret("GROQ_KEY");

if ($groqShortcutCode !== null && $apiKey === $groqShortcutCode) {
    $apiKey = $groqRealApiKey;
}


/* Clé gratuite pour le bouton "Assistance cours" */
$groqFreeKey   = secret("GROQ_KEY");


/* ==================================================
   Modèle Groq centralisé (migration llama-3.3-70b-versatile
   -> openai/gpt-oss-120b, déprécié le 16/08/2026).
   Un seul endroit à modifier lors des prochains changements.
   ================================================== */
$groqModel = "openai/gpt-oss-120b";


/* ==================================================
   Helper : URL Gemini selon le provider
   gemini       = AI Studio gratuit 
   gemini-cloud = Google Cloud payant 
   ================================================== */
function geminiUrl($provider, $apiKey) {
    return "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" . $apiKey;
}

function askAPI($url, $headers, $payload) {
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_HTTPHEADER,     $headers);
    curl_setopt($ch, CURLOPT_POST,           true);
    curl_setopt($ch, CURLOPT_POSTFIELDS,     json_encode($payload));
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return [$httpCode, $response];
}



/* ==================================================
   Découpe le contexte pour l'agent Aide :
   - garde tout du DÉBUT de la page jusqu'au [AIDE:marqueur] ;
   - indique si le code de la page suit DIRECTEMENT le marqueur.
   Renvoie [texteQuestion, codeSuitDirectement(bool)].
   ================================================== */
function decouperQuestionAgent($markdownPage, $marqueur, $source = "python") {
    $tag = "[AIDE:" . $marqueur . "]";

    $nettoie = function ($s) {
        $s = str_replace(["\x00", "===DARIUSH-MD-SEP==="], "", $s);
        $s = preg_replace('/\[(AIDE|REP|FINREP):[A-Za-z0-9_\-]+\]/', '', $s);
        return trim($s);
    };

    $pos = strpos($markdownPage, $tag);
    if ($pos === false) {
        /* repli : marqueur introuvable -> toute la page, code inclus par défaut */
        return [$nettoie($markdownPage), true];
    }

    $avant = substr($markdownPage, 0, $pos);                 // début de page -> marqueur
    $apres = substr($markdownPage, $pos + strlen($tag));     // après le marqueur

    /* code pertinent seulement si RIEN de significatif ne suit le marqueur */
    $codeSuit = ($nettoie($apres) === "");


    if ($source === "linux") $codeSuit = false; // Linux : on ignore totalement le terminal
    return [$nettoie($avant), $codeSuit];
    
}



/* ==================================================
   Helper générique : un appel chat (system + user)
   Retourne [bool ok, string contenu, string erreur]
   ================================================== */
function chatLLM($provider, $apiKey, $system, $user, $temperature = 0.3, $maxTokens = 1024) {

    if ($provider === "openai" || $provider === "deepseek") {
        $url   = $provider === "openai"
            ? "https://api.openai.com/v1/chat/completions"
            : "https://api.deepseek.com/chat/completions";
        $model = $provider === "openai" ? "gpt-4o-mini" : "deepseek-chat";
        $payload = [
            "model" => $model,
            "messages" => [
                ["role" => "system", "content" => $system],
                ["role" => "user",   "content" => $user]
            ],
            "temperature" => $temperature
        ];
        [$h, $r] = askAPI($url, ["Content-Type: application/json", "Authorization: Bearer " . $apiKey], $payload);
        $j = json_decode($r, true);
        if ($h === 429) return [false, "", "limite_atteinte"];
        if ($h === 200 && $j) return [true, $j["choices"][0]["message"]["content"] ?? "", ""];
        return [false, "", $j["error"]["message"] ?? "Erreur API"];
    }

    if ($provider === "anthropic") {
        $url = "https://api.anthropic.com/v1/messages";
        $payload = [
            "model"      => "claude-3-5-sonnet-20241022",
            "max_tokens" => $maxTokens,
            "system"     => $system,
            "messages"   => [["role" => "user", "content" => $user]]
        ];
        [$h, $r] = askAPI($url, ["Content-Type: application/json", "x-api-key: " . $apiKey, "anthropic-version: 2023-06-01"], $payload);
        $j = json_decode($r, true);
        if ($h === 429) return [false, "", "limite_atteinte"];
        if ($h === 200 && $j) return [true, $j["content"][0]["text"] ?? "", ""];
        return [false, "", $j["error"]["message"] ?? "Erreur API"];
    }

    if ($provider === "mistral") {
        $url = "https://api.mistral.ai/v1/chat/completions";
        $payload = [
            "model" => "mistral-small-latest",
            "messages" => [
                ["role" => "system", "content" => $system],
                ["role" => "user",   "content" => $user]
            ],
            "temperature" => $temperature
        ];
        [$h, $r] = askAPI($url, ["Content-Type: application/json", "Authorization: Bearer " . $apiKey], $payload);
        $j = json_decode($r, true);
        if ($h === 429) return [false, "", "limite_atteinte"];
        if ($h === 200 && $j) return [true, $j["choices"][0]["message"]["content"] ?? "", ""];
        return [false, "", $j["error"]["message"] ?? "Erreur API"];
    }

    if ($provider === "gemini" || $provider === "gemini-cloud") {
        $url = geminiUrl($provider, $apiKey);
        $payload = [
            "system_instruction" => ["parts" => [["text" => $system]]],
            "contents"           => [["role" => "user", "parts" => [["text" => $user]]]],
            "generationConfig"   => ["temperature" => $temperature]
        ];
        [$h, $r] = askAPI($url, ["Content-Type: application/json"], $payload);
        $j = json_decode($r, true);
        if ($h === 429) return [false, "", "limite_atteinte"];
        if ($h === 200 && $j) return [true, $j["candidates"][0]["content"]["parts"][0]["text"] ?? "", ""];
        return [false, "", $j["error"]["message"] ?? "Erreur API"];
    }

    /* défaut : Groq (clé gratuite ou clé perso passée par l'appelant) */
    global $groqModel;
    $url = "https://api.groq.com/openai/v1/chat/completions";
    $payload = [
        "model" => $groqModel,
        "messages" => [
            ["role" => "system", "content" => $system],
            ["role" => "user",   "content" => $user]
        ],
        "temperature" => $temperature,
        "reasoning_effort" => "low"
    ];
    [$h, $r] = askAPI($url, ["Content-Type: application/json", "Authorization: Bearer " . $apiKey], $payload);
    $j = json_decode($r, true);
    if ($h === 429) return [false, "", "limite_atteinte"];
    if ($h === 200 && $j) return [true, $j["choices"][0]["message"]["content"] ?? "", ""];
    return [false, "", $j["error"]["message"] ?? "Erreur Groq"];
}

/* ==================================================
   Décodage du format produit par buildLink côté JS :
   base64 URL-safe + pako.deflate (zlib) -> gzuncompress
   ================================================== */
function _b64urlDeflateDecode($s) {
    if (!is_string($s) || $s === "") return "";
    $s = strtr($s, '-_', '+/');
    $pad = strlen($s) % 4;
    if ($pad) $s .= str_repeat('=', 4 - $pad);
    $bin = base64_decode($s, true);
    if ($bin === false) return "";
    $txt = @gzuncompress($bin);
    return ($txt === false) ? "" : $txt;
}

/* ==================================================
   Cherche le corrigé d'un exercice et en extrait la
   réponse marquée [REP:marqueur] : le texte qui suit le
   marqueur ET le code CodeMirror de la page concernée.
   Renvoie "" si pas de corrigé ou marqueur introuvable.
   ================================================== */
   
function chargerReponseCorrige($pdo, $lienCourt, $source, $marqueur) {
    if ($marqueur === "" || $lienCourt === "") return "";

    /* 1) descriptif de l'exercice ouvert */
    $st = $pdo->prepare("SELECT descriptif FROM exercices WHERE lien_court = ? AND source = ? LIMIT 1");
    $st->execute([$lienCourt, $source]);
    $row = $st->fetch();
    if (!$row || !isset($row["descriptif"])) return "";

    $descCorrige = $row["descriptif"] . "****correction****";

    /* 2) lien du corrigé associé */
    $st = $pdo->prepare("SELECT lien FROM exercices WHERE descriptif = ? AND source = ? LIMIT 1");
    $st->execute([$descCorrige, $source]);
    $row = $st->fetch();
    if (!$row || empty($row["lien"])) return "";

    /* 3) décodage + recherche du marqueur */
    $query = parse_url($row["lien"], PHP_URL_QUERY);
    if (!$query) return "";
    parse_str($query, $params);

    $needle = "[REP:"    . $marqueur . "]";
    $finTag = "[FINREP:" . $marqueur . "]";

    for ($i = 0; $i < 100; $i++) {
        $codeKey = ($i === 0) ? "code" : "code" . ($i + 1);
        if (!isset($params[$codeKey])) break;

        $cKey = ($i === 0) ? "c" : "c" . ($i + 1);
        $md = isset($params[$cKey]) ? _b64urlDeflateDecode($params[$cKey]) : "";
        if ($md === "") continue;

        $pos = strpos($md, $needle);
        if ($pos === false) continue;

       $apres = substr($md, $pos + strlen($needle));

        /* On coupe à [FINREP:qx] (sinon repli sur le prochain marqueur), et on
           garde ce qui SUIT le point de coupure pour savoir si le code suit. */
        $suite = "";
        $posFin = strpos($apres, $finTag);
        if ($posFin !== false) {
            $suite = substr($apres, $posFin + strlen($finTag));
            $apres = substr($apres, 0, $posFin);
        } elseif (preg_match('/\[(REP|AIDE|FINREP):[A-Za-z0-9_\-]+\]/', $apres, $m2, PREG_OFFSET_CAPTURE)) {
            $suite = substr($apres, $m2[0][1]);
            $apres = substr($apres, 0, $m2[0][1]);
        }

        $nettoie = function ($s) {
            return trim(str_replace(["\x00", "===DARIUSH-MD-SEP==="], "", $s));
        };

        $texte = $nettoie($apres);

        /* Le code de la page n'est inclus que s'il SUIT directement :
           rien de significatif entre [FINREP:qx] et le code. */
        $codeSuit = ($nettoie($suite) === "");
        $pageCode = trim(_b64urlDeflateDecode($params[$codeKey]));

        $parts = [];
        if ($texte !== "") {
            $parts[] = "Réponse attendue (texte) :\n" . $texte;
        }
        if ($codeSuit && $pageCode !== "") {
            $parts[] = "Réponse attendue (code) :\n" . $pageCode;
        }

        return implode("\n\n", $parts);
    }

    return "";
}  
   
function vieuxchargerReponseCorrige($pdo, $lienCourt, $source, $marqueur) {
    if ($marqueur === "" || $lienCourt === "") return "";

    /* 1) descriptif de l'exercice ouvert */
    $st = $pdo->prepare("SELECT descriptif FROM exercices WHERE lien_court = ? AND source = ? LIMIT 1");
    $st->execute([$lienCourt, $source]);
    $row = $st->fetch();
    if (!$row || !isset($row["descriptif"])) return "";

    $descCorrige = $row["descriptif"] . "****correction****";

    /* 2) lien complet du corrigé associé (même source) */
    $st = $pdo->prepare("SELECT lien FROM exercices WHERE descriptif = ? AND source = ? LIMIT 1");
    $st->execute([$descCorrige, $source]);
    $row = $st->fetch();
    if (!$row || empty($row["lien"])) return "";

    /* 3) décodage du lien : c/c2/... = markdown, code/code2/... = CodeMirror */
    $query = parse_url($row["lien"], PHP_URL_QUERY);
    if (!$query) return "";
    parse_str($query, $params);

    $needle = "[REP:" . $marqueur . "]";

    /* "code" est toujours présent pour chaque page : on s'en sert d'index de page */
    for ($i = 0; $i < 100; $i++) {
        $codeKey = ($i === 0) ? "code" : "code" . ($i + 1);
        if (!isset($params[$codeKey])) break; /* plus de page */

        $cKey = ($i === 0) ? "c" : "c" . ($i + 1);
        $md = isset($params[$cKey]) ? _b64urlDeflateDecode($params[$cKey]) : "";
        if ($md === "") continue;

        $pos = strpos($md, $needle);
        if ($pos === false) continue;

        /* texte après le marqueur, coupé au prochain [REP:..]/[AIDE:..] */
        $apres = substr($md, $pos + strlen($needle));
        if (preg_match('/\[(REP|AIDE):[A-Za-z0-9_\-]+\]/', $apres, $m2, PREG_OFFSET_CAPTURE)) {
            $apres = substr($apres, 0, $m2[0][1]);
        }
        $texte = trim($apres);

        $pageCode = _b64urlDeflateDecode($params[$codeKey]);
        $pageCode = trim($pageCode);

        $parts = [];
        if ($texte !== "")    $parts[] = "Réponse attendue (texte) :\n" . $texte;
        if ($pageCode !== "") $parts[] = "Réponse attendue (code) :\n" . $pageCode;

        return implode("\n\n", $parts);
    }

    return "";
}
/* ==================================================
   Action "agent_aide" — tuteur (incrément 1, sans corrigé)
   Règle absolue : ne jamais révéler la réponse.
   Boucle : génération -> vérification -> 1 régénération.
   Placée AVANT le bloc "cours" et AVANT le contrôle
   "Paramètres manquants" : en mode gratuit, ni provider
   ni apiKey ne sont envoyés.
   ================================================== */

if ($action === "agent_aide") {

    $markdownPage  = $data["markdown_page"] ?? "";
    $codeEleve     = $data["code_eleve"] ?? "";
    $marqueur      = trim($data["marqueur"] ?? "");
    $elargi        = !empty($data["elargi"]);
    $pagesPrec     = $data["pages_precedentes"] ?? "";

    /* Lecture éventuelle du corrigé (jamais affichée) */
    $exoLienCourt  = trim($data["exercice_lien_court"] ?? "");
    $reponseConnue = "";
    if ($exoLienCourt !== "") {
        $cheminDb = file_exists(__DIR__ . "/../db.php") ? __DIR__ . "/../db.php" : __DIR__ . "/db.php";
        require_once $cheminDb;
        if (isset($pdo)) {
            $reponseConnue = chargerReponseCorrige($pdo, $exoLienCourt, $source, $marqueur);
        }
    }

    /* Découpe du contexte : début de page -> [AIDE:marqueur] ; code si suit directement */
   
	list($question, $codeSuit) = decouperQuestionAgent($markdownPage, $marqueur, $source);

    /* Contexte effectif (pages précédentes seulement en mode élargi) */
    $contexte = "";
    if ($elargi && trim($pagesPrec) !== "") {
        $contexte .= "CONTEXTE DES PAGES PRÉCÉDENTES (pour comprendre la question) :\n"
                   . $pagesPrec . "\n\n";
    }
    $contexte .= "DOCUMENT DE LA PAGE (la question concernée est la DERNIÈRE ci-dessous) :\n" . $question;

    /* Moteur : clé perso si fournie, sinon Groq gratuit */
    $useProvider = $provider;
    $useKey      = $apiKey;
    if (!$useProvider || !$useKey) {
        $useProvider = "groq";
        $useKey      = $groqFreeKey;
    }

    $matiere = ($source === 'sql')   ? "SQL / bases de données"
             : (($source === 'linux') ? "Linux / bash"
             : "Python");
			 
	/* Vocabulaire selon la matière (la logique, elle, est identique partout) */
    if ($source === 'sql') {
        $motProduction = "la requête SQL complète";
        $motCompleter  = "compléter une requête";
    } elseif ($source === 'linux') {
        $motProduction = "la commande complète attendue";
        $motCompleter  = "donner la commande";
    } else {
        $motProduction = "le code complet de la solution";
        $motCompleter  = "compléter le code";
    }		 
			 

    /* 1) Génération */
    $sysGenBase =
        "Tu es un tuteur de $matiere niveau lycée/BTS. "
      . "L'élève a cliqué sur « Aide » à propos de la question marquée [AIDE:$marqueur]. "
      . "La question concernée est la DERNIÈRE du document fourni. Identifie-la précisément.\n\n"
      . "INTERDICTIONS ABSOLUES (priment sur tout le reste) :\n"
      . "- Ne JAMAIS donner la réponse, ni totale ni partielle : pas de résultat final, pas de valeur, "
      . "pas de liste/ensemble solution, pas $motProduction.\n"
      . "- Ne JAMAIS appliquer la méthode aux données réelles de l'énoncé (valeurs, listes, exemples). "
      . "Si tu illustres, invente d'AUTRES données sans rapport.\n"
      . "- Ne JAMAIS énumérer, calculer, ni $motCompleter à la place de l'élève.\n\n"
      . ($reponseConnue !== ""
            ? "Tu disposes de la réponse attendue (CONFIDENTIELLE, plus bas). Elle te sert UNIQUEMENT à "
            . "savoir vers quoi orienter, jamais à la divulguer. Considère-la comme exacte : ne refais "
            . "aucun calcul toi-même.\n\n"
            : "")
      . "Ce que tu dois faire, et RIEN d'autre :\n"
      . "1) un rappel de cours court et ciblé sur la notion en jeu "
      . "(en $matiere, tu peux rappeler à quoi sert une commande/notion, par ex. son rôle général) ;\n"
      . "2) une seule piste de méthode, formulée de façon générale.\n"
      . "Sois bref. Réponds en français, en Markdown.";

    $sysGen = $sysGenBase;
    if (!$elargi) {
        $sysGen .= "\n\nDÉTECTION DE CONTEXTE MANQUANT (prioritaire) : si la question fait référence à "
                 . "un élément qui n'apparaît PAS explicitement dans le document fourni — par exemple "
                 . "« cette implémentation », « la méthode précédente », « la fonction ci-dessus », "
                 . "« le tableau défini plus haut », ou toute comparaison avec quelque chose d'absent — "
                 . "tu NE réponds PAS et tu écris UNIQUEMENT le mot CONTEXTE_INSUFFISANT, sans rien d'autre. "
                 . "Ne réponds avec des généralités sous AUCUN prétexte.";
    }

    $usrGen =
        $contexte
      . (($codeSuit && $codeEleve !== "") ? "\n\nCODE ACTUEL DE L'ÉLÈVE :\n" . $codeEleve : "")
      . ($reponseConnue !== "" ? "\n\n[CONFIDENTIEL — NE JAMAIS RÉVÉLER] Réponse attendue : " . $reponseConnue : "");

    [$ok, $aide, $err] = chatLLM($useProvider, $useKey, $sysGen, $usrGen, 0.3, 900);
    if (!$ok) {
        echo json_encode(["error" => ($err === "limite_atteinte" ? "limite_atteinte" : ($err ?: "Erreur génération"))]);
        exit;
    }

    /* Élargissement à la demande : signal au client, sans vérifier ni dépenser plus */
    if (!$elargi && stripos(trim($aide), "CONTEXTE_INSUFFISANT") === 0) {
        echo json_encode(["contexte_insuffisant" => true]);
        exit;
    }

    /* 2) Vérification */
    $sysVer =
        "Tu es un vérificateur strict. On te donne un document/question et une aide rédigée pour un élève"
      . ($reponseConnue !== "" ? ", ainsi que la réponse attendue (confidentielle)" : "")
      . ". Vérifie : (a) l'aide NE révèle PAS la solution ni le résultat final ; (b) l'aide est réellement "
      . "utile (rappel de cours + piste), pas un encouragement vide. "
      . "Réponds STRICTEMENT en JSON compact, sans aucun texte autour : {\"ok\":true|false,\"raison\":\"...\"}.";

    $usrVer =
        "DOCUMENT :\n" . $question
      . ($reponseConnue !== "" ? "\n\nRÉPONSE ATTENDUE (confidentielle) : " . $reponseConnue : "")
      . "\n\nAIDE À VÉRIFIER :\n" . $aide;

    [$okV, $verRaw] = chatLLM($useProvider, $useKey, $sysVer, $usrVer, 0.0, 200);
    $verdict = null;
    if ($okV && preg_match('/\{.*\}/s', $verRaw, $mm)) {
        $verdict = json_decode($mm[0], true);
    }

    /* 3) Régénération unique (sans l'échappatoire CONTEXTE_INSUFFISANT) */
    if (is_array($verdict) && array_key_exists("ok", $verdict) && $verdict["ok"] === false) {
        $raison = $verdict["raison"] ?? "à améliorer";
        $sysReg = $sysGenBase . "\n\nTa précédente aide a été refusée pour cette raison : " . $raison
                . ". Recommence en respectant les interdictions absolues.";
        [$okR, $aideR] = chatLLM($useProvider, $useKey, $sysReg, $usrGen, 0.3, 900);
        if ($okR && trim($aideR) !== "") $aide = $aideR;
    }

    $sortie = [
        "result"        => $aide,
        "debug_reponse" => $reponseConnue,
        "debug_lien"    => $exoLienCourt,
        "debug_contexte"=> $contexte,
        "debug_codeSuit"=> $codeSuit,
        "debug_elargi"  => $elargi,
        "debug_usrGen"  => $usrGen
    ];
    echo json_encode($sortie);
    exit;
}



/* ==================================================
   Action "cours" — basculement Groq → Gemini
   Pas besoin de clé API utilisateur
   Le prompt système dépend de la source (python / linux / ...)
   ================================================== */
if ($action === "cours") {

    if ($source === 'linux') {
        $systemPrompt = "Tu es un assistant pédagogique spécialisé en système Linux et ligne de commande bash.

TON RÔLE :
- Répondre uniquement à des questions de cours sur Linux, le shell bash, les commandes courantes (ls, cd, mkdir, rm, cp, mv, cat, grep, find, chmod, chown, nano, etc.), les permissions Unix, les processus, les redirections et les pipes
- Expliquer des concepts, des notions, des définitions liés à Linux
- Donner des exemples simples de commandes pour illustrer une notion
- Adapter tes explications à un niveau lycée/BTS, dans le contexte d'un cours de découverte de Linux

RÈGLES STRICTES :
- Tu ne lis pas, ne corriges pas, ne complètes pas les commandes que l'élève a écrites
- Tu ne fais pas les exercices à la place de l'élève
- Tu réponds uniquement à des questions de cours
- Si la question concerne Python, JavaScript, SQL, ou un autre sujet hors Linux, tu réponds exactement : Je ne suis pas prévu pour cela.
- Tu réponds toujours en français
- Tes réponses sont concises, claires, adaptées au niveau lycée/BTS";
    } elseif ($source === 'sql') {
        $systemPrompt = "Tu es un assistant pédagogique spécialisé en bases de données relationnelles et langage SQL.

TON RÔLE :
- Répondre uniquement à des questions de cours sur les bases de données relationnelles et le langage SQL
- Expliquer des concepts, des notions, des définitions liés au SQL : SELECT, INSERT, UPDATE, DELETE, JOIN, GROUP BY, HAVING, ORDER BY, sous-requêtes, clés primaires et étrangères, contraintes, index, transactions, normalisation, schéma relationnel, etc.
- Donner des exemples simples de requêtes SQL pour illustrer une notion
- Adapter tes explications à un niveau lycée/BTS, dans le contexte d'un cours de découverte des bases de données
- Utiliser une syntaxe SQL standard compatible avec la plupart des SGBD (sans privilégier un dialecte particulier)

RÈGLES STRICTES :
- Tu ne lis pas, ne corriges pas, ne complètes pas les requêtes que l'élève a écrites
- Tu ne fais pas les exercices à la place de l'élève
- Tu réponds uniquement à des questions de cours
- Si la question concerne Python, JavaScript, Linux, ou un autre sujet hors SQL et bases de données, tu réponds exactement : Je ne suis pas prévu pour cela.
- Tu réponds toujours en français
- Tes réponses sont concises, claires, adaptées au niveau lycée/BTS";
    } else {
        /* Défaut : Python */
        $systemPrompt = "Tu es un assistant pédagogique spécialisé en informatique et programmation Python.

TON RÔLE :
- Répondre uniquement à des questions de cours sur l'informatique et Python
- Expliquer des concepts, des notions, des définitions
- Donner des exemples simples pour illustrer une notion
- Adapter tes explications à un niveau lycée/BTS

RÈGLES STRICTES :
- Tu ne lis pas, ne corriges pas, ne complètes pas de code
- Tu ne fais pas les exercices à la place de l'élève
- Tu réponds uniquement à des questions de cours
- Si la question ne concerne pas l'informatique ou Python, tu réponds exactement : Je ne suis pas prévu pour cela.
- Tu réponds toujours en français
- Tes réponses sont concises, claires, adaptées au niveau lycée/BTS";
    }

    $userQuestion = trim($question);

    if (!$userQuestion) {
        echo json_encode(["error" => "Question vide"]);
        exit;
    }

    /* -- Si le prof a connecté sa propre clé, on l'utilise -- */
    if ($provider && $apiKey) {

        if ($provider === "groq") {
            $url     = "https://api.groq.com/openai/v1/chat/completions";
            $payload = [
                "model"    => $groqModel,
                "messages" => [
                    ["role" => "system", "content" => $systemPrompt],
                    ["role" => "user",   "content" => $userQuestion]
                ],
                "temperature" => 0.3,
                "reasoning_effort" => "low"
            ];
            [$codeHttp, $response] = askAPI(
                $url,
                ["Content-Type: application/json", "Authorization: Bearer " . $apiKey],
                $payload
            );
            $json = json_decode($response, true);
            if ($codeHttp === 200 && $json) {
                echo json_encode(["result" => $json["choices"][0]["message"]["content"] ?? ""]);
                exit;
            }
            echo json_encode(["error" => $json["error"]["message"] ?? "Erreur API"]);
            exit;
        }

        if ($provider === "gemini" || $provider === "gemini-cloud") {
            $url     = geminiUrl($provider, $apiKey);
            $payload = [
                "system_instruction" => ["parts" => [["text" => $systemPrompt]]],
                "contents"           => [["role" => "user", "parts" => [["text" => $userQuestion]]]],
                "generationConfig"   => ["temperature" => 0.3]
            ];
            [$codeHttp, $response] = askAPI(
                $url,
                ["Content-Type: application/json"],
                $payload
            );
            $json = json_decode($response, true);
            if ($codeHttp === 200 && $json) {
                echo json_encode(["result" => $json["candidates"][0]["content"]["parts"][0]["text"] ?? ""]);
                exit;
            }
            echo json_encode(["error" => $json["error"]["message"] ?? "Erreur API"]);
            exit;
        }

        if ($provider === "openai" || $provider === "deepseek") {
            $url   = $provider === "openai"
                ? "https://api.openai.com/v1/chat/completions"
                : "https://api.deepseek.com/chat/completions";
            $model = $provider === "openai" ? "gpt-4o-mini" : "deepseek-chat";
            $payload = [
                "model"    => $model,
                "messages" => [
                    ["role" => "system", "content" => $systemPrompt],
                    ["role" => "user",   "content" => $userQuestion]
                ],
                "temperature" => 0.3
            ];
            [$codeHttp, $response] = askAPI(
                $url,
                ["Content-Type: application/json", "Authorization: Bearer " . $apiKey],
                $payload
            );
            $json = json_decode($response, true);
            if ($codeHttp === 200 && $json) {
                echo json_encode(["result" => $json["choices"][0]["message"]["content"] ?? ""]);
                exit;
            }
            echo json_encode(["error" => $json["error"]["message"] ?? "Erreur API"]);
            exit;
        }

        if ($provider === "anthropic") {
            $url     = "https://api.anthropic.com/v1/messages";
            $payload = [
                "model"      => "claude-3-5-sonnet-20241022",
                "max_tokens" => 1024,
                "system"     => $systemPrompt,
                "messages"   => [["role" => "user", "content" => $userQuestion]]
            ];
            [$codeHttp, $response] = askAPI(
                $url,
                ["Content-Type: application/json", "x-api-key: " . $apiKey, "anthropic-version: 2023-06-01"],
                $payload
            );
            $json = json_decode($response, true);
            if ($codeHttp === 200 && $json) {
                echo json_encode(["result" => $json["content"][0]["text"] ?? ""]);
                exit;
            }
            echo json_encode(["error" => $json["error"]["message"] ?? "Erreur API"]);
            exit;
        }

        if ($provider === "mistral") {
            $url     = "https://api.mistral.ai/v1/chat/completions";
            $payload = [
                "model"    => "mistral-small-latest",
                "messages" => [
                    ["role" => "system", "content" => $systemPrompt],
                    ["role" => "user",   "content" => $userQuestion]
                ],
                "temperature" => 0.3
            ];
            [$codeHttp, $response] = askAPI(
                $url,
                ["Content-Type: application/json", "Authorization: Bearer " . $apiKey],
                $payload
            );
            $json = json_decode($response, true);
            if ($codeHttp === 200 && $json) {
                echo json_encode(["result" => $json["choices"][0]["message"]["content"] ?? ""]);
                exit;
            }
            echo json_encode(["error" => $json["error"]["message"] ?? "Erreur API"]);
            exit;
        }
    }

    /* -- Pas de clé perso : basculement Groq gratuit → Gemini gratuit -- */

    $url     = "https://api.groq.com/openai/v1/chat/completions";
    $payload = [
        "model"    => $groqModel,
        "messages" => [
            ["role" => "system", "content" => $systemPrompt],
            ["role" => "user",   "content" => $userQuestion]
        ],
        "temperature" => 0.3,
        "reasoning_effort" => "low"
    ];
    [$codeHttp, $response] = askAPI(
        $url,
        ["Content-Type: application/json", "Authorization: Bearer " . $groqFreeKey],
        $payload
    );
    $json = json_decode($response, true);

    if ($codeHttp === 200 && $json) {
        echo json_encode(["result" => $json["choices"][0]["message"]["content"] ?? ""]);
        exit;
    }

    if ($codeHttp === 429) {
        echo json_encode(["error" => "limite_atteinte"]);
        exit;
    }

    echo json_encode(["error" => $json["error"]["message"] ?? "Erreur Groq"]);
    exit;
}

/* ==================================================
   Vérifications pour les autres actions
   (nécessitent provider + apiKey)
   ================================================== */
if (!$provider || !$apiKey || !$action) {
    echo json_encode(["error" => "Paramètres manquants"]);
    exit;
}



/* ==================================================
   Action "raw_chat" : prompt libre (utilise le moteur choisi)
   Utilisee par genere_exercice_ia.php. Additif, n'affecte
   aucune action existante.
   ================================================== */
if ($action === "raw_chat") {
    $system = $data["system"] ?? "";
    $user   = $data["user"]   ?? "";
    [$ok, $contenu, $err] = chatLLM($provider, $apiKey, $system, $user, 0.4, 4096);
    if ($ok) {
        echo json_encode(["result" => $contenu]);
    } else {
        echo json_encode(["error" => $err ?: "Erreur de generation"]);
    }
    exit;
}

function buildPrompt($action, $code, $question, $errorMessage, $source) {
    if ($action === "correct") {
        if ($source === 'sql') {
            return [
                "system" => "Corrige le code SQL suivant. Réponds uniquement avec le code corrigé, sans ``` ni markdown.",
                "user"   => $code
            ];
        }
        return [
            "system" => "Corrige le code Python suivant. Réponds uniquement avec le code corrigé.",
            "user"   => $code
        ];
    }
    if ($action === "generate") {
        if ($source === 'sql') {
            return [
                "system" => "Génère une requête SQL. Réponds uniquement avec du code SQL, sans ``` ni markdown. Utilise une syntaxe SQL standard compatible avec la plupart des SGBD.",
                "user"   => $question
            ];
        }
        return [
            "system" => "Génère une fonction Python. Réponds uniquement avec du code Python.",
            "user"   => $question
        ];
    }
    if ($action === "explain") {
        if ($source === 'sql') {
            return [
                "system" => "Tu es un assistant SQL pédagogique. Corrige le code SQL. Quand tu corriges une ligne, ajoute juste avant cette ligne un commentaire SQL très court commençant par -- expliquant la correction. Les commentaires doivent être placés juste avant la ligne corrigée. N'ajoute pas de bloc d'explications au début. Réponds uniquement avec du code SQL, sans ``` ni markdown.",
                "user"   => "Corrige ce code SQL et explique brièvement chaque correction directement dans le code :\n\n" . $code
            ];
        }
        return [
            "system" => "Tu es un assistant Python pédagogique. Corrige le code Python. Quand tu corriges une ligne, ajoute juste avant cette ligne un commentaire Python très court commençant par # expliquant la correction. Les commentaires doivent être placés juste avant la ligne corrigée. N'ajoute pas de bloc d'explications au début. Réponds uniquement avec du code Python, sans ``` ni markdown.",
            "user"   => "Corrige ce code Python et explique brièvement chaque correction directement dans le code :\n\n" . $code
        ];
    }
    if ($action === "ping") {
        return [
            "system" => "Réponds simplement pong.",
            "user"   => "ping"
        ];
    }
    echo json_encode(["error" => "Action inconnue"]);
    exit;
}

$prompt = buildPrompt($action, $code, $question, $errorMessage, $source);

/* ==================================================
   Ping de vérification de clé
   ================================================== */
if ($action === "ping") {

    if ($provider === "deepseek") {
        $url     = "https://api.deepseek.com/chat/completions";
        $payload = [
            "model"       => "deepseek-chat",
            "messages"    => [["role" => "user", "content" => "ping"]],
            "max_tokens"  => 1,
            "temperature" => 0
        ];
        [$codeHttp, $response] = askAPI(
            $url,
            ["Content-Type: application/json", "Authorization: Bearer " . $apiKey],
            $payload
        );
        $json = json_decode($response, true);
        if ($codeHttp !== 200) {
            echo json_encode(["error" => $json["error"]["message"] ?? "Connexion échouée"]);
            exit;
        }
        echo json_encode(["ok" => true]);
        exit;
    }

    if ($provider === "openai") {
        $url     = "https://api.openai.com/v1/chat/completions";
        $payload = [
            "model"       => "gpt-4o-mini",
            "messages"    => [["role" => "user", "content" => "ping"]],
            "max_tokens"  => 1,
            "temperature" => 0
        ];
        [$codeHttp, $response] = askAPI(
            $url,
            ["Content-Type: application/json", "Authorization: Bearer " . $apiKey],
            $payload
        );
        $json = json_decode($response, true);
        if ($codeHttp !== 200) {
            echo json_encode(["error" => $json["error"]["message"] ?? "Connexion échouée"]);
            exit;
        }
        echo json_encode(["ok" => true]);
        exit;
    }

    if ($provider === "anthropic") {
        $url     = "https://api.anthropic.com/v1/messages";
        $payload = [
            "model"      => "claude-3-5-sonnet-20241022",
            "max_tokens" => 1,
            "messages"   => [["role" => "user", "content" => "ping"]]
        ];
        [$codeHttp, $response] = askAPI(
            $url,
            ["Content-Type: application/json", "x-api-key: " . $apiKey, "anthropic-version: 2023-06-01"],
            $payload
        );
        $json = json_decode($response, true);
        if ($codeHttp !== 200) {
            echo json_encode(["error" => $json["error"]["message"] ?? "Connexion échouée"]);
            exit;
        }
        echo json_encode(["ok" => true]);
        exit;
    }

    if ($provider === "mistral") {
        $url     = "https://api.mistral.ai/v1/chat/completions";
        $payload = [
            "model"       => "mistral-small-latest",
            "messages"    => [["role" => "user", "content" => "ping"]],
            "max_tokens"  => 1,
            "temperature" => 0
        ];
        [$codeHttp, $response] = askAPI(
            $url,
            ["Content-Type: application/json", "Authorization: Bearer " . $apiKey],
            $payload
        );
        $json = json_decode($response, true);
        if ($codeHttp !== 200) {
            echo json_encode(["error" => $json["error"]["message"] ?? "Connexion échouée"]);
            exit;
        }
        echo json_encode(["ok" => true]);
        exit;
    }

    if ($provider === "groq") {
        $url     = "https://api.groq.com/openai/v1/chat/completions";
        $payload = [
            "model"       => $groqModel,
            "messages"    => [["role" => "user", "content" => "ping"]],
            "max_tokens"  => 1,
            "temperature" => 0,
            "reasoning_effort" => "low"
        ];
        [$codeHttp, $response] = askAPI(
            $url,
            ["Content-Type: application/json", "Authorization: Bearer " . $apiKey],
            $payload
        );
        $json = json_decode($response, true);
        if ($codeHttp !== 200) {
            echo json_encode(["error" => $json["error"]["message"] ?? "Connexion échouée"]);
            exit;
        }
        echo json_encode(["ok" => true]);
        exit;
    }

    if ($provider === "gemini" || $provider === "gemini-cloud") {
        $url     = geminiUrl($provider, $apiKey);
        $payload = [
            "contents"         => [["role" => "user", "parts" => [["text" => "ping"]]]],
            "generationConfig" => ["maxOutputTokens" => 1]
        ];
        [$codeHttp, $response] = askAPI(
            $url,
            ["Content-Type: application/json"],
            $payload
        );
        $json = json_decode($response, true);
        if ($codeHttp !== 200) {
            echo json_encode(["error" => $json["error"]["message"] ?? "Connexion échouée"]);
            exit;
        }
        echo json_encode(["ok" => true]);
        exit;
    }

    echo json_encode(["error" => "Provider non supporté"]);
    exit;
}

/* ==================================================
   Appels réels (correct, generate, explain)
   ================================================== */
if ($provider === "deepseek" || $provider === "openai") {
    $url   = $provider === "deepseek"
        ? "https://api.deepseek.com/chat/completions"
        : "https://api.openai.com/v1/chat/completions";
    $model = $provider === "deepseek" ? "deepseek-chat" : "gpt-4o-mini";
    $payload = [
        "model"    => $model,
        "messages" => [
            ["role" => "system", "content" => $prompt["system"]],
            ["role" => "user",   "content" => $prompt["user"]]
        ],
        "temperature" => 0.2
    ];
    [$codeHttp, $response] = askAPI(
        $url,
        ["Content-Type: application/json", "Authorization: Bearer " . $apiKey],
        $payload
    );
    $json = json_decode($response, true);
    if (!$json) { echo json_encode(["error" => "Réponse API invalide"]); exit; }
    if ($codeHttp !== 200) { echo json_encode(["error" => $json["error"]["message"] ?? "Erreur API"]); exit; }
    echo json_encode(["result" => $json["choices"][0]["message"]["content"] ?? ""]);
    exit;
}

if ($provider === "anthropic") {
    $url     = "https://api.anthropic.com/v1/messages";
    $payload = [
        "model"      => "claude-3-5-sonnet-20241022",
        "max_tokens" => 1200,
        "system"     => $prompt["system"],
        "messages"   => [["role" => "user", "content" => $prompt["user"]]]
    ];
    [$codeHttp, $response] = askAPI(
        $url,
        ["Content-Type: application/json", "x-api-key: " . $apiKey, "anthropic-version: 2023-06-01"],
        $payload
    );
    $json = json_decode($response, true);
    if (!$json) { echo json_encode(["error" => "Réponse API invalide"]); exit; }
    if ($codeHttp !== 200) { echo json_encode(["error" => $json["error"]["message"] ?? "Erreur API"]); exit; }
    echo json_encode(["result" => $json["content"][0]["text"] ?? ""]);
    exit;
}

if ($provider === "mistral") {
    $url     = "https://api.mistral.ai/v1/chat/completions";
    $payload = [
        "model"    => "mistral-small-latest",
        "messages" => [
            ["role" => "system", "content" => $prompt["system"]],
            ["role" => "user",   "content" => $prompt["user"]]
        ],
        "temperature" => 0.2
    ];
    [$codeHttp, $response] = askAPI(
        $url,
        ["Content-Type: application/json", "Authorization: Bearer " . $apiKey],
        $payload
    );
    $json = json_decode($response, true);
    if (!$json) { echo json_encode(["error" => "Réponse API invalide"]); exit; }
    if ($codeHttp !== 200) { echo json_encode(["error" => $json["error"]["message"] ?? "Erreur API"]); exit; }
    echo json_encode(["result" => $json["choices"][0]["message"]["content"] ?? ""]);
    exit;
}

if ($provider === "groq") {
    $url     = "https://api.groq.com/openai/v1/chat/completions";
    $payload = [
        "model"    => $groqModel,
        "messages" => [
            ["role" => "system", "content" => $prompt["system"]],
            ["role" => "user",   "content" => $prompt["user"]]
        ],
        "temperature" => 0.2,
        "reasoning_effort" => "low"
    ];
    [$codeHttp, $response] = askAPI(
        $url,
        ["Content-Type: application/json", "Authorization: Bearer " . $apiKey],
        $payload
    );
    $json = json_decode($response, true);
    if (!$json) { echo json_encode(["error" => "Réponse API invalide"]); exit; }
    if ($codeHttp !== 200) { echo json_encode(["error" => $json["error"]["message"] ?? "Erreur API"]); exit; }
    echo json_encode(["result" => $json["choices"][0]["message"]["content"] ?? ""]);
    exit;
}

if ($provider === "gemini" || $provider === "gemini-cloud") {
    $url     = geminiUrl($provider, $apiKey);
    $payload = [
        "system_instruction" => ["parts" => [["text" => $prompt["system"]]]],
        "contents"           => [["role" => "user", "parts" => [["text" => $prompt["user"]]]]],
        "generationConfig"   => ["temperature" => 0.2]
    ];
    [$codeHttp, $response] = askAPI(
        $url,
        ["Content-Type: application/json"],
        $payload
    );
    $json = json_decode($response, true);
    if (!$json) { echo json_encode(["error" => "Réponse API invalide"]); exit; }
    if ($codeHttp !== 200) { echo json_encode(["error" => $json["error"]["message"] ?? "Erreur API"]); exit; }
    echo json_encode(["result" => $json["candidates"][0]["content"]["parts"][0]["text"] ?? ""]);
    exit;
}

echo json_encode(["error" => "Provider non supporté"]);