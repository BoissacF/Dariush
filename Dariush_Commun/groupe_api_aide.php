<?php
header("Content-Type: application/json; charset=utf-8");
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type");

if ($_SERVER["REQUEST_METHOD"] === "OPTIONS") {
    http_response_code(204);
    exit;
}

require __DIR__ . "/db.php";

/* ===================================================
   UTILITAIRES
=================================================== */

function out_aide(array $arr, int $code = 200): void {
    http_response_code($code);
    echo json_encode($arr, JSON_UNESCAPED_UNICODE);
    exit;
}

function cleanFantomes_aide(PDO $pdo): void {
    $pdo->exec("
        DELETE FROM members_aide
        WHERE last_ping < (NOW() - INTERVAL 15 SECOND)
        AND statut != 'termine'
    ");
    $pdo->exec("
        DELETE FROM sessions_aide
        WHERE last_ping < (NOW() - INTERVAL 30 SECOND)
    ");
}

function getSessionAide(PDO $pdo, string $codeAide) {
    $stmt = $pdo->prepare("SELECT * FROM sessions_aide WHERE code_aide = ?");
    $stmt->execute([$codeAide]);
    return $stmt->fetch();
}

function getMemberAide(PDO $pdo, string $codeAide, string $pseudoEleve) {
    $stmt = $pdo->prepare("
        SELECT * FROM members_aide
        WHERE code_aide = ? AND pseudo_eleve = ?
        LIMIT 1
    ");
    $stmt->execute([$codeAide, $pseudoEleve]);
    return $stmt->fetch();
}

function getFile_aide(PDO $pdo, string $codeAide): array {
    $stmt = $pdo->prepare("
        SELECT id, pseudo_eleve, position, statut
        FROM members_aide
        WHERE code_aide = ? AND statut IN ('attente','actif')
        ORDER BY position ASC
    ");
    $stmt->execute([$codeAide]);
    return $stmt->fetchAll();
}

function getEventsSince_aide(PDO $pdo, string $codeAide, string $pseudoEleve, int $lastId): array {
    $stmt = $pdo->prepare("
        SELECT id, type, contenu, auteur, created_at
        FROM events_aide
        WHERE code_aide = ? AND pseudo_eleve = ? AND id > ?
        ORDER BY id ASC
    ");
    $stmt->execute([$codeAide, $pseudoEleve, $lastId]);
    return $stmt->fetchAll();
}

function getChatMessages_aide(PDO $pdo, string $codeAide): array {
    $stmt = $pdo->prepare("
        SELECT pseudo, text, created_at
        FROM messages_aide
        WHERE code_aide = ?
        ORDER BY id ASC
    ");
    $stmt->execute([$codeAide]);
    return $stmt->fetchAll();
}

function cloturerEleve_aide(PDO $pdo, string $codeAide, string $pseudoEleve): void {
    $pdo->prepare("
        DELETE FROM events_aide
        WHERE code_aide = ? AND pseudo_eleve = ?
    ")->execute([$codeAide, $pseudoEleve]);

    $pdo->prepare("
        DELETE FROM messages_aide
        WHERE code_aide = ?
    ")->execute([$codeAide]);

    $pdo->prepare("
        DELETE FROM members_aide
        WHERE code_aide = ? AND pseudo_eleve = ?
    ")->execute([$codeAide, $pseudoEleve]);
}

function reordonnerFile_aide(PDO $pdo, string $codeAide): void {
    $stmt = $pdo->prepare("
        SELECT id FROM members_aide
        WHERE code_aide = ? AND statut IN ('attente','actif')
        ORDER BY position ASC
    ");
    $stmt->execute([$codeAide]);
    $rows = $stmt->fetchAll();

    $pos = 1;
    foreach ($rows as $row) {
        $pdo->prepare("UPDATE members_aide SET position = ? WHERE id = ?")
            ->execute([$pos, $row["id"]]);
        $pos++;
    }
}

/* ===================================================
   LECTURE INPUT
=================================================== */
$input = json_decode(file_get_contents("php://input"), true);

if (!is_array($input)) {
    out_aide(["ok" => false, "error" => "JSON invalide"], 400);
}

$action      = trim($input["action"]       ?? "");
$codeAide    = trim($input["code_aide"]    ?? "");
$pseudoEleve = trim($input["pseudo_eleve"] ?? "");
$pseudoProf  = trim($input["pseudo_prof"]  ?? "");

if ($action === "") {
    out_aide(["ok" => false, "error" => "Action manquante"], 400);
}

try {

    /* ===================================================
       CREER_SESSION_AIDE
    =================================================== */
    if ($action === "creer_session_aide") {
        if ($codeAide === "" || $pseudoProf === "") {
            out_aide(["ok" => false, "error" => "code_aide et pseudo_prof requis"], 400);
        }
        if (strlen($codeAide) < 6) {
            out_aide(["ok" => false, "error" => "Le code doit faire au moins 6 caractères"], 400);
        }

        cleanFantomes_aide($pdo);

        $session = getSessionAide($pdo, $codeAide);
        if ($session) {
            if ($session["pseudo_prof"] === $pseudoProf) {
                $pdo->prepare("
                    UPDATE sessions_aide SET last_ping = NOW()
                    WHERE code_aide = ?
                ")->execute([$codeAide]);
                out_aide(["ok" => true, "action" => "reconnexion"]);
            }
            out_aide(["ok" => false, "error" => "Ce code d'aide est déjà utilisé par un professeur"], 409);
        }

        $pdo->prepare("
            INSERT INTO sessions_aide (code_aide, pseudo_prof, created_at, last_ping)
            VALUES (?, ?, NOW(), NOW())
        ")->execute([$codeAide, $pseudoProf]);

        out_aide(["ok" => true, "action" => "creation"]);
    }

    /* ===================================================
       REJOINDRE_AIDE
    =================================================== */
    if ($action === "rejoindre_aide") {
        if ($codeAide === "" || $pseudoEleve === "") {
            out_aide(["ok" => false, "error" => "code_aide et pseudo_eleve requis"], 400);
        }

        cleanFantomes_aide($pdo);

        $session = getSessionAide($pdo, $codeAide);
        if (!$session) {
            out_aide(["ok" => false, "error" => "Code d'aide invalide ou professeur non connecté"], 404);
        }

        $existing = getMemberAide($pdo, $codeAide, $pseudoEleve);
        if ($existing) {
            $pdo->prepare("
                UPDATE members_aide SET last_ping = NOW()
                WHERE code_aide = ? AND pseudo_eleve = ?
            ")->execute([$codeAide, $pseudoEleve]);

            $file = getFile_aide($pdo, $codeAide);
            $monRang = 0;
            foreach ($file as $i => $m) {
                if ($m["pseudo_eleve"] === $pseudoEleve) {
                    $monRang = $i + 1;
                    break;
                }
            }
            out_aide([
                "ok"     => true,
                "action" => "reconnexion",
                "statut" => $existing["statut"],
                "rang"   => $monRang,
                "total"  => count($file)
            ]);
        }

        $stmt = $pdo->prepare("
            SELECT COALESCE(MAX(position), 0) + 1 AS next_pos
            FROM members_aide
            WHERE code_aide = ? AND statut IN ('attente','actif')
        ");
        $stmt->execute([$codeAide]);
        $nextPos = (int)$stmt->fetchColumn();

        $pdo->prepare("
            INSERT INTO members_aide
                (code_aide, pseudo_eleve, position, statut, created_at, last_ping)
            VALUES (?, ?, ?, 'attente', NOW(), NOW())
        ")->execute([$codeAide, $pseudoEleve, $nextPos]);

        $file = getFile_aide($pdo, $codeAide);

        out_aide([
            "ok"     => true,
            "action" => "inscription",
            "rang"   => $nextPos,
            "total"  => count($file)
        ]);
    }

    /* ===================================================
       POLL_PROF_AIDE
       Snapshot : lu une seule fois puis effacé de la BDD
       Renvoie aussi snapshot_page_index
    =================================================== */
    if ($action === "poll_prof_aide") {
        if ($codeAide === "" || $pseudoProf === "") {
            out_aide(["ok" => false, "error" => "code_aide et pseudo_prof requis"], 400);
        }

        cleanFantomes_aide($pdo);

        $session = getSessionAide($pdo, $codeAide);
        if (!$session) {
            out_aide(["ok" => false, "error" => "Session introuvable"], 404);
        }

        $pdo->prepare("
            UPDATE sessions_aide SET last_ping = NOW() WHERE code_aide = ?
        ")->execute([$codeAide]);

        $file = getFile_aide($pdo, $codeAide);

        $eleveActif = null;
        foreach ($file as $m) {
            if ($m["statut"] === "actif") {
                $eleveActif = $m["pseudo_eleve"];
                break;
            }
        }

        $events          = [];
        $snapshot        = null;
        $snapshotPageIdx = 0;
        $chatMessages    = [];
        $lastEventId     = (int)($input["last_event_id"] ?? 0);

        if ($eleveActif) {
            $memberRow = getMemberAide($pdo, $codeAide, $eleveActif);
            if ($memberRow && !empty($memberRow["snapshot"])) {
                // Lit le snapshot + l'index de page active, efface après lecture
                $snapshot        = $memberRow["snapshot"];
                $snapshotPageIdx = (int)($memberRow["active_page_index"] ?? 0);
                $pdo->prepare("
                    UPDATE members_aide
                    SET snapshot = NULL, snapshot_expires_at = NULL
                    WHERE id = ?
                ")->execute([(int)$memberRow["id"]]);
            }

            $events       = getEventsSince_aide($pdo, $codeAide, $eleveActif, $lastEventId);
            $chatMessages = getChatMessages_aide($pdo, $codeAide);
        }

        out_aide([
            "ok"                  => true,
            "file"                => $file,
            "eleve_actif"         => $eleveActif,
            "snapshot"            => $snapshot,
            "snapshot_page_index" => $snapshotPageIdx,
            "events"              => $events,
            "chat_messages"       => $chatMessages
        ]);
    }

    /* ===================================================
       POLL_ELEVE_AIDE
    =================================================== */
    if ($action === "poll_eleve_aide") {
        if ($codeAide === "" || $pseudoEleve === "") {
            out_aide(["ok" => false, "error" => "code_aide et pseudo_eleve requis"], 400);
        }

        $member = getMemberAide($pdo, $codeAide, $pseudoEleve);
        if (!$member) {
            out_aide(["ok" => false, "error" => "Élève introuvable"], 404);
        }

        $pdo->prepare("
            UPDATE members_aide SET last_ping = NOW()
            WHERE code_aide = ? AND pseudo_eleve = ?
        ")->execute([$codeAide, $pseudoEleve]);

        $file = getFile_aide($pdo, $codeAide);
        $monRang = 0;
        foreach ($file as $i => $m) {
            if ($m["pseudo_eleve"] === $pseudoEleve) {
                $monRang = $i + 1;
                break;
            }
        }

        $events       = [];
        $chatMessages = [];
        $lastEventId  = (int)($input["last_event_id"] ?? 0);

        if ($member["statut"] === "actif") {
            $events       = getEventsSince_aide($pdo, $codeAide, $pseudoEleve, $lastEventId);
            $chatMessages = getChatMessages_aide($pdo, $codeAide);
        }

        out_aide([
            "ok"            => true,
            "statut"        => $member["statut"],
            "rang"          => $monRang,
            "total"         => count($file),
            "events"        => $events,
            "chat_messages" => $chatMessages
        ]);
    }

    /* ===================================================
       ACTIVER_ELEVE_AIDE
    =================================================== */
    if ($action === "activer_eleve_aide") {
        if ($codeAide === "" || $pseudoEleve === "" || $pseudoProf === "") {
            out_aide(["ok" => false, "error" => "Données incomplètes"], 400);
        }

        $session = getSessionAide($pdo, $codeAide);
        if (!$session || $session["pseudo_prof"] !== $pseudoProf) {
            out_aide(["ok" => false, "error" => "Session invalide ou non autorisé"], 403);
        }

        $file = getFile_aide($pdo, $codeAide);
        foreach ($file as $m) {
            if ($m["statut"] === "actif" && $m["pseudo_eleve"] !== $pseudoEleve) {
                cloturerEleve_aide($pdo, $codeAide, $m["pseudo_eleve"]);
            }
        }

        $member = getMemberAide($pdo, $codeAide, $pseudoEleve);
        if (!$member) {
            out_aide(["ok" => false, "error" => "Élève introuvable dans la file"], 404);
        }

        $pdo->prepare("
            UPDATE members_aide SET statut = 'actif', last_ping = NOW()
            WHERE code_aide = ? AND pseudo_eleve = ?
        ")->execute([$codeAide, $pseudoEleve]);

        reordonnerFile_aide($pdo, $codeAide);

        out_aide(["ok" => true]);
    }

    /* ===================================================
       PUSH_SNAPSHOT_AIDE
       Stocke aussi active_page_index
    =================================================== */
    if ($action === "push_snapshot_aide") {
        if ($codeAide === "" || $pseudoEleve === "") {
            out_aide(["ok" => false, "error" => "Données incomplètes"], 400);
        }

        $snapshot = (string)($input["snapshot"] ?? "");
        if ($snapshot === "") {
            out_aide(["ok" => false, "error" => "Snapshot vide"], 400);
        }
        if (strlen($snapshot) > 512000) {
            out_aide(["ok" => false, "error" => "Snapshot trop volumineux (max 500 ko)"], 400);
        }

        $member = getMemberAide($pdo, $codeAide, $pseudoEleve);
        if (!$member || $member["statut"] !== "actif") {
            out_aide(["ok" => false, "error" => "Élève non actif"], 403);
        }

        $activePageIndex = (int)($input["active_page_index"] ?? 0);

        $pdo->prepare("
            UPDATE members_aide
            SET snapshot = ?,
                snapshot_expires_at = NULL,
                active_page_index = ?,
                last_ping = NOW()
            WHERE code_aide = ? AND pseudo_eleve = ?
        ")->execute([$snapshot, $activePageIndex, $codeAide, $pseudoEleve]);

        out_aide(["ok" => true]);
    }

    /* ===================================================
       SEND_CODE_AIDE
    =================================================== */
    if ($action === "send_code_aide") {
        if ($codeAide === "" || $pseudoEleve === "") {
            out_aide(["ok" => false, "error" => "Données incomplètes"], 400);
        }

        $contenu = (string)($input["contenu"] ?? "");
        $auteur  = ($input["auteur"] ?? "") === "prof" ? "prof" : "eleve";

        if ($contenu === "") {
            out_aide(["ok" => false, "error" => "Contenu vide"], 400);
        }

        $pdo->prepare("
            INSERT INTO events_aide (code_aide, pseudo_eleve, type, contenu, auteur, created_at)
            VALUES (?, ?, 'code', ?, ?, NOW())
        ")->execute([$codeAide, $pseudoEleve, $contenu, $auteur]);

        if ($auteur === "eleve") {
            $pdo->prepare("
                UPDATE members_aide SET last_ping = NOW()
                WHERE code_aide = ? AND pseudo_eleve = ?
            ")->execute([$codeAide, $pseudoEleve]);
        } else {
            $pdo->prepare("
                UPDATE sessions_aide SET last_ping = NOW() WHERE code_aide = ?
            ")->execute([$codeAide]);
        }

        out_aide(["ok" => true]);
    }

    /* ===================================================
       SEND_MESSAGE_AIDE
    =================================================== */
    if ($action === "send_message_aide") {
        if ($codeAide === "" || $pseudoEleve === "") {
            out_aide(["ok" => false, "error" => "Données incomplètes"], 400);
        }

        $contenu = trim((string)($input["contenu"] ?? ""));
        $auteur  = ($input["auteur"] ?? "") === "prof" ? "prof" : "eleve";
        $pseudo  = $auteur === "prof" ? $pseudoProf : $pseudoEleve;

        if ($contenu === "") {
            out_aide(["ok" => false, "error" => "Message vide"], 400);
        }

        $pdo->prepare("
            DELETE FROM messages_aide
            WHERE code_aide = ? AND created_at < NOW() - INTERVAL 2 HOUR
        ")->execute([$codeAide]);

        $pdo->prepare("
            INSERT INTO messages_aide (code_aide, pseudo, text)
            VALUES (?, ?, ?)
        ")->execute([$codeAide, $pseudo, $contenu]);

        $stmt = $pdo->prepare("
            SELECT id FROM messages_aide
            WHERE code_aide = ?
            ORDER BY id DESC
            LIMIT 20, 1000
        ");
        $stmt->execute([$codeAide]);
        $toDelete = $stmt->fetchAll(PDO::FETCH_COLUMN);

        if (!empty($toDelete)) {
            $placeholders = implode(",", array_fill(0, count($toDelete), "?"));
            $pdo->prepare("DELETE FROM messages_aide WHERE id IN ($placeholders)")
                ->execute($toDelete);
        }

        if ($auteur === "eleve") {
            $pdo->prepare("
                UPDATE members_aide SET last_ping = NOW()
                WHERE code_aide = ? AND pseudo_eleve = ?
            ")->execute([$codeAide, $pseudoEleve]);
        } else {
            $pdo->prepare("
                UPDATE sessions_aide SET last_ping = NOW() WHERE code_aide = ?
            ")->execute([$codeAide]);
        }

        out_aide(["ok" => true]);
    }

    /* ===================================================
       CLOTURER_AIDE
    =================================================== */
    if ($action === "cloturer_aide") {
        if ($codeAide === "" || $pseudoEleve === "" || $pseudoProf === "") {
            out_aide(["ok" => false, "error" => "Données incomplètes"], 400);
        }

        $session = getSessionAide($pdo, $codeAide);
        if (!$session || $session["pseudo_prof"] !== $pseudoProf) {
            out_aide(["ok" => false, "error" => "Non autorisé"], 403);
        }

        cloturerEleve_aide($pdo, $codeAide, $pseudoEleve);
        reordonnerFile_aide($pdo, $codeAide);

        out_aide(["ok" => true]);
    }

    /* ===================================================
       QUITTER_ELEVE_AIDE
    =================================================== */
    if ($action === "quitter_eleve_aide") {
        if ($codeAide === "" || $pseudoEleve === "") {
            out_aide(["ok" => false, "error" => "Données incomplètes"], 400);
        }

        cloturerEleve_aide($pdo, $codeAide, $pseudoEleve);
        reordonnerFile_aide($pdo, $codeAide);

        out_aide(["ok" => true]);
    }

    /* ===================================================
       QUITTER_PROF_AIDE
    =================================================== */
    if ($action === "quitter_prof_aide") {
        if ($codeAide === "" || $pseudoProf === "") {
            out_aide(["ok" => false, "error" => "Données incomplètes"], 400);
        }

        $session = getSessionAide($pdo, $codeAide);
        if (!$session || $session["pseudo_prof"] !== $pseudoProf) {
            out_aide(["ok" => false, "error" => "Non autorisé"], 403);
        }

        $pdo->prepare("DELETE FROM events_aide    WHERE code_aide = ?")->execute([$codeAide]);
        $pdo->prepare("DELETE FROM messages_aide  WHERE code_aide = ?")->execute([$codeAide]);
        $pdo->prepare("DELETE FROM members_aide   WHERE code_aide = ?")->execute([$codeAide]);
        $pdo->prepare("DELETE FROM sessions_aide  WHERE code_aide = ?")->execute([$codeAide]);

        out_aide(["ok" => true]);
    }

    out_aide(["ok" => false, "error" => "Action inconnue"], 400);

} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    out_aide([
        "ok"    => false,
        "error" => $e->getMessage()
    ], 500);
}