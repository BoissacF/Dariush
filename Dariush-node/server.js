const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require("mysql2/promise");
const linuxLimiter = require("./linuxLimiter");
// Nettoyage des comptes Linux inactifs : si le fichier manque sur le VPS, le
// serveur démarre quand même, simplement sans nettoyage.
let linuxNettoyage = null;
try {
  linuxNettoyage = require("./linuxNettoyage");
} catch (err) {
  console.warn("[linux-nettoyage] Module non chargé, nettoyage désactivé :", err.message);
}
// Administrateur de classe Linux : facultatif lui aussi
let linuxAdmin = null;
try {
  linuxAdmin = require("./linuxAdmin");
} catch (err) {
  console.warn("[linux-admin] Module non chargé, pas d'administrateur de classe :", err.message);
}
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    // LOCAL
      //origin: "http://localhost",
    // PRODUCTION
     //origin: "https://physalgo.fr",
	 
	 // LOCAL ET PRODUCTION
	 origin: ["https://physalgo.fr", "http://localhost"],
    methods: ["GET", "POST"]
  }
});

linuxLimiter.init(io);
if (linuxNettoyage) linuxNettoyage.init();




/* ================================
   IDENTIFIANTS — lus dans .env
   Fichier .env place a cote de server.js, jamais versionne.
   Format :  CLE=valeur   (# = commentaire)
================================ */
const env = (() => {
  const valeurs = {};
  try {
    const brut = require("fs").readFileSync(
      require("path").join(__dirname, ".env"), "utf8"
    );
    for (const ligne of brut.split(/\r?\n/)) {
      const l = ligne.trim();
      if (!l || l.startsWith("#")) continue;
      const i = l.indexOf("=");
      if (i === -1) continue;
      let v = l.slice(i + 1).trim();
      if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) ||
                            (v[0] === "'" && v.endsWith("'")))) {
        v = v.slice(1, -1);
      }
      valeurs[l.slice(0, i).trim()] = v;
    }
  } catch (err) {
    console.error("[.env] Fichier introuvable ou illisible :", err.message);
  }
  return valeurs;
})();

const pool = mysql.createPool({
  host:     env.DB_HOST || "localhost",
  user:     env.DB_USER || "dariush",
  password: env.DB_PASS,
  database: env.DB_NAME || "DariushPython",
  waitForConnections: true,
  connectionLimit: 10
});

if (linuxAdmin) linuxAdmin.init({ io, pool });




pool.getConnection()
  .then(conn => { console.log("MySQL local connecté ✅"); conn.release(); })
  .catch(err => { console.error("Erreur MySQL :", err.message, err.code); });

/* ================================
   ÉTAT DES SESSIONS EN MÉMOIRE
================================ */
const sessionState = new Map();

function getSessionState(sessionCode) {
  if (!sessionState.has(sessionCode)) {
    sessionState.set(sessionCode, { frozen: false, pendingSnapshots: 0 });
  }
  return sessionState.get(sessionCode);
}

/* ================================
   UTILITAIRES BDD — GROUPE
================================ */
async function getSessionByCode(code) {
  const [rows] = await pool.query(
    "SELECT * FROM sessions WHERE session_code = ?", [code]
  );
  return rows[0] || null;
}

async function ensureSession(code) {
  let session = await getSessionByCode(code);
  if (!session) {
    await pool.query(
      "INSERT INTO sessions (session_code, current_text, edit_mode, allowed_editor_id, admin_client_id, current_page_index) VALUES (?, '', 'none', NULL, NULL, 0)",
      [code]
    );
    session = await getSessionByCode(code);
  }
  return session;
}

async function getMembers(sessionId) {
  const [rows] = await pool.query(
    "SELECT client_id, pseudo, role, is_typing, requested_edit FROM members WHERE session_id = ? ORDER BY joined_at ASC",
    [sessionId]
  );
  return rows;
}

async function getRequests(sessionId) {
  const [rows] = await pool.query(
    "SELECT client_id, pseudo FROM members WHERE session_id = ? AND requested_edit = 1 ORDER BY joined_at ASC",
    [sessionId]
  );
  return rows;
}

async function cleanOldMembers(sessionId) {
  await pool.query(
    "DELETE FROM members WHERE session_id = ? AND last_seen < (NOW() - INTERVAL 45 SECOND)",
    [sessionId]
  );
}

async function getChatMessages(sessionId) {
  const [rows] = await pool.query(
    "SELECT pseudo, text, created_at FROM group_messages WHERE session_id = ? ORDER BY id ASC",
    [sessionId]
  );
  return rows;
}

async function clearSnapshot(sessionId) {
  await pool.query(
    "UPDATE sessions SET notebook_snapshot = NULL, snapshot_expires_at = NULL, snapshot_requested = 0 WHERE id = ?",
    [sessionId]
  );
}

async function broadcastMembers(sessionCode, sessionId) {
  const members  = await getMembers(sessionId);
  const requests = await getRequests(sessionId);
  io.to(sessionCode).emit("members_update", { members, requests });
}

async function broadcastChat(sessionCode, sessionId) {
  const messages = await getChatMessages(sessionId);
  io.to(sessionCode).emit("chat_update", { messages });
}

/* ================================
   GESTION FREEZE / UNFREEZE
================================ */
function freezeSession(sessionCode) {
  const state = getSessionState(sessionCode);
  state.frozen = true;
  io.to(sessionCode).emit("freeze", { message: "Synchronisation en cours…" });
  console.log(`[freeze] session ${sessionCode}`);
}

function unfreezeSession(sessionCode) {
  const state = getSessionState(sessionCode);
  state.frozen = false;
  state.pendingSnapshots = 0;
  io.to(sessionCode).emit("unfreeze");
  console.log(`[unfreeze] session ${sessionCode}`);
}

/* ================================
   WEBSOCKET — GROUPE
================================ */
io.on("connection", (socket) => {
  console.log("Client connecté :", socket.id);

  /* ----------------------------
     JOIN
  ---------------------------- */
  socket.on("join", async (data) => {
    const { session_code, client_id, pseudo, requested_role } = data;

    if (!session_code || !client_id || !pseudo) {
      socket.emit("join_result", { ok: false, error: "Données incomplètes" });
      return;
    }

    try {
      const session   = await ensureSession(session_code);
      const sessionId = session.id;

      await cleanOldMembers(sessionId);

      const freshSession = await getSessionByCode(session_code);

      const [existingAdmins] = await pool.query(
        "SELECT client_id FROM members WHERE session_id = ? AND role = 'admin'",
        [sessionId]
      );
      const wasAdminPresent = existingAdmins.length > 0;

      let finalRole = "student";
      const [existing] = await pool.query(
        "SELECT * FROM members WHERE session_id = ? AND client_id = ? LIMIT 1",
        [sessionId, client_id]
      );

      if (existing.length > 0 && existing[0].role === "admin") {
        finalRole = "admin";
      } else if (requested_role === "teacher" && !freshSession.admin_client_id) {
        finalRole = "admin";
        await pool.query(
          "UPDATE sessions SET admin_client_id = ?, edit_mode = 'none', allowed_editor_id = NULL WHERE id = ?",
          [client_id, sessionId]
        );
      } else if (freshSession.admin_client_id === client_id) {
        finalRole = "admin";
      }

      await pool.query(
        `INSERT INTO members (session_id, client_id, pseudo, role, is_typing, requested_edit, last_seen, joined_at)
         VALUES (?, ?, ?, ?, 0, 0, NOW(), NOW())
         ON DUPLICATE KEY UPDATE pseudo = VALUES(pseudo), role = VALUES(role), last_seen = NOW()`,
        [sessionId, client_id, pseudo, finalRole]
      );

      socket.join(session_code);
      socket.sessionCode = session_code;
      socket.sessionId   = sessionId;
      socket.clientId    = client_id;
      socket.pseudo      = pseudo;
      socket.role        = finalRole;

      const members      = await getMembers(sessionId);
      const requests     = await getRequests(sessionId);
      const adminPresent = members.some(m => m.role === "admin");
      const sessionData  = await getSessionByCode(session_code);

      let snapshot = null;
      if (sessionData.notebook_snapshot && sessionData.snapshot_expires_at) {
        const expires = new Date(sessionData.snapshot_expires_at).getTime();
        if (expires > Date.now()) {
          snapshot = sessionData.notebook_snapshot;
        }
      }

      const currentPageIndex = parseInt(sessionData.current_page_index || 0);

      socket.emit("join_result", {
        ok:            true,
        me_role:       finalRole,
        admin_present: adminPresent,
        members,
        requests,
        state: {
          current_text:       sessionData.current_text || "",
          edit_mode:          sessionData.edit_mode || "none",
          allowed_editor_id:  sessionData.allowed_editor_id || null,
          current_page_index: currentPageIndex,
          snapshot:           null,
          snapshot_requested: false
        }
      });

      await broadcastMembers(session_code, sessionId);
      console.log(`${pseudo} (${finalRole}) a rejoint [${session_code}]`);

      if (finalRole === "student" && adminPresent) {
        const state = getSessionState(session_code);
        state.pendingSnapshots += 1;
        freezeSession(session_code);

        if (snapshot) {
          socket.emit("snapshot_update", { snapshot, page_index: currentPageIndex });
          console.log(`[snapshot] envoyé depuis BDD à ${pseudo} (page ${currentPageIndex})`);
        } else {
          await pool.query(
            "UPDATE sessions SET snapshot_requested = 1 WHERE id = ?",
            [sessionId]
          );
          socket.to(session_code).emit("snapshot_needed");
          console.log(`[snapshot] demandé au prof pour ${pseudo}`);
        }
      }

      if (finalRole === "admin" && !wasAdminPresent) {
        const students = members.filter(
          m => m.role === "student" && m.client_id !== client_id
        );
        if (students.length > 0) {
          const state = getSessionState(session_code);
          state.pendingSnapshots = students.length;
          freezeSession(session_code);
          socket.emit("snapshot_needed");
          console.log(`[snapshot] prof rejoint avec ${students.length} élève(s) → freeze`);
        }
      }

    } catch (err) {
      console.error("join error:", err.message);
      socket.emit("join_result", { ok: false, error: err.message });
    }
  });

  /* ----------------------------
     GROUPE : CURSEUR PARTAGÉ
  ---------------------------- */
  socket.on("group_cursor_show", async (data) => {
    const { line, ch } = data;
    if (!socket.sessionCode) return;

    if (socket.role === "admin") {
      socket.to(socket.sessionCode).emit("group_cursor_update", {
        line, ch, visible: true, role: "admin"
      });
    } else {
      const [session] = await pool.query(
        "SELECT edit_mode, allowed_editor_id FROM sessions WHERE id = ?",
        [socket.sessionId]
      );
      if (!session[0]) return;
      const { edit_mode, allowed_editor_id } = session[0];
      const peutEmettre = edit_mode === "all" ||
                          (edit_mode === "user" && allowed_editor_id === socket.clientId);
      if (!peutEmettre) return;

      const room = io.sockets.adapter.rooms.get(socket.sessionCode);
      if (!room) return;
      for (const socketId of room) {
        const s = io.sockets.sockets.get(socketId);
        if (s && s.role === "admin" && s.sessionCode === socket.sessionCode) {
          s.emit("group_cursor_update", {
            line, ch, visible: true, role: "student",
            pseudo: socket.pseudo, client_id: socket.clientId
          });
        }
      }
    }
  });

  socket.on("group_cursor_hide", async () => {
    if (!socket.sessionCode) return;

    if (socket.role === "admin") {
      socket.to(socket.sessionCode).emit("group_cursor_update", {
        visible: false, role: "admin"
      });
    } else {
      const room = io.sockets.adapter.rooms.get(socket.sessionCode);
      if (!room) return;
      for (const socketId of room) {
        const s = io.sockets.sockets.get(socketId);
        if (s && s.role === "admin" && s.sessionCode === socket.sessionCode) {
          s.emit("group_cursor_update", {
            visible: false, role: "student", client_id: socket.clientId
          });
        }
      }
    }
  });

  /* ----------------------------
     AIDE : CURSEUR PARTAGÉ
  ---------------------------- */
  socket.on("aide_cursor_show", async (data) => {
    const { line, ch } = data;
    if (!socket.aideCode) return;

    if (socket.aideRole === "prof") {
      const [actifs] = await pool.query(
        "SELECT pseudo_eleve FROM members_aide WHERE code_aide = ? AND statut = 'actif' LIMIT 1",
        [socket.aideCode]
      );
      if (actifs.length > 0) {
        notifierEleveAide(socket.aideCode, actifs[0].pseudo_eleve, "aide_cursor_update", {
          line, ch, visible: true, role: "prof"
        });
      }
    } else {
      notifierProfAide(socket.aideCode, "aide_cursor_update", {
        line, ch, visible: true, role: "eleve"
      });
    }
  });

  socket.on("aide_cursor_hide", async () => {
    if (!socket.aideCode) return;

    if (socket.aideRole === "prof") {
      const [actifs] = await pool.query(
        "SELECT pseudo_eleve FROM members_aide WHERE code_aide = ? AND statut = 'actif' LIMIT 1",
        [socket.aideCode]
      );
      if (actifs.length > 0) {
        notifierEleveAide(socket.aideCode, actifs[0].pseudo_eleve, "aide_cursor_update", {
          visible: false, role: "prof"
        });
      }
    } else {
      notifierProfAide(socket.aideCode, "aide_cursor_update", {
        visible: false, role: "eleve"
      });
    }
  });

  /* ----------------------------
     SNAPSHOT_LOADED
  ---------------------------- */
  socket.on("snapshot_loaded", () => {
    if (!socket.sessionCode) return;

    const state = getSessionState(socket.sessionCode);
    state.pendingSnapshots = Math.max(0, state.pendingSnapshots - 1);
    console.log(`[snapshot_loaded] ${socket.pseudo} — restants: ${state.pendingSnapshots}`);

    if (state.pendingSnapshots === 0) {
      unfreezeSession(socket.sessionCode);
    }
  });

  /* ----------------------------
     HEARTBEAT
  ---------------------------- */
  socket.on("heartbeat", async () => {
    if (!socket.sessionId || !socket.clientId) return;
    try {
      await pool.query(
        "UPDATE members SET last_seen = NOW() WHERE session_id = ? AND client_id = ?",
        [socket.sessionId, socket.clientId]
      );
    } catch (err) {
      console.error("heartbeat error:", err.message);
    }
  });

  /* ----------------------------
     PUSH_TEXT
  ---------------------------- */
  socket.on("push_text", async (data) => {
    const { text } = data;
    if (!socket.sessionCode) return;

    const state = getSessionState(socket.sessionCode);
    if (state.frozen) return;

    try {
      await pool.query(
        "UPDATE sessions SET current_text = ?, updated_at = NOW() WHERE id = ?",
        [text, socket.sessionId]
      );
      await clearSnapshot(socket.sessionId);
      socket.to(socket.sessionCode).emit("text_update", { text });
    } catch (err) {
      console.error("push_text error:", err.message);
    }
  });

  /* ----------------------------
     TYPING
  ---------------------------- */
  socket.on("typing", async (data) => {
    const { typing } = data;
    if (!socket.sessionCode) return;

    const state = getSessionState(socket.sessionCode);
    if (state.frozen) return;

    try {
      await pool.query(
        "UPDATE members SET is_typing = ?, last_seen = NOW() WHERE session_id = ? AND client_id = ?",
        [typing ? 1 : 0, socket.sessionId, socket.clientId]
      );
      socket.to(socket.sessionCode).emit("typing_update", {
        client_id: socket.clientId,
        pseudo:    socket.pseudo,
        typing:    !!typing
      });
    } catch (err) {
      console.error("typing error:", err.message);
    }
  });

  /* ----------------------------
     SET_PAGE
  ---------------------------- */
  socket.on("set_page", async (data) => {
    const { page_index } = data;
    if (!socket.sessionCode || socket.role !== "admin") return;

    try {
      await pool.query(
        "UPDATE sessions SET current_page_index = ?, updated_at = NOW() WHERE id = ?",
        [page_index, socket.sessionId]
      );
      await clearSnapshot(socket.sessionId);
      socket.to(socket.sessionCode).emit("page_update", { page_index });
    } catch (err) {
      console.error("set_page error:", err.message);
    }
  });

  /* ----------------------------
     PUSH_SNAPSHOT
  ---------------------------- */
  socket.on("push_snapshot", async (data) => {
    const { snapshot, page_index } = data;
    if (!socket.sessionCode || socket.role !== "admin") return;
    if (!snapshot || snapshot.length > 512000) return;

    const pageIndex = parseInt(page_index ?? 0);

    try {
      await pool.query(
        `UPDATE sessions
         SET notebook_snapshot   = ?,
             snapshot_expires_at = DATE_ADD(NOW(), INTERVAL 1 HOUR),
             snapshot_requested  = 0,
             current_page_index  = ?,
             updated_at          = NOW()
         WHERE id = ?`,
        [snapshot, pageIndex, socket.sessionId]
      );
      io.to(socket.sessionCode).emit("snapshot_update", { snapshot, page_index: pageIndex });
      socket.emit("push_snapshot_result", { ok: true });
      console.log(`[snapshot] broadcast par le prof dans [${socket.sessionCode}] page ${pageIndex}`);
    } catch (err) {
      console.error("push_snapshot error:", err.message);
      socket.emit("push_snapshot_result", { ok: false, error: err.message });
    }
  });

  /* ----------------------------
     REQUEST_EDIT
  ---------------------------- */
  socket.on("request_edit", async () => {
    if (!socket.sessionCode) return;
    try {
      await pool.query(
        "UPDATE members SET requested_edit = 1, last_seen = NOW() WHERE session_id = ? AND client_id = ?",
        [socket.sessionId, socket.clientId]
      );
      const requests = await getRequests(socket.sessionId);
      io.to(socket.sessionCode).emit("requests_update", { requests });
      socket.emit("request_edit_result", { ok: true });
    } catch (err) {
      console.error("request_edit error:", err.message);
    }
  });

  /* ----------------------------
     SET_EDIT
  ---------------------------- */
  socket.on("set_edit", async (data) => {
    if (!socket.sessionCode || socket.role !== "admin") return;

    let { mode, allowed_editor_id } = data;
    if (!["none", "all", "user"].includes(mode)) mode = "none";
    if (mode !== "user") allowed_editor_id = null;

    try {
      await pool.query(
        "UPDATE sessions SET edit_mode = ?, allowed_editor_id = ?, updated_at = NOW() WHERE id = ?",
        [mode, allowed_editor_id, socket.sessionId]
      );
      if (mode === "user" && allowed_editor_id) {
        await pool.query(
          "UPDATE members SET requested_edit = 0 WHERE session_id = ? AND client_id = ?",
          [socket.sessionId, allowed_editor_id]
        );
      }
      if (mode === "all") {
        await pool.query(
          "UPDATE members SET requested_edit = 0 WHERE session_id = ?",
          [socket.sessionId]
        );
      }
      io.to(socket.sessionCode).emit("edit_update", {
        edit_mode:         mode,
        allowed_editor_id: allowed_editor_id || null
      });
      const requests = await getRequests(socket.sessionId);
      io.to(socket.sessionCode).emit("requests_update", { requests });
      socket.emit("set_edit_result", { ok: true });
    } catch (err) {
      console.error("set_edit error:", err.message);
    }
  });

  /* ----------------------------
     SEND_CHAT
  ---------------------------- */
  socket.on("send_chat", async (data) => {
    const { text } = data;
    if (!socket.sessionCode || !text || !text.trim()) return;

    try {
      await pool.query(
        "DELETE FROM group_messages WHERE created_at < NOW() - INTERVAL 2 HOUR"
      );
      await pool.query(
        "INSERT INTO group_messages (session_id, pseudo, text) VALUES (?, ?, ?)",
        [socket.sessionId, socket.pseudo, text.trim()]
      );
      const [toDelete] = await pool.query(
        "SELECT id FROM group_messages WHERE session_id = ? ORDER BY id DESC LIMIT 20, 1000",
        [socket.sessionId]
      );
      if (toDelete.length > 0) {
        const ids = toDelete.map(r => r.id);
        await pool.query(
          `DELETE FROM group_messages WHERE id IN (${ids.map(() => "?").join(",")})`,
          ids
        );
      }
      await broadcastChat(socket.sessionCode, socket.sessionId);
    } catch (err) {
      console.error("send_chat error:", err.message);
    }
  });

  /* ----------------------------
     LEAVE
  ---------------------------- */
  socket.on("leave", async () => {
    socket.emit("leave_result", { ok: true });
    await handleLeave(socket);
  });

  /* ----------------------------
     DECONNEXION BRUTALE
  ---------------------------- */
  socket.on("disconnect", async () => {
    console.log("Client déconnecté :", socket.id, "aideCode=", socket.aideCode, "aideRole=", socket.aideRole);
    await handleLeave(socket);
    if (socket.aideCode) {
      await handleLeaveAide(socket);
    }
    // LINUX — tuer le container si actif
    if (socket.linuxPty) { socket.linuxPty.kill(); socket.linuxPty = null; }
    if (socket.linuxCounted) {
      socket.linuxCounted = false;
      linuxLimiter.decrement();
    }
  });

  /* ============================================================
     AIDE — WEBSOCKET
     Tous les événements aide sont préfixés "aide_"
     Room : "aide_<code_aide>"
  ============================================================ */

  /* ----------------------------
     AIDE : JOIN PROF
  ---------------------------- */
  socket.on("aide_join_prof", async (data) => {
    const { code_aide, pseudo_prof } = data;

    if (!code_aide || !pseudo_prof) {
      socket.emit("aide_join_result", { ok: false, error: "Données incomplètes" });
      return;
    }
    if (code_aide.length < 6) {
      socket.emit("aide_join_result", { ok: false, error: "Le code doit faire au moins 6 caractères." });
      return;
    }

    try {
      const [rows] = await pool.query(
        "SELECT * FROM sessions_aide WHERE code_aide = ? LIMIT 1",
        [code_aide]
      );

      if (rows.length > 0) {
        const session = rows[0];
        if (session.pseudo_prof !== pseudo_prof) {
          socket.emit("aide_join_result", {
            ok: false,
            error: "Ce code d'aide est déjà utilisé par un professeur."
          });
          return;
        }
        await pool.query("DELETE FROM members_aide WHERE code_aide = ?", [code_aide]);
        await pool.query("DELETE FROM events_aide WHERE code_aide = ?",   [code_aide]);
        await pool.query(
          "UPDATE sessions_aide SET last_ping = NOW() WHERE code_aide = ?",
          [code_aide]
        );
      } else {
        await pool.query(
          "INSERT INTO sessions_aide (code_aide, pseudo_prof, created_at, last_ping) VALUES (?, ?, NOW(), NOW())",
          [code_aide, pseudo_prof]
        );
      }

      const roomAide = "aide_" + code_aide;
      socket.join(roomAide);
      socket.aideCode   = code_aide;
      socket.aideRole   = "prof";
      socket.aidePseudo = pseudo_prof;

      const queue = await getAideQueue(code_aide);
      socket.emit("aide_join_result", { ok: true, role: "prof", queue });
      console.log(`[aide] Prof ${pseudo_prof} connecté sur [${code_aide}]`);

    } catch (err) {
      console.error("aide_join_prof error:", err.message);
      socket.emit("aide_join_result", { ok: false, error: err.message });
    }
  });

  /* ----------------------------
     AIDE : JOIN ÉLÈVE
  ---------------------------- */
  socket.on("aide_join_eleve", async (data) => {
    const { code_aide, pseudo_eleve } = data;

    if (!code_aide || !pseudo_eleve) {
      socket.emit("aide_join_result", { ok: false, error: "Données incomplètes" });
      return;
    }

    try {
      const [sessionRows] = await pool.query(
        "SELECT * FROM sessions_aide WHERE code_aide = ? LIMIT 1",
        [code_aide]
      );
      if (sessionRows.length === 0) {
        socket.emit("aide_join_result", {
          ok: false,
          error: "Aucune session d'aide active pour ce code. Vérifiez que votre professeur est connecté."
        });
        return;
      }

      await cleanOldMembresAide(code_aide);

      const [posRows] = await pool.query(
        "SELECT COUNT(*) as nb FROM members_aide WHERE code_aide = ? AND statut IN ('attente','actif')",
        [code_aide]
      );
      const position = (posRows[0].nb || 0) + 1;

      await pool.query(
        `INSERT INTO members_aide (code_aide, pseudo_eleve, position, statut, snapshot, snapshot_expires_at, created_at, last_ping)
         VALUES (?, ?, ?, 'attente', NULL, NULL, NOW(), NOW())
         ON DUPLICATE KEY UPDATE statut = 'attente', last_ping = NOW(), position = VALUES(position)`,
        [code_aide, pseudo_eleve, position]
      );

      const roomAide = "aide_" + code_aide;
      socket.join(roomAide);
      socket.aideCode   = code_aide;
      socket.aideRole   = "eleve";
      socket.aidePseudo = pseudo_eleve;

      const queue = await getAideQueue(code_aide);
      const rang  = queue.findIndex(m => m.pseudo_eleve === pseudo_eleve) + 1;
      const total = queue.length;

      socket.emit("aide_join_result", { ok: true, role: "eleve", rang, total });
      await broadcastAideQueue(code_aide);
      console.log(`[aide] Élève ${pseudo_eleve} en file [${code_aide}] — position ${rang}/${total}`);

    } catch (err) {
      console.error("aide_join_eleve error:", err.message);
      socket.emit("aide_join_result", { ok: false, error: err.message });
    }
  });

  /* ----------------------------
     AIDE : ACTIVER UN ÉLÈVE (prof)
  ---------------------------- */
  socket.on("aide_activer_eleve", async (data) => {
    const { pseudo_eleve } = data;
    if (!socket.aideCode || socket.aideRole !== "prof") return;
    if (!pseudo_eleve) return;

    try {
      const [actifs] = await pool.query(
        "SELECT pseudo_eleve FROM members_aide WHERE code_aide = ? AND statut = 'actif'",
        [socket.aideCode]
      );
      for (const ancien of actifs) {
        if (ancien.pseudo_eleve !== pseudo_eleve) {
          await cloturerMembreAide(socket.aideCode, ancien.pseudo_eleve);
          notifierEleveAide(socket.aideCode, ancien.pseudo_eleve, "aide_session_closed", {
            reason: "Le professeur a sélectionné un autre élève."
          });
        }
      }

      await pool.query(
        "UPDATE members_aide SET statut = 'actif', last_ping = NOW() WHERE code_aide = ? AND pseudo_eleve = ?",
        [socket.aideCode, pseudo_eleve]
      );

      notifierEleveAide(socket.aideCode, pseudo_eleve, "aide_actif_update", {
        message: "Votre professeur est maintenant disponible pour vous aider."
      });

      await broadcastAideQueue(socket.aideCode);
      console.log(`[aide] Élève ${pseudo_eleve} activé par le prof dans [${socket.aideCode}]`);

    } catch (err) {
      console.error("aide_activer_eleve error:", err.message);
    }
  });

  /* ----------------------------
     AIDE : CLÔTURER UN ÉLÈVE (prof)
  ---------------------------- */
  socket.on("aide_cloturer", async (data) => {
    const { pseudo_eleve } = data;
    if (!socket.aideCode || socket.aideRole !== "prof") return;
    if (!pseudo_eleve) return;

    try {
      await cloturerMembreAide(socket.aideCode, pseudo_eleve);
      notifierEleveAide(socket.aideCode, pseudo_eleve, "aide_session_closed", {
        reason: "Le professeur a terminé la session d'aide."
      });
      await broadcastAideQueue(socket.aideCode);
      console.log(`[aide] Élève ${pseudo_eleve} clôturé dans [${socket.aideCode}]`);
    } catch (err) {
      console.error("aide_cloturer error:", err.message);
    }
  });

  /* ----------------------------
     AIDE : SNAPSHOT ÉLÈVE → PROF
  ---------------------------- */
socket.on("aide_push_snapshot", async (data) => {
  const { snapshot, active_page_index, eleve_dans_groupe } = data;
  if (!socket.aideCode || socket.aideRole !== "eleve") return;
  if (!snapshot) return;

  // SÉCURITÉ : on n'accepte le snapshot QUE si cet élève est actuellement
  // l'élève actif de la session. Sinon un élève en file d'attente qui
  // navigue dans son propre notebook polluerait la session du prof.
  try {
    const [actifs] = await pool.query(
      "SELECT pseudo_eleve FROM members_aide WHERE code_aide = ? AND statut = 'actif' LIMIT 1",
      [socket.aideCode]
    );
    if (actifs.length === 0 || actifs[0].pseudo_eleve !== socket.aidePseudo) {
      console.log(`[aide_push_snapshot] ignoré : ${socket.aidePseudo} n'est pas l'élève actif`);
      return;
    }
  } catch (err) {
    console.error("aide_push_snapshot check actif error:", err.message);
    return;
  }

  const pageIndex = parseInt(active_page_index ?? 0);

  try {
    await pool.query(
      "UPDATE members_aide SET snapshot = ?, snapshot_expires_at = NULL, last_ping = NOW() WHERE code_aide = ? AND pseudo_eleve = ?",
      [snapshot, socket.aideCode, socket.aidePseudo]
    );

    notifierProfAide(socket.aideCode, "aide_snapshot_received", {
      pseudo_eleve:      socket.aidePseudo,
      snapshot,
      active_page_index: pageIndex,
      eleve_dans_groupe: !!eleve_dans_groupe
    });

    await pool.query(
      "UPDATE members_aide SET snapshot = NULL WHERE code_aide = ? AND pseudo_eleve = ?",
      [socket.aideCode, socket.aidePseudo]
    );

    console.log(`[aide] Snapshot reçu de ${socket.aidePseudo} → prof [${socket.aideCode}] page ${pageIndex}`);

  } catch (err) {
    console.error("aide_push_snapshot error:", err.message);
  }
});

  /* ----------------------------
     AIDE : ÉCHANGE DE CODE EN TEMPS RÉEL
  ---------------------------- */
  socket.on("aide_send_code", async (data) => {
    const { contenu } = data;
    if (!socket.aideCode) return;
    if (contenu === undefined || contenu === null) return;

    const auteur = socket.aideRole === "prof" ? "prof" : "eleve";

    try {
      await pool.query(
        "INSERT INTO events_aide (code_aide, pseudo_eleve, type, contenu, auteur, created_at) VALUES (?, ?, 'code', ?, ?, NOW())",
        [socket.aideCode, socket.aidePseudo, contenu, auteur]
      );

      await pool.query(
        "DELETE FROM events_aide WHERE code_aide = ? AND created_at < NOW() - INTERVAL 2 HOUR",
        [socket.aideCode]
      );

      if (auteur === "eleve") {
        notifierProfAide(socket.aideCode, "aide_code_update", {
          contenu,
          auteur: "eleve",
          pseudo_eleve: socket.aidePseudo
        });
      } else {
        const [actifs] = await pool.query(
          "SELECT pseudo_eleve FROM members_aide WHERE code_aide = ? AND statut = 'actif' LIMIT 1",
          [socket.aideCode]
        );
        if (actifs.length > 0) {
          notifierEleveAide(socket.aideCode, actifs[0].pseudo_eleve, "aide_code_update", {
            contenu,
            auteur: "prof"
          });
        }
      }

    } catch (err) {
      console.error("aide_send_code error:", err.message);
    }
  });

  /* ----------------------------
     AIDE : CHANGEMENT DE PAGE (prof → élève)
  ---------------------------- */
  socket.on("aide_set_page", async (data) => {
    const { page_index } = data;
    if (!socket.aideCode || socket.aideRole !== "prof") return;

    try {
      const [actifs] = await pool.query(
        "SELECT pseudo_eleve FROM members_aide WHERE code_aide = ? AND statut = 'actif' LIMIT 1",
        [socket.aideCode]
      );
      if (actifs.length > 0) {
        notifierEleveAide(socket.aideCode, actifs[0].pseudo_eleve, "aide_page_update", {
          page_index
        });
        console.log(`[aide] Prof → page ${page_index} → élève ${actifs[0].pseudo_eleve}`);
      }
    } catch (err) {
      console.error("aide_set_page error:", err.message);
    }
  });

  /* ----------------------------
     AIDE : CHAT
  ---------------------------- */
  socket.on("aide_send_chat", async (data) => {
    const { text } = data;
    if (!socket.aideCode || !text || !text.trim()) return;

    try {
      await pool.query(
        "DELETE FROM messages_aide WHERE code_aide = ? AND created_at < NOW() - INTERVAL 2 HOUR",
        [socket.aideCode]
      );
      await pool.query(
        "INSERT INTO messages_aide (code_aide, pseudo, text, created_at) VALUES (?, ?, ?, NOW())",
        [socket.aideCode, socket.aidePseudo, text.trim()]
      );
      const [toDelete] = await pool.query(
        "SELECT id FROM messages_aide WHERE code_aide = ? ORDER BY id DESC LIMIT 20, 1000",
        [socket.aideCode]
      );
      if (toDelete.length > 0) {
        const ids = toDelete.map(r => r.id);
        await pool.query(
          `DELETE FROM messages_aide WHERE id IN (${ids.map(() => "?").join(",")})`,
          ids
        );
      }
      await broadcastAideChat(socket.aideCode);
    } catch (err) {
      console.error("aide_send_chat error:", err.message);
    }
  });

  /* ----------------------------
     AIDE : HEARTBEAT
  ---------------------------- */
  socket.on("aide_heartbeat", async () => {
    if (!socket.aideCode) return;
    try {
      if (socket.aideRole === "prof") {
        await pool.query(
          "UPDATE sessions_aide SET last_ping = NOW() WHERE code_aide = ?",
          [socket.aideCode]
        );
      } else {
        await pool.query(
          "UPDATE members_aide SET last_ping = NOW() WHERE code_aide = ? AND pseudo_eleve = ?",
          [socket.aideCode, socket.aidePseudo]
        );
      }
    } catch (err) {
      console.error("aide_heartbeat error:", err.message);
    }
  });

  /* ----------------------------
     AIDE : LEAVE EXPLICITE
  ---------------------------- */
  socket.on("aide_leave", async () => {
    await handleLeaveAide(socket);
  });

  /* ----------------------------
     SIGNALISATION WebRTC
  ---------------------------- */
  socket.on("webrtc_offer", (data) => {
    if (!data?.targetId) return;
    io.to(data.targetId).emit("webrtc_offer", data);
  });

  socket.on("webrtc_answer", (data) => {
    if (!data?.targetId) return;
    io.to(data.targetId).emit("webrtc_answer", data);
  });

  socket.on("webrtc_ice", (data) => {
    if (!data?.targetId) return;
    io.to(data.targetId).emit("webrtc_ice", data);
  });

  socket.on("audio_speaking", (data) => {
    if (!socket.sessionCode && !socket.aideCode) return;

    if (socket.sessionCode) {
      io.to(socket.sessionCode).emit("audio_speaking_update", {
        speaking: data.speaking,
        role:     data.role
      });
    } else if (socket.aideCode) {
      const roomAide = "aide_" + socket.aideCode;
      io.to(roomAide).emit("audio_speaking_update_aide", {
        speaking: data.speaking,
        role:     data.role
      });
    }
  });

  socket.on("audio_speaking_aide", (data) => {
    if (!socket.aideCode) return;
    const roomAide = "aide_" + socket.aideCode;
    io.to(roomAide).emit("audio_speaking_update_aide", {
      speaking: data.speaking,
      role:     data.role
    });
  });

  socket.on("audio_get_eleve_socket_id", (data) => {
    if (!socket.sessionCode || socket.role !== "admin") return;
    const { clientId } = data;
    const room = io.sockets.adapter.rooms.get(socket.sessionCode);
    if (!room) return;

    for (const socketId of room) {
      const s = io.sockets.sockets.get(socketId);
      if (s && s.clientId === clientId) {
        socket.emit("audio_eleve_socket_id", { eleveSocketId: socketId });
        return;
      }
    }
  });

  socket.on("audio_session_start", (data) => {
    if (!socket.sessionCode || socket.role !== "admin") return;
    const { eleveSocketId } = data;
    io.to(eleveSocketId).emit("audio_session_start", {
      profSocketId: socket.id
    });
  });

  socket.on("audio_session_stop", (data) => {
    if (!socket.sessionCode || socket.role !== "admin") return;
    const { eleveSocketId } = data;
    if (eleveSocketId) {
      io.to(eleveSocketId).emit("audio_session_stop");
    }
  });

  socket.on("audio_request_peers", () => {
    if (!socket.sessionCode) return;
    const room = io.sockets.adapter.rooms.get(socket.sessionCode);
    if (!room) return;

    const peerIds = [];
    for (const socketId of room) {
      if (socketId === socket.id) continue;
      peerIds.push(socketId);
    }
    socket.emit("audio_peers_list", { peerIds });
  });

  socket.on("webrtc_offer_extra", (data) => {
    if (!data?.targetId) return;
    io.to(data.targetId).emit("webrtc_offer_extra", data);
  });

  socket.on("webrtc_answer_extra", (data) => {
    if (!data?.targetId) return;
    io.to(data.targetId).emit("webrtc_answer_extra", data);
  });

  socket.on("webrtc_ice_extra", (data) => {
    if (!data?.targetId) return;
    io.to(data.targetId).emit("webrtc_ice_extra", data);
  });

  socket.on("webrtc_offer_aide", (data) => {
    if (!data?.targetId) return;
    io.to(data.targetId).emit("webrtc_offer_aide", data);
  });

  socket.on("webrtc_answer_aide", (data) => {
    if (!data?.targetId) return;
    io.to(data.targetId).emit("webrtc_answer_aide", data);
  });

  socket.on("webrtc_ice_aide", (data) => {
    if (!data?.targetId) return;
    io.to(data.targetId).emit("webrtc_ice_aide", data);
  });

  socket.on("aide_audio_request_prof_id", () => {
    if (!socket.aideCode) return;

    const roomAide = "aide_" + socket.aideCode;
    const room = io.sockets.adapter.rooms.get(roomAide);
    if (!room) return;

    for (const socketId of room) {
      const s = io.sockets.sockets.get(socketId);
      if (s && s.aideRole === "prof" && s.aideCode === socket.aideCode) {
        socket.emit("aide_audio_prof_id", { profSocketId: socketId });
        s.emit("aide_audio_eleve_id", { eleveSocketId: socket.id });
        return;
      }
    }
  });

  socket.on("aide_audio_session_start", (data) => {
    if (!socket.aideCode) return;
    io.to(data.eleveSocketId).emit("aide_audio_session_start", {
      profSocketId: socket.id
    });
  });

  /* ════════════════════════════════════════
     LINUX : TERMINAL DOCKER
     linux_connect → lance un container Docker
     linux_input   → envoie les touches au terminal
     linux_resize  → redimensionne le terminal
  ════════════════════════════════════════ */
socket.on("linux_connect", ({ codeClasse, pseudo, motDePasse }) => {
    console.log("[linux_connect] reçu - codeClasse=", codeClasse, "pseudo=", pseudo, "motDePasse=", motDePasse ? motDePasse.length+" car" : "ABSENT");
    try {
	  // ── LIMITEUR : refuser si trop de conteneurs actifs ──
      if (linuxLimiter.isFull()) {
        socket.emit("linux_error", {
          message: linuxLimiter.getCount() + " élèves sont actuellement connectés sur Dariush_Linux. Mon serveur personnel VPS accepte pour l'instant un maximum de " + linuxLimiter.getMax() + " élèves connectés simultanément. Veuillez patienter quelques minutes et réessayer."
        });
        return;
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(codeClasse) || !/^[a-zA-Z0-9_-]+$/.test(pseudo)) {
        socket.emit("linux_error", { message: "Caractères invalides." });
        return;
      }
      console.log("[linux_connect] check 1 OK - validation regex");

      if (typeof motDePasse !== "string" || motDePasse.length < 4 || motDePasse.length > 100) {
        socket.emit("linux_error", { message: "Mot de passe invalide (4 à 100 caractères)." });
        return;
      }
      console.log("[linux_connect] check 2 OK - mot de passe valide");

      const fs     = require("fs");
      const path   = require("path");
      const crypto = require("crypto");

      const baseDir   = "/home/physalgo/htdocs/physalgo.fr/Dariush_Linux/serveur_eleves";
      const classeDir = path.join(baseDir, codeClasse);
      const eleveDir  = path.join(classeDir, pseudo);

      function uidFromString(s) {
        let h = 0;
        for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
        return 10000 + (h % 50000);
      }
      const uid = uidFromString(pseudo);
      const gid = uidFromString(codeClasse);
      console.log("[linux_connect] check 3 OK - uid=", uid, "gid=", gid, "eleveDir=", eleveDir);

      fs.mkdirSync(classeDir, { recursive: true });
      fs.mkdirSync(eleveDir,  { recursive: true });
      console.log("[linux_connect] check 4 OK - dossiers créés");

      fs.chmodSync(classeDir, 0o1777);
      console.log("[linux_connect] check 5 OK - chmod classe");

      require("child_process").execSync(`chown ${uid}:${gid} "${eleveDir}"`);
      fs.chmodSync(eleveDir, 0o755);
      console.log("[linux_connect] check 6 OK - chown/chmod eleveDir");

      const motDePasseFile = path.join(eleveDir, "mot_de_passe.txt");
      const hashMotDePasse = crypto.createHash("sha256").update(motDePasse).digest("hex");
      console.log("[linux_connect] check 7 OK - hash calculé, fichier =", motDePasseFile);

      if (fs.existsSync(motDePasseFile)) {
        console.log("[linux_connect] check 8a - fichier existe, vérif hash");
        let hashStocke;
        try {
          hashStocke = fs.readFileSync(motDePasseFile, "utf8").trim();
        } catch (err) {
          socket.emit("linux_error", { message: "Impossible de lire le mot de passe enregistré." });
          return;
        }
        if (hashStocke !== hashMotDePasse) {
          console.log("[linux_connect] check 8b - hash incorrect");
          socket.emit("linux_error", { message: "Mot de passe incorrect." });
          return;
        }
        console.log("[linux_connect] check 8c - hash OK");
      } else {
        console.log("[linux_connect] check 9a - création fichier mot de passe");
        try {
          fs.writeFileSync(motDePasseFile, hashMotDePasse, "utf8");
          require("child_process").execSync(`chown ${uid}:${gid} "${motDePasseFile}"`);
          fs.chmodSync(motDePasseFile, 0o600);
          console.log("[linux_connect] check 9b - fichier créé OK");
        } catch (err) {
          console.error("[linux_connect] ERREUR création fichier :", err.message);
          socket.emit("linux_error", { message: "Impossible d'enregistrer le mot de passe : " + err.message });
          return;
        }
      }

      // ── RÉPARATION DES PROPRIÉTAIRES ──
      // Une opération sur le VPS peut réattribuer les fichiers des élèves au
      // compte technique du site (uid 1003, visible avec ls -ln) : l'élève
      // n'entre alors plus dans ses propres sous-dossiers. On lui rend, dans
      // son dossier uniquement, les fichiers qui appartiennent à ce compte.
      //   --from=1003 : ses autres fichiers et ceux d'un camarade ne sont pas touchés
      //   -P -h       : aucun lien symbolique n'est suivi
      // Un échec est journalisé mais ne bloque jamais la connexion.
      try {
        require("child_process").execSync(
          `chown -R -P -h --from=1003 ${uid}:${gid} "${eleveDir}"`,
          { timeout: 2000 }
        );
        console.log("[linux_connect] check 9c OK - propriétaires vérifiés");
      } catch (err) {
        console.error("[linux_connect] réparation des propriétaires impossible :", err.message);
      }

      // ── DATE DE DERNIÈRE CONNEXION ──
      // Inscrite sur le dossier de l'élève et lue par linuxNettoyage.js : un
      // compte resté 30 jours sans activité part à la corbeille. Seule la date
      // du dossier change, ni ses droits ni son propriétaire ; un lien
      // symbolique n'est pas suivi. Un échec ne bloque jamais la connexion.
      try {
        const maintenant = new Date();
        fs.lutimesSync(eleveDir, maintenant, maintenant);
        console.log("[linux_connect] check 9d OK - date de connexion inscrite");
      } catch (err) {
        console.error("[linux_connect] date de connexion non inscrite :", err.message);
      }

      console.log("[linux_connect] check 10 - lancement Docker...");

      const ptyProcess = require("node-pty").spawn("docker", [
        "run", "--rm", "-it",
        "--network=none",
        "--memory=64m",
        "--cpus=0.2",
        "--pids-limit=20",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--user", `${uid}:${gid}`,
        "-e", "TERM=xterm-256color",
        "-e", `CODE_CLASSE=${codeClasse}`,
        "-e", `PSEUDO=${pseudo}`,
        "-e", `HOME=/home/${codeClasse}/${pseudo}`,
        "-v", `${classeDir}:/home/${codeClasse}:rw`,
        "-w", `/home/${codeClasse}/${pseudo}`,
        "dariush-linux",
        "bash", "--rcfile", "/etc/bash.bashrc", "-i"
      ], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        env: process.env
      });

      console.log("[linux_connect] check 11 - Docker lancé");

      socket.linuxPty = ptyProcess;
      socket.linuxCounted = true;
      /* Sortie du terminal : envoyée à l'élève et, si une session d'aide Linux
   est active, dupliquée vers le prof (voir le bloc d'aide Linux en bas du
   fichier). Sans ce bloc, seul l'élève reçoit le flux. */
ptyProcess.onData(data => {
  socket.emit("linux_output", data);
  if (typeof notifierProfAideLinuxSiActif === "function") {
    notifierProfAideLinuxSiActif(socket, data);
  }
});


      ptyProcess.onExit(() => {
        socket.linuxPty = null;
        if (socket.linuxCounted) {
          socket.linuxCounted = false;
          linuxLimiter.decrement();
        }
        socket.emit("linux_exit");
      });

      linuxLimiter.increment();
      socket.emit("linux_ready");
      console.log("[linux_connect] check 12 - linux_ready émis");

      // Rôle dans la classe (administrateur ou élève), géré par linuxAdmin.js
      if (linuxAdmin) linuxAdmin.apresConnexion(socket, codeClasse, pseudo, ptyProcess);
    } catch (err) {
      console.error("[linux_connect] EXCEPTION :", err.message, err.stack);
      socket.emit("linux_error", { message: "Impossible de démarrer le terminal." });
    }
  });

  socket.on("linux_input", (data) => {
    if (socket.linuxPty) socket.linuxPty.write(data);
  });

  socket.on("linux_resize", ({ cols, rows }) => {
    if (socket.linuxPty) socket.linuxPty.resize(cols, rows);
  });
  
  socket.on("linux_get_count", () => {
    socket.emit("linux_count_update", {
      count: linuxLimiter.getCount(),
      max: linuxLimiter.getMax(),
	  record: linuxLimiter.getRecord()
    });
  });

}); // fin io.on("connection")

/* ================================
   HANDLE LEAVE — GROUPE
================================ */
async function handleLeave(socket) {
  const sessionCode = socket.sessionCode;
  const sessionId   = socket.sessionId;
  const clientId    = socket.clientId;
  const pseudo      = socket.pseudo;
  const role        = socket.role;

  if (!sessionId || !clientId) {
    console.log("disconnect sans session active, ignoré.");
    return;
  }

  socket.sessionCode = null;
  socket.sessionId   = null;
  socket.clientId    = null;
  socket.pseudo      = null;
  socket.role        = null;

  try {
    await pool.query(
      "DELETE FROM members WHERE session_id = ? AND client_id = ?",
      [sessionId, clientId]
    );

    if (role === "admin") {
      await clearSnapshot(sessionId);
      const state = getSessionState(sessionCode);
      if (state.frozen) unfreezeSession(sessionCode);
      sessionState.delete(sessionCode);
      await pool.query(
        "UPDATE sessions SET admin_client_id = NULL, edit_mode = 'none', allowed_editor_id = NULL WHERE id = ?",
        [sessionId]
      );
    } else {
      const state = getSessionState(sessionCode);
      if (state.frozen && state.pendingSnapshots > 0) {
        state.pendingSnapshots -= 1;
        console.log(`[freeze] élève parti, restants: ${state.pendingSnapshots}`);
        if (state.pendingSnapshots === 0) {
          unfreezeSession(sessionCode);
        }
      }
    }

    await broadcastMembers(sessionCode, sessionId);
    socket.leave(sessionCode);
    console.log(`${pseudo} a quitté [${sessionCode}]`);

  } catch (err) {
    console.error("leave error:", err.message);
  }
}

/* ================================
   HANDLE LEAVE — AIDE
================================ */
async function handleLeaveAide(socket) {
  const codeAide = socket.aideCode;
  const role     = socket.aideRole;
  const pseudo   = socket.aidePseudo;

  if (!codeAide || !role) return;

  socket.aideCode   = null;
  socket.aideRole   = null;
  socket.aidePseudo = null;

  const roomAide = "aide_" + codeAide;

  try {
    if (role === "prof") {
      await pool.query("DELETE FROM events_aide WHERE code_aide = ?",   [codeAide]);
      await pool.query("DELETE FROM messages_aide WHERE code_aide = ?", [codeAide]);
      await pool.query("DELETE FROM members_aide WHERE code_aide = ?",  [codeAide]);
      await pool.query("DELETE FROM sessions_aide WHERE code_aide = ?", [codeAide]);

      io.to(roomAide).emit("aide_prof_disconnected", {
        message: "Votre professeur a mis fin à la session d'aide."
      });
      console.log(`[aide] Prof ${pseudo} a quitté — session [${codeAide}] nettoyée`);

    } else {
      await cloturerMembreAide(codeAide, pseudo);
      await broadcastAideQueue(codeAide);
      console.log(`[aide] Élève ${pseudo} a quitté [${codeAide}]`);
    }

    socket.leave(roomAide);

  } catch (err) {
    console.error("handleLeaveAide error:", err.message);
  }
}

/* ================================
   UTILITAIRES BDD — AIDE
================================ */
async function cleanOldMembresAide(codeAide) {
  await pool.query(
    "DELETE FROM members_aide WHERE code_aide = ? AND last_ping < (NOW() - INTERVAL 30 SECOND)",
    [codeAide]
  );
}

async function getAideQueue(codeAide) {
  const [rows] = await pool.query(
    "SELECT pseudo_eleve, position, statut FROM members_aide WHERE code_aide = ? AND statut IN ('attente','actif') ORDER BY position ASC",
    [codeAide]
  );
  return rows;
}

async function getAideChatMessages(codeAide) {
  const [rows] = await pool.query(
    "SELECT pseudo, text, created_at FROM messages_aide WHERE code_aide = ? ORDER BY id ASC",
    [codeAide]
  );
  return rows;
}

async function cloturerMembreAide(codeAide, pseudoEleve) {
  await pool.query(
    "DELETE FROM events_aide WHERE code_aide = ? AND pseudo_eleve = ?",
    [codeAide, pseudoEleve]
  );
  await pool.query(
    "DELETE FROM messages_aide WHERE code_aide = ? AND pseudo = ?",
    [codeAide, pseudoEleve]
  );
  await pool.query(
    "DELETE FROM members_aide WHERE code_aide = ? AND pseudo_eleve = ?",
    [codeAide, pseudoEleve]
  );
}

async function broadcastAideQueue(codeAide) {
  const queue    = await getAideQueue(codeAide);
  const roomAide = "aide_" + codeAide;
  io.to(roomAide).emit("aide_queue_update", { queue });
}

async function broadcastAideChat(codeAide) {
  const messages = await getAideChatMessages(codeAide);
  const roomAide = "aide_" + codeAide;
  io.to(roomAide).emit("aide_chat_update", { messages });
}

function notifierProfAide(codeAide, event, data) {
  const roomAide = "aide_" + codeAide;
  const room = io.sockets.adapter.rooms.get(roomAide);
  if (!room) return;
  for (const socketId of room) {
    const s = io.sockets.sockets.get(socketId);
    if (s && s.aideRole === "prof" && s.aideCode === codeAide) {
      s.emit(event, data);
    }
  }
}

function notifierEleveAide(codeAide, pseudoEleve, event, data) {
  const roomAide = "aide_" + codeAide;
  const room = io.sockets.adapter.rooms.get(roomAide);
  console.log(`[notifierEleve] room=${roomAide} existe=${!!room} taille=${room?.size}`);
  if (!room) return;
  for (const socketId of room) {
    const s = io.sockets.sockets.get(socketId);
    console.log(`[notifierEleve] socket=${socketId} aideRole=${s?.aideRole} aidePseudo=${s?.aidePseudo} cherche=${pseudoEleve}`);
    if (s && s.aideRole === "eleve" && s.aideCode === codeAide && s.aidePseudo === pseudoEleve) {
      console.log(`[notifierEleve] → envoi ${event} à ${pseudoEleve}`);
      s.emit(event, data);
    }
  }
}

/* ================================
   NETTOYAGE PÉRIODIQUE — GROUPE
   Toutes les 60s
================================ */
setInterval(async () => {
  try {
    const [orphelines] = await pool.query(`
      SELECT s.id, s.session_code
      FROM sessions s
      LEFT JOIN members m ON m.session_id = s.id
        AND m.last_seen > (NOW() - INTERVAL 60 SECOND)
      WHERE m.id IS NULL
    `);

    for (const session of orphelines) {
      const roomName = session.session_code;
      const room = io.sockets.adapter.rooms.get(roomName);
      if (room && room.size > 0) continue;

      await pool.query("DELETE FROM sessions WHERE id = ?", [session.id]);
      console.log(`[cleanup] Session orpheline supprimée : [${session.session_code}]`);
    }
  } catch (err) {
    console.error("[cleanup] Erreur nettoyage sessions :", err.message);
  }
}, 60000);

server.listen(3000, () => {
  console.log("Serveur Node.js Dariush prêt sur http://localhost:3000");
});

/* ================================
   NETTOYAGE PÉRIODIQUE — AIDE
   Toutes les 30s
================================ */
setInterval(async () => {
  try {
    const [sessionsExpirées] = await pool.query(
      "SELECT code_aide FROM sessions_aide WHERE last_ping < (NOW() - INTERVAL 30 SECOND)"
    );

    for (const session of sessionsExpirées) {
      const codeAide = session.code_aide;

      const roomAide = "aide_" + codeAide;
      const room = io.sockets.adapter.rooms.get(roomAide);
      if (room && room.size > 0) continue;

      await pool.query("DELETE FROM events_aide   WHERE code_aide = ?", [codeAide]);
      await pool.query("DELETE FROM messages_aide WHERE code_aide = ?", [codeAide]);
      await pool.query("DELETE FROM members_aide  WHERE code_aide = ?", [codeAide]);
      await pool.query("DELETE FROM sessions_aide WHERE code_aide = ?", [codeAide]);

      console.log(`[cleanup-aide] Session aide orpheline supprimée : [${codeAide}]`);
    }
  } catch (err) {
    console.error("[cleanup-aide] Erreur :", err.message);
  }
}, 30000);



/* ═══════════════════════════════════════════════════════════════════════
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   DÉBUT — SECTION AIDE LINUX — bloc 100% indépendant
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ARCHITECTURE :

   - Calqué sur la section AIDE PYTHON de ce fichier
   - Mêmes tables MySQL, préfixées "_linux" pour isolation totale
   - Mêmes events Socket.IO, préfixés "aide_linux_" pour isolation totale
   - Mêmes fonctions helper, suffixées "Linux" pour isolation totale
   - Room : "aide_linux_<code_aide>"
   - Spécifique Linux : la co-édition se fait sur le PTY de l'élève
     (pas de snapshot notebook ni d'échange de code Python).
     Quand le prof tape dans son faux terminal, on écrit directement
     dans socket.linuxPty de l'élève. Quand l'élève tape, le ptyProcess
     produit une sortie, dupliquée vers le prof par
     notifierProfAideLinuxSiActif().
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ═══════════════════════════════════════════════════════════════════════ */

/* ================================
   ATTACHEMENT DES HANDLERS
   On utilise io.on("connection") séparé pour ne PAS toucher
   au bloc io.on("connection") existant plus haut dans le fichier.
   Socket.IO permet plusieurs listeners "connection" indépendants.
================================ */
io.on("connection", (socket) => {

  /* ----------------------------
     AIDE LINUX : JOIN PROF
  ---------------------------- */
  socket.on("aide_linux_join_prof", async (data) => {
    const { code_aide, pseudo_prof } = data;

    if (!code_aide || !pseudo_prof) {
      socket.emit("aide_linux_join_result", { ok: false, error: "Données incomplètes" });
      return;
    }
    if (code_aide.length < 6) {
      socket.emit("aide_linux_join_result", { ok: false, error: "Le code doit faire au moins 6 caractères." });
      return;
    }

    try {
      const [rows] = await pool.query(
        "SELECT * FROM sessions_aide_linux WHERE code_aide = ? LIMIT 1",
        [code_aide]
      );

      if (rows.length > 0) {
        const session = rows[0];
        if (session.pseudo_prof !== pseudo_prof) {
          socket.emit("aide_linux_join_result", {
            ok: false,
            error: "Ce code d'aide est déjà utilisé par un professeur."
          });
          return;
        }
        await pool.query("DELETE FROM members_aide_linux WHERE code_aide = ?", [code_aide]);
        await pool.query("DELETE FROM events_aide_linux WHERE code_aide = ?",  [code_aide]);
        await pool.query(
          "UPDATE sessions_aide_linux SET last_ping = NOW() WHERE code_aide = ?",
          [code_aide]
        );
      } else {
        await pool.query(
          "INSERT INTO sessions_aide_linux (code_aide, pseudo_prof, created_at, last_ping) VALUES (?, ?, NOW(), NOW())",
          [code_aide, pseudo_prof]
        );
      }

      const roomAide = "aide_linux_" + code_aide;
      socket.join(roomAide);
      socket.aideLinuxCode   = code_aide;
      socket.aideLinuxRole   = "prof";
      socket.aideLinuxPseudo = pseudo_prof;

      const queue = await getAideLinuxQueue(code_aide);
      socket.emit("aide_linux_join_result", { ok: true, role: "prof", queue });
      console.log(`[aide-linux] Prof ${pseudo_prof} connecté sur [${code_aide}]`);

    } catch (err) {
      console.error("aide_linux_join_prof error:", err.message);
      socket.emit("aide_linux_join_result", { ok: false, error: err.message });
    }
  });

  /* ----------------------------
     AIDE LINUX : JOIN ÉLÈVE
  ---------------------------- */
  socket.on("aide_linux_join_eleve", async (data) => {
    const { code_aide, pseudo_eleve } = data;

    if (!code_aide || !pseudo_eleve) {
      socket.emit("aide_linux_join_result", { ok: false, error: "Données incomplètes" });
      return;
    }

    try {
      const [sessionRows] = await pool.query(
        "SELECT * FROM sessions_aide_linux WHERE code_aide = ? LIMIT 1",
        [code_aide]
      );
      if (sessionRows.length === 0) {
        socket.emit("aide_linux_join_result", {
          ok: false,
          error: "Aucune session d'aide active pour ce code. Vérifiez que votre professeur est connecté."
        });
        return;
      }

      await cleanOldMembresAideLinux(code_aide);

      const [posRows] = await pool.query(
        "SELECT COUNT(*) as nb FROM members_aide_linux WHERE code_aide = ? AND statut IN ('attente','actif')",
        [code_aide]
      );
      const position = (posRows[0].nb || 0) + 1;

      await pool.query(
        `INSERT INTO members_aide_linux (code_aide, pseudo_eleve, position, statut, snapshot, snapshot_expires_at, created_at, last_ping)
         VALUES (?, ?, ?, 'attente', NULL, NULL, NOW(), NOW())
         ON DUPLICATE KEY UPDATE statut = 'attente', last_ping = NOW(), position = VALUES(position)`,
        [code_aide, pseudo_eleve, position]
      );

      const roomAide = "aide_linux_" + code_aide;
      socket.join(roomAide);
      socket.aideLinuxCode   = code_aide;
      socket.aideLinuxRole   = "eleve";
      socket.aideLinuxPseudo = pseudo_eleve;

      const queue = await getAideLinuxQueue(code_aide);
      const rang  = queue.findIndex(m => m.pseudo_eleve === pseudo_eleve) + 1;
      const total = queue.length;

      socket.emit("aide_linux_join_result", { ok: true, role: "eleve", rang, total });
      await broadcastAideLinuxQueue(code_aide);
      console.log(`[aide-linux] Élève ${pseudo_eleve} en file [${code_aide}] — position ${rang}/${total}`);

    } catch (err) {
      console.error("aide_linux_join_eleve error:", err.message);
      socket.emit("aide_linux_join_result", { ok: false, error: err.message });
    }
  });

  /* ----------------------------
     AIDE LINUX : ACTIVER UN ÉLÈVE (prof)
  ---------------------------- */
  socket.on("aide_linux_activer_eleve", async (data) => {
    const { pseudo_eleve } = data;
    if (!socket.aideLinuxCode || socket.aideLinuxRole !== "prof") return;
    if (!pseudo_eleve) return;

    try {
      const [actifs] = await pool.query(
        "SELECT pseudo_eleve FROM members_aide_linux WHERE code_aide = ? AND statut = 'actif'",
        [socket.aideLinuxCode]
      );
      for (const ancien of actifs) {
        if (ancien.pseudo_eleve !== pseudo_eleve) {
          await cloturerMembreAideLinux(socket.aideLinuxCode, ancien.pseudo_eleve);
          notifierEleveAideLinux(socket.aideLinuxCode, ancien.pseudo_eleve, "aide_linux_session_closed", {
            reason: "Le professeur a sélectionné un autre élève."
          });
        }
      }

      await pool.query(
        "UPDATE members_aide_linux SET statut = 'actif', last_ping = NOW() WHERE code_aide = ? AND pseudo_eleve = ?",
        [socket.aideLinuxCode, pseudo_eleve]
      );

      notifierEleveAideLinux(socket.aideLinuxCode, pseudo_eleve, "aide_linux_actif_update", {
        message: "Votre professeur est maintenant disponible pour vous aider."
      });

      await broadcastAideLinuxQueue(socket.aideLinuxCode);
      console.log(`[aide-linux] Élève ${pseudo_eleve} activé par le prof dans [${socket.aideLinuxCode}]`);

    } catch (err) {
      console.error("aide_linux_activer_eleve error:", err.message);
    }
  });

  /* ----------------------------
     AIDE LINUX : CLÔTURER UN ÉLÈVE (prof)
  ---------------------------- */
  socket.on("aide_linux_cloturer", async (data) => {
    const { pseudo_eleve } = data;
    if (!socket.aideLinuxCode || socket.aideLinuxRole !== "prof") return;
    if (!pseudo_eleve) return;

    try {
      await cloturerMembreAideLinux(socket.aideLinuxCode, pseudo_eleve);
      notifierEleveAideLinux(socket.aideLinuxCode, pseudo_eleve, "aide_linux_session_closed", {
        reason: "Le professeur a terminé la session d'aide."
      });
      await broadcastAideLinuxQueue(socket.aideLinuxCode);
      console.log(`[aide-linux] Élève ${pseudo_eleve} clôturé dans [${socket.aideLinuxCode}]`);
    } catch (err) {
      console.error("aide_linux_cloturer error:", err.message);
    }
  });


/* ----------------------------
     AIDE LINUX : SNAPSHOT ÉLÈVE → PROF
     Calqué au mot près sur aide_push_snapshot (Python)
  ---------------------------- */
  socket.on("aide_linux_push_snapshot", async (data) => {
    const { snapshot, active_page_index } = data;
    if (!socket.aideLinuxCode || socket.aideLinuxRole !== "eleve") return;
    if (!snapshot) return;

    // SÉCURITÉ : on n'accepte le snapshot QUE si cet élève est actuellement
    // l'élève actif de la session. Sinon un élève en file d'attente qui
    // navigue dans son propre notebook polluerait la session du prof.
    try {
      const [actifs] = await pool.query(
        "SELECT pseudo_eleve FROM members_aide_linux WHERE code_aide = ? AND statut = 'actif' LIMIT 1",
        [socket.aideLinuxCode]
      );
      if (actifs.length === 0 || actifs[0].pseudo_eleve !== socket.aideLinuxPseudo) {
        console.log(`[aide_linux_push_snapshot] ignoré : ${socket.aideLinuxPseudo} n'est pas l'élève actif`);
        return;
      }
    } catch (err) {
      console.error("aide_linux_push_snapshot check actif error:", err.message);
      return;
    }

    const pageIndex = parseInt(active_page_index ?? 0);

    try {
      await pool.query(
        "UPDATE members_aide_linux SET snapshot = ?, snapshot_expires_at = NULL, last_ping = NOW() WHERE code_aide = ? AND pseudo_eleve = ?",
        [snapshot, socket.aideLinuxCode, socket.aideLinuxPseudo]
      );

      notifierProfAideLinux(socket.aideLinuxCode, "aide_linux_snapshot_received", {
        pseudo_eleve:      socket.aideLinuxPseudo,
        snapshot,
        active_page_index: pageIndex
      });

      await pool.query(
        "UPDATE members_aide_linux SET snapshot = NULL WHERE code_aide = ? AND pseudo_eleve = ?",
        [socket.aideLinuxCode, socket.aideLinuxPseudo]
      );

      console.log(`[aide-linux] Snapshot reçu de ${socket.aideLinuxPseudo} → prof [${socket.aideLinuxCode}] page ${pageIndex}`);

    } catch (err) {
      console.error("aide_linux_push_snapshot error:", err.message);
    }
  });

  /* ----------------------------
     AIDE LINUX : CHANGEMENT DE PAGE (prof → élève)
     Calqué au mot près sur aide_set_page (Python)
  ---------------------------- */
  socket.on("aide_linux_set_page", async (data) => {
    const { page_index } = data;
    if (!socket.aideLinuxCode || socket.aideLinuxRole !== "prof") return;

    try {
      const [actifs] = await pool.query(
        "SELECT pseudo_eleve FROM members_aide_linux WHERE code_aide = ? AND statut = 'actif' LIMIT 1",
        [socket.aideLinuxCode]
      );
      if (actifs.length > 0) {
        notifierEleveAideLinux(socket.aideLinuxCode, actifs[0].pseudo_eleve, "aide_linux_page_update", {
          page_index
        });
        console.log(`[aide-linux] Prof → page ${page_index} → élève ${actifs[0].pseudo_eleve}`);
      }
    } catch (err) {
      console.error("aide_linux_set_page error:", err.message);
    }
  });




  /* ----------------------------
     AIDE LINUX : INPUT PROF → PTY DE L'ÉLÈVE
     Le prof tape dans son faux terminal → on écrit directement
     dans le ptyProcess du socket de l'élève actif.
  ---------------------------- */
  socket.on("aide_linux_input", (data) => {
    if (!socket.aideLinuxCode || socket.aideLinuxRole !== "prof") return;
    if (data === undefined || data === null) return;

    const codeAide = socket.aideLinuxCode;
    const roomAide = "aide_linux_" + codeAide;
    const room = io.sockets.adapter.rooms.get(roomAide);
    if (!room) return;

    // Trouver le socket de l'élève actif et écrire dans son PTY
    for (const socketId of room) {
      const s = io.sockets.sockets.get(socketId);
      if (s && s.aideLinuxRole === "eleve" && s.aideLinuxCode === codeAide) {
        if (s.linuxPty) {
          s.linuxPty.write(data);
        }
        return;
      }
    }
  });

  /* ----------------------------
     AIDE LINUX : RESIZE (info pour le prof)
     L'élève pilote la taille du PTY. Le prof reçoit cette info
     pour pouvoir adapter l'affichage de son faux terminal.
  ---------------------------- */
  socket.on("aide_linux_resize_request", () => {
    if (!socket.aideLinuxCode || socket.aideLinuxRole !== "prof") return;

    const codeAide = socket.aideLinuxCode;
    const roomAide = "aide_linux_" + codeAide;
    const room = io.sockets.adapter.rooms.get(roomAide);
    if (!room) return;

    for (const socketId of room) {
      const s = io.sockets.sockets.get(socketId);
      if (s && s.aideLinuxRole === "eleve" && s.aideLinuxCode === codeAide) {
        if (s.linuxPty) {
          socket.emit("aide_linux_resize_info", {
            cols: s.linuxPty.cols,
            rows: s.linuxPty.rows
          });
        }
        return;
      }
    }
  });

  /* ----------------------------
     AIDE LINUX : CURSEUR SOURIS PARTAGÉ
     Bidirectionnel — coordonnées normalisées en pourcentage (0 à 1)
  ---------------------------- */
  socket.on("aide_linux_mouse_move", (data) => {
    if (!socket.aideLinuxCode) return;
    const { xPct, yPct } = data || {};
    if (typeof xPct !== "number" || typeof yPct !== "number") return;

    if (socket.aideLinuxRole === "prof") {
      // Prof → élève actif
      const codeAide = socket.aideLinuxCode;
      const roomAide = "aide_linux_" + codeAide;
      const room = io.sockets.adapter.rooms.get(roomAide);
      if (!room) return;
      for (const socketId of room) {
        const s = io.sockets.sockets.get(socketId);
        if (s && s.aideLinuxRole === "eleve" && s.aideLinuxCode === codeAide) {
          s.emit("aide_linux_mouse_update", { xPct, yPct, role: "prof", visible: true });
          return;
        }
      }
    } else {
      // Élève → prof
      notifierProfAideLinux(socket.aideLinuxCode, "aide_linux_mouse_update", {
        xPct, yPct, role: "eleve", visible: true
      });
    }
  });

  socket.on("aide_linux_mouse_leave", () => {
    if (!socket.aideLinuxCode) return;

    if (socket.aideLinuxRole === "prof") {
      const codeAide = socket.aideLinuxCode;
      const roomAide = "aide_linux_" + codeAide;
      const room = io.sockets.adapter.rooms.get(roomAide);
      if (!room) return;
      for (const socketId of room) {
        const s = io.sockets.sockets.get(socketId);
        if (s && s.aideLinuxRole === "eleve" && s.aideLinuxCode === codeAide) {
          s.emit("aide_linux_mouse_update", { visible: false, role: "prof" });
          return;
        }
      }
    } else {
      notifierProfAideLinux(socket.aideLinuxCode, "aide_linux_mouse_update", {
        visible: false, role: "eleve"
      });
    }
  });

  /* ----------------------------
     AIDE LINUX : CHAT
  ---------------------------- */
  socket.on("aide_linux_send_chat", async (data) => {
    const { text } = data;
    if (!socket.aideLinuxCode || !text || !text.trim()) return;

    try {
      await pool.query(
        "DELETE FROM messages_aide_linux WHERE code_aide = ? AND created_at < NOW() - INTERVAL 2 HOUR",
        [socket.aideLinuxCode]
      );
      await pool.query(
        "INSERT INTO messages_aide_linux (code_aide, pseudo, text, created_at) VALUES (?, ?, ?, NOW())",
        [socket.aideLinuxCode, socket.aideLinuxPseudo, text.trim()]
      );
      const [toDelete] = await pool.query(
        "SELECT id FROM messages_aide_linux WHERE code_aide = ? ORDER BY id DESC LIMIT 20, 1000",
        [socket.aideLinuxCode]
      );
      if (toDelete.length > 0) {
        const ids = toDelete.map(r => r.id);
        await pool.query(
          `DELETE FROM messages_aide_linux WHERE id IN (${ids.map(() => "?").join(",")})`,
          ids
        );
      }
      await broadcastAideLinuxChat(socket.aideLinuxCode);
    } catch (err) {
      console.error("aide_linux_send_chat error:", err.message);
    }
  });

  /* ----------------------------
     AIDE LINUX : HEARTBEAT
  ---------------------------- */
  socket.on("aide_linux_heartbeat", async () => {
    if (!socket.aideLinuxCode) return;
    try {
      if (socket.aideLinuxRole === "prof") {
        await pool.query(
          "UPDATE sessions_aide_linux SET last_ping = NOW() WHERE code_aide = ?",
          [socket.aideLinuxCode]
        );
      } else {
        await pool.query(
          "UPDATE members_aide_linux SET last_ping = NOW() WHERE code_aide = ? AND pseudo_eleve = ?",
          [socket.aideLinuxCode, socket.aideLinuxPseudo]
        );
      }
    } catch (err) {
      console.error("aide_linux_heartbeat error:", err.message);
    }
  });

  /* ----------------------------
     AIDE LINUX : LEAVE EXPLICITE
  ---------------------------- */
  socket.on("aide_linux_leave", async () => {
    await handleLeaveAideLinux(socket);
  });

  /* ----------------------------
     AIDE LINUX : DISCONNECT
     On capte disconnect ici aussi pour nettoyer notre état propre,
     SANS interférer avec le handler "disconnect" du bloc principal.
  ---------------------------- */
  socket.on("disconnect", async () => {
    if (socket.aideLinuxCode) {
      await handleLeaveAideLinux(socket);
    }
  });

  /* ----------------------------
     AIDE LINUX : SIGNALISATION WebRTC AUDIO
     Calqué sur webrtc_*_aide (Python) — suffixe "_linux" pour isolation
  ---------------------------- */
  socket.on("webrtc_offer_aide_linux", (data) => {
    if (!data?.targetId) return;
    io.to(data.targetId).emit("webrtc_offer_aide_linux", data);
  });

  socket.on("webrtc_answer_aide_linux", (data) => {
    if (!data?.targetId) return;
    io.to(data.targetId).emit("webrtc_answer_aide_linux", data);
  });

  socket.on("webrtc_ice_aide_linux", (data) => {
    if (!data?.targetId) return;
    io.to(data.targetId).emit("webrtc_ice_aide_linux", data);
  });

  socket.on("aide_linux_audio_request_prof_id", () => {
    if (!socket.aideLinuxCode) return;

    const roomAide = "aide_linux_" + socket.aideLinuxCode;
    const room = io.sockets.adapter.rooms.get(roomAide);
    if (!room) return;

    for (const socketId of room) {
      const s = io.sockets.sockets.get(socketId);
      if (s && s.aideLinuxRole === "prof" && s.aideLinuxCode === socket.aideLinuxCode) {
        socket.emit("aide_linux_audio_prof_id", { profSocketId: socketId });
        s.emit("aide_linux_audio_eleve_id", { eleveSocketId: socket.id });
        return;
      }
    }
  });

  socket.on("aide_linux_audio_session_start", (data) => {
    if (!socket.aideLinuxCode) return;
    io.to(data.eleveSocketId).emit("aide_linux_audio_session_start", {
      profSocketId: socket.id
    });
  });

}); // fin io.on("connection") — AIDE LINUX

/* ================================
   HANDLE LEAVE — AIDE LINUX
================================ */
async function handleLeaveAideLinux(socket) {
  const codeAide = socket.aideLinuxCode;
  const role     = socket.aideLinuxRole;
  const pseudo   = socket.aideLinuxPseudo;

  if (!codeAide || !role) return;

  socket.aideLinuxCode   = null;
  socket.aideLinuxRole   = null;
  socket.aideLinuxPseudo = null;

  const roomAide = "aide_linux_" + codeAide;

  try {
    if (role === "prof") {
      await pool.query("DELETE FROM events_aide_linux   WHERE code_aide = ?", [codeAide]);
      await pool.query("DELETE FROM messages_aide_linux WHERE code_aide = ?", [codeAide]);
      await pool.query("DELETE FROM members_aide_linux  WHERE code_aide = ?", [codeAide]);
      await pool.query("DELETE FROM sessions_aide_linux WHERE code_aide = ?", [codeAide]);

      io.to(roomAide).emit("aide_linux_prof_disconnected", {
        message: "Votre professeur a mis fin à la session d'aide."
      });
      console.log(`[aide-linux] Prof ${pseudo} a quitté — session [${codeAide}] nettoyée`);

    } else {
      await cloturerMembreAideLinux(codeAide, pseudo);
      await broadcastAideLinuxQueue(codeAide);
      console.log(`[aide-linux] Élève ${pseudo} a quitté [${codeAide}]`);
    }

    socket.leave(roomAide);

  } catch (err) {
    console.error("handleLeaveAideLinux error:", err.message);
  }
}

/* ================================
   UTILITAIRES BDD — AIDE LINUX
================================ */
async function cleanOldMembresAideLinux(codeAide) {
  await pool.query(
    "DELETE FROM members_aide_linux WHERE code_aide = ? AND last_ping < (NOW() - INTERVAL 30 SECOND)",
    [codeAide]
  );
}

async function getAideLinuxQueue(codeAide) {
  const [rows] = await pool.query(
    "SELECT pseudo_eleve, position, statut FROM members_aide_linux WHERE code_aide = ? AND statut IN ('attente','actif') ORDER BY position ASC",
    [codeAide]
  );
  return rows;
}

async function getAideLinuxChatMessages(codeAide) {
  const [rows] = await pool.query(
    "SELECT pseudo, text, created_at FROM messages_aide_linux WHERE code_aide = ? ORDER BY id ASC",
    [codeAide]
  );
  return rows;
}

async function cloturerMembreAideLinux(codeAide, pseudoEleve) {
  await pool.query(
    "DELETE FROM events_aide_linux WHERE code_aide = ? AND pseudo_eleve = ?",
    [codeAide, pseudoEleve]
  );
  await pool.query(
    "DELETE FROM messages_aide_linux WHERE code_aide = ? AND pseudo = ?",
    [codeAide, pseudoEleve]
  );
  await pool.query(
    "DELETE FROM members_aide_linux WHERE code_aide = ? AND pseudo_eleve = ?",
    [codeAide, pseudoEleve]
  );
}

async function broadcastAideLinuxQueue(codeAide) {
  const queue    = await getAideLinuxQueue(codeAide);
  const roomAide = "aide_linux_" + codeAide;
  io.to(roomAide).emit("aide_linux_queue_update", { queue });
}

async function broadcastAideLinuxChat(codeAide) {
  const messages = await getAideLinuxChatMessages(codeAide);
  const roomAide = "aide_linux_" + codeAide;
  io.to(roomAide).emit("aide_linux_chat_update", { messages });
}

function notifierProfAideLinux(codeAide, event, data) {
  const roomAide = "aide_linux_" + codeAide;
  const room = io.sockets.adapter.rooms.get(roomAide);
  if (!room) return;
  for (const socketId of room) {
    const s = io.sockets.sockets.get(socketId);
    if (s && s.aideLinuxRole === "prof" && s.aideLinuxCode === codeAide) {
      s.emit(event, data);
    }
  }
}

function notifierEleveAideLinux(codeAide, pseudoEleve, event, data) {
  const roomAide = "aide_linux_" + codeAide;
  const room = io.sockets.adapter.rooms.get(roomAide);
  if (!room) return;
  for (const socketId of room) {
    const s = io.sockets.sockets.get(socketId);
    if (s && s.aideLinuxRole === "eleve" && s.aideLinuxCode === codeAide && s.aideLinuxPseudo === pseudoEleve) {
      s.emit(event, data);
    }
  }
}

/* ================================
   DUPLICATION DU PTY VERS LE PROF
   Appelée par le handler linux_connect à chaque sortie du terminal.
   Si aucune session d'aide n'est active pour ce socket élève,
   on ne fait rien (no-op).
================================ */
function notifierProfAideLinuxSiActif(socketEleve, data) {
  // L'élève doit être enregistré dans une session d'aide active
  const codeAide = socketEleve.aideLinuxCode;
  if (!codeAide || socketEleve.aideLinuxRole !== "eleve") return;

  const roomAide = "aide_linux_" + codeAide;
  const room = io.sockets.adapter.rooms.get(roomAide);
  if (!room) return;

  // Envoyer la sortie PTY au prof de la session
  for (const socketId of room) {
    const s = io.sockets.sockets.get(socketId);
    if (s && s.aideLinuxRole === "prof" && s.aideLinuxCode === codeAide) {
      s.emit("aide_linux_pty_output", {
        pseudo_eleve: socketEleve.aideLinuxPseudo,
        data
      });
    }
  }
}

/* ================================
   NETTOYAGE PÉRIODIQUE — AIDE LINUX
   Toutes les 30s — identique à aide Python
================================ */
setInterval(async () => {
  try {
    const [sessionsExpirées] = await pool.query(
      "SELECT code_aide FROM sessions_aide_linux WHERE last_ping < (NOW() - INTERVAL 30 SECOND)"
    );

    for (const session of sessionsExpirées) {
      const codeAide = session.code_aide;

      const roomAide = "aide_linux_" + codeAide;
      const room = io.sockets.adapter.rooms.get(roomAide);
      if (room && room.size > 0) continue;

      await pool.query("DELETE FROM events_aide_linux   WHERE code_aide = ?", [codeAide]);
      await pool.query("DELETE FROM messages_aide_linux WHERE code_aide = ?", [codeAide]);
      await pool.query("DELETE FROM members_aide_linux  WHERE code_aide = ?", [codeAide]);
      await pool.query("DELETE FROM sessions_aide_linux WHERE code_aide = ?", [codeAide]);

      console.log(`[cleanup-aide-linux] Session orpheline supprimée : [${codeAide}]`);
    }
  } catch (err) {
    console.error("[cleanup-aide-linux] Erreur :", err.message);
  }
}, 30000);

/* ═══════════════════════════════════════════════════════════════════════
   FIN — SECTION AIDE LINUX
   ═══════════════════════════════════════════════════════════════════════ */