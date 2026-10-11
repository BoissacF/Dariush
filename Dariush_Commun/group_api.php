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

function out(array $arr, int $code = 200): void {
    http_response_code($code);
    echo json_encode($arr, JSON_UNESCAPED_UNICODE);
    exit;
}

function cleanOldMembers(PDO $pdo, int $sessionId): void {
    $sql = "DELETE FROM members
            WHERE session_id = ?
              AND last_seen < (NOW() - INTERVAL 45 SECOND)";
    $stmt = $pdo->prepare($sql);
    $stmt->execute([$sessionId]);
}

function cleanExpiredSnapshots(PDO $pdo, int $sessionId): void {
    $stmt = $pdo->prepare("
        UPDATE sessions
        SET notebook_snapshot = NULL, snapshot_expires_at = NULL
        WHERE id = ? AND snapshot_expires_at IS NOT NULL AND snapshot_expires_at < NOW()
    ");
    $stmt->execute([$sessionId]);
}

function getSessionByCode(PDO $pdo, string $sessionCode) {
    $stmt = $pdo->prepare("SELECT * FROM sessions WHERE session_code = ?");
    $stmt->execute([$sessionCode]);
    return $stmt->fetch();
}

function ensureSession(PDO $pdo, string $sessionCode) {
    $session = getSessionByCode($pdo, $sessionCode);
    if ($session) {
        return $session;
    }

    $stmt = $pdo->prepare("
        INSERT INTO sessions (session_code, current_text, edit_mode, allowed_editor_id, admin_client_id, current_page_index)
        VALUES (?, '', 'none', NULL, NULL, 0)
    ");
    $stmt->execute([$sessionCode]);

    return getSessionByCode($pdo, $sessionCode);
}

function getMembers(PDO $pdo, int $sessionId): array {
    $stmt = $pdo->prepare("
        SELECT client_id, pseudo, role, is_typing, requested_edit
        FROM members
        WHERE session_id = ?
        ORDER BY joined_at ASC
    ");
    $stmt->execute([$sessionId]);
    return $stmt->fetchAll();
}

function getRequests(PDO $pdo, int $sessionId): array {
    $stmt = $pdo->prepare("
        SELECT client_id, pseudo
        FROM members
        WHERE session_id = ? AND requested_edit = 1
        ORDER BY joined_at ASC
    ");
    $stmt->execute([$sessionId]);
    return $stmt->fetchAll();
}

function getEventsSince(PDO $pdo, int $sessionId, int $lastEventId): array {
    $stmt = $pdo->prepare("
        SELECT id, event_type, event_data, created_at
        FROM events
        WHERE session_id = ? AND id > ?
        ORDER BY id ASC
    ");
    $stmt->execute([$sessionId, $lastEventId]);
    $rows = $stmt->fetchAll();

    foreach ($rows as &$row) {
        $row["event_data"] = $row["event_data"] ? json_decode($row["event_data"], true) : null;
    }

    return $rows;
}

function addEvent(PDO $pdo, int $sessionId, string $type, array $data = []): void {
    $stmt = $pdo->prepare("
        INSERT INTO events (session_id, event_type, event_data)
        VALUES (?, ?, ?)
    ");
    $stmt->execute([
        $sessionId,
        $type,
        json_encode($data, JSON_UNESCAPED_UNICODE)
    ]);
}

function getMember(PDO $pdo, int $sessionId, string $clientId) {
    $stmt = $pdo->prepare("
        SELECT *
        FROM members
        WHERE session_id = ? AND client_id = ?
        LIMIT 1
    ");
    $stmt->execute([$sessionId, $clientId]);
    return $stmt->fetch();
}

function getAliveAdminClientId(PDO $pdo, int $sessionId, ?string $adminClientId): ?string {
    if (!$adminClientId) {
        return null;
    }

    $stmt = $pdo->prepare("
        SELECT client_id
        FROM members
        WHERE session_id = ? AND client_id = ? AND role = 'admin'
        LIMIT 1
    ");
    $stmt->execute([$sessionId, $adminClientId]);
    $row = $stmt->fetch();

    return $row ? $row["client_id"] : null;
}

/* -------------------------------------------------------
   Construit le bloc "state" renvoyé dans poll et join
   Gère le snapshot : le renvoie s'il est encore valide,
   sinon renvoie null. Ne renvoie le snapshot qu'aux élèves.
------------------------------------------------------- */
function buildStateBlock(array $session, string $myRole, bool $adminPresent): array {
    $stateCurrentText = $session["current_text"];
    if ($myRole !== "admin" && !$adminPresent) {
        $stateCurrentText = "";
    }

    // Snapshot : valide seulement si non expiré
    $snapshot = null;
    if (
        !empty($session["notebook_snapshot"]) &&
        !empty($session["snapshot_expires_at"]) &&
        strtotime($session["snapshot_expires_at"]) > time()
    ) {
        $snapshot = $session["notebook_snapshot"];
    }

    return [
        "current_text"       => $stateCurrentText,
        "edit_mode"          => $session["edit_mode"],
        "allowed_editor_id"  => $session["allowed_editor_id"],
        "current_page_index" => (int)($session["current_page_index"] ?? 0),
        "snapshot"           => $snapshot,
        // Signale au prof qu'un élève attend son fichier
        "snapshot_requested" => (int)($session["snapshot_requested"] ?? 0) === 1,
    ];
}

/* ===================================================
   LECTURE INPUT
=================================================== */
$input = json_decode(file_get_contents("php://input"), true);

if (!is_array($input)) {
    out(["ok" => false, "error" => "JSON invalide"], 400);
}

$action      = $input["action"]       ?? "";
$sessionCode = trim($input["session_code"] ?? "");
$clientId    = trim($input["client_id"]    ?? "");
$pseudo      = trim($input["pseudo"]       ?? "");

if ($action === "") {
    out(["ok" => false, "error" => "Action manquante"], 400);
}

if (!in_array($action, ["join"], true)) {
    if ($sessionCode === "" || $clientId === "") {
        out(["ok" => false, "error" => "session_code ou client_id manquant"], 400);
    }
}

try {

    /* ===================================================
       JOIN
    =================================================== */
    if ($action === "join") {
        if ($sessionCode === "" || $clientId === "" || $pseudo === "") {
            out(["ok" => false, "error" => "Données incomplètes"], 400);
        }

        $requestedRole = (($input["requested_role"] ?? "student") === "teacher") ? "teacher" : "student";

        $pdo->beginTransaction();

        $session   = ensureSession($pdo, $sessionCode);
        $sessionId = (int)$session["id"];

        cleanOldMembers($pdo, $sessionId);
        cleanExpiredSnapshots($pdo, $sessionId);

        $session             = getSessionByCode($pdo, $sessionCode);
        $existingMember      = getMember($pdo, $sessionId, $clientId);
        $aliveAdminClientId  = getAliveAdminClientId($pdo, $sessionId, $session["admin_client_id"]);

        if ($session["admin_client_id"] && !$aliveAdminClientId) {
            $stmt = $pdo->prepare("UPDATE sessions SET admin_client_id = NULL WHERE id = ?");
            $stmt->execute([$sessionId]);
            $session["admin_client_id"] = null;
        }

        $finalRole = "student";

        if ($session["admin_client_id"] && $session["admin_client_id"] === $clientId) {
            $finalRole = "admin";
        } elseif ($existingMember && $existingMember["role"] === "admin") {
            $finalRole = "admin";
            $stmt = $pdo->prepare("UPDATE sessions SET admin_client_id = ? WHERE id = ?");
            $stmt->execute([$clientId, $sessionId]);
        } elseif ($requestedRole === "teacher" && !$session["admin_client_id"]) {
            $finalRole = "admin";
            $stmt = $pdo->prepare("
                UPDATE sessions
                SET admin_client_id = ?, edit_mode = 'none', allowed_editor_id = NULL
                WHERE id = ?
            ");
            $stmt->execute([$clientId, $sessionId]);
        }

        $stmt = $pdo->prepare("
            INSERT INTO members (
                session_id, client_id, pseudo, role,
                is_typing, requested_edit, last_seen, joined_at
            )
            VALUES (?, ?, ?, ?, 0, 0, NOW(), NOW())
            ON DUPLICATE KEY UPDATE
                pseudo = VALUES(pseudo),
                role = VALUES(role),
                is_typing = 0,
                requested_edit = 0,
                last_seen = NOW()
        ");
        $stmt->execute([$sessionId, $clientId, $pseudo, $finalRole]);

        if ($requestedRole === "teacher" && $finalRole === "student") {
            addEvent($pdo, $sessionId, "system", [
                "type"      => "admin_demoted_to_student",
                "client_id" => $clientId
            ]);
        }

        $pdo->commit();

        $session            = getSessionByCode($pdo, $sessionCode);
        cleanOldMembers($pdo, $sessionId);
        $aliveAdminClientId = getAliveAdminClientId($pdo, $sessionId, $session["admin_client_id"]);
        $adminPresent       = !empty($aliveAdminClientId);

        out([
            "ok"           => true,
            "me_role"      => $finalRole,
            "admin_present"=> $adminPresent,
            "state"        => buildStateBlock($session, $finalRole, $adminPresent),
            "members"      => getMembers($pdo, $sessionId),
            "requests"     => getRequests($pdo, $sessionId),
            "events"       => getEventsSince($pdo, $sessionId, 0)
        ]);
    }

    /* ===================================================
       ACTIONS NÉCESSITANT UNE SESSION EXISTANTE
    =================================================== */
    $session = getSessionByCode($pdo, $sessionCode);
    if (!$session) {
        out(["ok" => false, "error" => "Session introuvable"], 404);
    }

    $sessionId = (int)$session["id"];
    cleanOldMembers($pdo, $sessionId);
    cleanExpiredSnapshots($pdo, $sessionId);
    // Relire la session après le nettoyage du snapshot
    $session = getSessionByCode($pdo, $sessionCode);

    $me = getMember($pdo, $sessionId, $clientId);

    if (!$me && $action !== "leave") {
        out(["ok" => false, "error" => "Membre non connecté"], 403);
    }

    /* ---------------------------------------------------
       HEARTBEAT
    --------------------------------------------------- */
    if ($action === "heartbeat") {
        $stmt = $pdo->prepare("
            UPDATE members SET last_seen = NOW()
            WHERE session_id = ? AND client_id = ?
        ");
        $stmt->execute([$sessionId, $clientId]);
        out(["ok" => true]);
    }

    /* ---------------------------------------------------
       POLL
    --------------------------------------------------- */
    if ($action === "poll") {
        $lastEventId = (int)($input["last_event_id"] ?? 0);

        $stmt = $pdo->prepare("
            UPDATE members SET last_seen = NOW()
            WHERE session_id = ? AND client_id = ?
        ");
        $stmt->execute([$sessionId, $clientId]);

        $session = getSessionByCode($pdo, $sessionCode);
        $me      = getMember($pdo, $sessionId, $clientId);

        if (!$me) {
            out(["ok" => false, "error" => "Membre non connecté"], 403);
        }

        $aliveAdminClientId = getAliveAdminClientId($pdo, $sessionId, $session["admin_client_id"]);
        $adminPresent       = !empty($aliveAdminClientId);

        // Élève sans snapshot disponible → signaler au prof qu'il en a besoin
        if ($me["role"] === "student" && $adminPresent) {
            $snapshotValid = !empty($session["notebook_snapshot"])
                && !empty($session["snapshot_expires_at"])
                && strtotime($session["snapshot_expires_at"]) > time();

            if (!$snapshotValid && (int)($session["snapshot_requested"] ?? 0) === 0) {
                $stmt = $pdo->prepare("
                    UPDATE sessions SET snapshot_requested = 1 WHERE id = ?
                ");
                $stmt->execute([$sessionId]);
                $session["snapshot_requested"] = 1;
            }
        }

        // Récupérer les messages du chat
        $stmtChat = $pdo->prepare("
            SELECT pseudo, text, created_at
            FROM group_messages
            WHERE session_id = ?
            ORDER BY id ASC
        ");
        $stmtChat->execute([$sessionId]);
        $chatMessages = $stmtChat->fetchAll(PDO::FETCH_ASSOC);

        out([
            "ok"            => true,
            "me_role"       => $me["role"],
            "admin_present" => $adminPresent,
            "state"         => buildStateBlock($session, $me["role"], $adminPresent),
            "members"       => getMembers($pdo, $sessionId),
            "requests"      => getRequests($pdo, $sessionId),
            "events"        => getEventsSince($pdo, $sessionId, $lastEventId),
            "chat_messages" => $chatMessages
        ]);
    }

    /* ---------------------------------------------------
       PUSH_TEXT
    --------------------------------------------------- */
    if ($action === "push_text") {
        $text    = (string)($input["text"] ?? "");
        $meRole  = $me["role"];
        $editMode= $session["edit_mode"];
        $allowedEditorId = $session["allowed_editor_id"];

        $canEdit = false;
        if ($meRole === "admin") $canEdit = true;
        if ($meRole === "student" && $editMode === "all") $canEdit = true;
        if ($meRole === "student" && $editMode === "user" && $allowedEditorId === $clientId) $canEdit = true;

        if (!$canEdit) {
            out(["ok" => false, "error" => "Modification non autorisée"], 403);
        }

        $stmt = $pdo->prepare("
            UPDATE sessions SET current_text = ?, updated_at = NOW() WHERE id = ?
        ");
        $stmt->execute([$text, $sessionId]);

        $stmt = $pdo->prepare("
            UPDATE members SET last_seen = NOW() WHERE session_id = ? AND client_id = ?
        ");
        $stmt->execute([$sessionId, $clientId]);

        out(["ok" => true]);
    }

    /* ---------------------------------------------------
       PUSH_SNAPSHOT
       Le prof envoie tout son notebook (format URL buildLink)
       Durée de vie : 30 secondes
    --------------------------------------------------- */
    if ($action === "push_snapshot") {
        if ($me["role"] !== "admin") {
            out(["ok" => false, "error" => "Réservé à l'administrateur"], 403);
        }

        $snapshot = (string)($input["snapshot"] ?? "");
        if ($snapshot === "") {
            out(["ok" => false, "error" => "Snapshot vide"], 400);
        }

        // Limite de taille : 500 ko (MEDIUMTEXT supporte 16 Mo, mais on protège la BDD)
        if (strlen($snapshot) > 512000) {
            out(["ok" => false, "error" => "Snapshot trop volumineux (max 500 ko)"], 400);
        }

        $stmt = $pdo->prepare("
            UPDATE sessions
            SET notebook_snapshot    = ?,
                snapshot_expires_at  = DATE_ADD(NOW(), INTERVAL 30 SECOND),
                snapshot_requested   = 0,
                updated_at           = NOW()
            WHERE id = ?
        ");
        $stmt->execute([$snapshot, $sessionId]);

        $stmt = $pdo->prepare("
            UPDATE members SET last_seen = NOW() WHERE session_id = ? AND client_id = ?
        ");
        $stmt->execute([$sessionId, $clientId]);

        out(["ok" => true]);
    }

    /* ---------------------------------------------------
       SET_PAGE
       Le prof change de page → tous les élèves suivent
    --------------------------------------------------- */
    if ($action === "set_page") {
        if ($me["role"] !== "admin") {
            out(["ok" => false, "error" => "Réservé à l'administrateur"], 403);
        }

        $pageIndex = (int)($input["page_index"] ?? 0);
        if ($pageIndex < 0) $pageIndex = 0;

        $stmt = $pdo->prepare("
            UPDATE sessions
            SET current_page_index = ?, updated_at = NOW()
            WHERE id = ?
        ");
        $stmt->execute([$pageIndex, $sessionId]);

        $stmt = $pdo->prepare("
            UPDATE members SET last_seen = NOW() WHERE session_id = ? AND client_id = ?
        ");
        $stmt->execute([$sessionId, $clientId]);

        out(["ok" => true]);
    }

    /* ---------------------------------------------------
       TYPING
    --------------------------------------------------- */
    if ($action === "typing") {
        $typing = !empty($input["typing"]) ? 1 : 0;

        $stmt = $pdo->prepare("
            UPDATE members SET is_typing = ?, last_seen = NOW()
            WHERE session_id = ? AND client_id = ?
        ");
        $stmt->execute([$typing, $sessionId, $clientId]);

        out(["ok" => true]);
    }

    /* ---------------------------------------------------
       REQUEST_EDIT
    --------------------------------------------------- */
    if ($action === "request_edit") {
        $stmt = $pdo->prepare("
            UPDATE members SET requested_edit = 1, last_seen = NOW()
            WHERE session_id = ? AND client_id = ?
        ");
        $stmt->execute([$sessionId, $clientId]);

        out(["ok" => true]);
    }

    /* ---------------------------------------------------
       SET_EDIT
    --------------------------------------------------- */
    if ($action === "set_edit") {
        if ($me["role"] !== "admin") {
            out(["ok" => false, "error" => "Réservé à l'administrateur"], 403);
        }

        $mode            = $input["mode"] ?? "none";
        $allowedEditorId = $input["allowed_editor_id"] ?? null;

        if (!in_array($mode, ["none", "all", "user"], true)) {
            $mode = "none";
        }
        if ($mode !== "user") {
            $allowedEditorId = null;
        }

        $stmt = $pdo->prepare("
            UPDATE sessions
            SET edit_mode = ?, allowed_editor_id = ?, updated_at = NOW()
            WHERE id = ?
        ");
        $stmt->execute([$mode, $allowedEditorId, $sessionId]);

        if ($mode === "user" && $allowedEditorId) {
            $stmt = $pdo->prepare("
                UPDATE members SET requested_edit = 0
                WHERE session_id = ? AND client_id = ?
            ");
            $stmt->execute([$sessionId, $allowedEditorId]);
        }

        if ($mode === "all") {
            $stmt = $pdo->prepare("
                UPDATE members SET requested_edit = 0 WHERE session_id = ?
            ");
            $stmt->execute([$sessionId]);
        }

        out(["ok" => true]);
    }

    /* ---------------------------------------------------
       LEAVE
    --------------------------------------------------- */
    if ($action === "leave") {
        $wasAdmin = $me && $me["role"] === "admin";

        $stmt = $pdo->prepare("
            DELETE FROM members WHERE session_id = ? AND client_id = ?
        ");
        $stmt->execute([$sessionId, $clientId]);

        if ($wasAdmin) {
            $stmt = $pdo->prepare("
                SELECT client_id FROM members
                WHERE session_id = ?
                ORDER BY joined_at ASC
                LIMIT 1
            ");
            $stmt->execute([$sessionId]);
            $next = $stmt->fetch();

            if ($next) {
                $newAdminId = $next["client_id"];
                $stmt = $pdo->prepare("
                    UPDATE members SET role = 'admin'
                    WHERE session_id = ? AND client_id = ?
                ");
                $stmt->execute([$sessionId, $newAdminId]);

                $stmt = $pdo->prepare("
                    UPDATE sessions
                    SET admin_client_id = ?, edit_mode = 'none', allowed_editor_id = NULL
                    WHERE id = ?
                ");
                $stmt->execute([$newAdminId, $sessionId]);
            } else {
                $stmt = $pdo->prepare("
                    UPDATE sessions
                    SET admin_client_id = NULL, edit_mode = 'none', allowed_editor_id = NULL
                    WHERE id = ?
                ");
                $stmt->execute([$sessionId]);
            }
        }

        out(["ok" => true]);
    }
	
	/* ---------------------------------------------------
   SEND_CHAT
--------------------------------------------------- */
if ($action === "send_chat") {
    $text = trim((string)($input["text"] ?? ""));
    if ($text === "") {
        out(["ok" => false, "error" => "Message vide"], 400);
    }

    // 1. Purge globale des messages > 2h
    $pdo->exec("DELETE FROM group_messages WHERE created_at < NOW() - INTERVAL 2 HOUR");

    // 2. Insert du nouveau message
    $stmt = $pdo->prepare("
        INSERT INTO group_messages (session_id, pseudo, text)
        VALUES (?, ?, ?)
    ");
    $stmt->execute([$sessionId, $me["pseudo"], $text]);

    // 3. Garder seulement les 20 derniers pour cette session
    $stmt = $pdo->prepare("
        SELECT id FROM group_messages
        WHERE session_id = ?
        ORDER BY id DESC
        LIMIT 20, 1000
    ");
    $stmt->execute([$sessionId]);
    $toDelete = $stmt->fetchAll(PDO::FETCH_COLUMN);

    if (!empty($toDelete)) {
        $placeholders = implode(",", array_fill(0, count($toDelete), "?"));
        $stmt = $pdo->prepare("DELETE FROM group_messages WHERE id IN ($placeholders)");
        $stmt->execute($toDelete);
    }

    out(["ok" => true]);
}
/* ---------------------------------------------------
   GET_CHAT  (appelé en interne par poll)
--------------------------------------------------- */
if ($action === "get_chat") {
    $stmt = $pdo->prepare("
        SELECT pseudo, text, created_at
        FROM group_messages
        WHERE session_id = ?
        ORDER BY id ASC
    ");
    $stmt->execute([$sessionId]);
    out(["ok" => true, "messages" => $stmt->fetchAll(PDO::FETCH_ASSOC)]);
}

    out(["ok" => false, "error" => "Action inconnue"], 400);

} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }

    out([
        "ok"    => false,
        "error" => $e->getMessage()
    ], 500);
}
