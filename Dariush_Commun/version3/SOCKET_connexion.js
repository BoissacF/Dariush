
if (typeof io === "undefined") {
  console.warn("[groupe] Serveur WebSocket non disponible — fonctionnalités groupe désactivées.");
  throw new Error("io non défini");
}
/* =========================================================

   - connexion à un groupe en admin ou élève (WebSocket)
   - reconnexion automatique
   - dialogue avec le serveur Node (Socket.IO) et l'API PHP + MySQL
   - push_snapshot : prof envoie tout son notebook aux élèves
   - set_page      : prof change de page, élèves suivent

   ========================================================= */

/* ================================
   CONFIG
================================ */
let mode_Local=false;
let API_URL = null;

// LOCAL / PRODUCTION
if (mode_Local==true) {
   API_URL = "http://localhost/Dariush_Commun/group_api.php";
}else {

   API_URL = "https://physalgo.fr/Dariush_Commun/group_api.php";
}


//const API_URL = "http://localhost/Dariush_Commun/group_api.php";

 //version test  :pour tester dans python2
//const API_URL = "https://physalgo.fr/Dariush_Python2/group_api.php";

//const API_URL = "https://physalgo.fr/Dariush_Commun/group_api.php";

const POLL_INTERVAL_MS = 1500;
const HEARTBEAT_INTERVAL_MS = 20000;
const TYPING_TTL_MS = 2500;

const MAX_CONSECUTIVE_ERRORS_BEFORE_RECONNECT = 2;
const RECONNECT_RETRY_MS = 3000;

let groupCursorWidget = null;

let socket=null;
// LOCAL / PRODUCTION
if (mode_Local==true) {
   socket = io("http://localhost:3000", {

  reconnection: false  // on gère nous-mêmes
});
}else {

  
 socket = io("https://dariush-node.physalgo.fr", {
  reconnection: false  // on gère nous-mêmes
});
}

// LOCAL / PRODUCTION
/*const socket = io("http://localhost:3000", {
//const socket = io("https://dariush-node.physalgo.fr", {
  reconnection: false  // on gère nous-mêmes
});
*/
window._dariushSocket = socket;

/* ================================
   CURSEUR PARTAGÉ — GROUPE
================================ */
function attachGroupCursorListener() {
  const ed = getEditor();
  if (!ed) return;
  if (ed.__groupCursorAttached) return;
  ed.__groupCursorAttached = true;

  const wrapper = ed.getWrapperElement();

  wrapper.addEventListener("mousedown", () => {
    if (!joined) return;
    if (!isAdmin && !canCurrentUserEdit()) return;
    setTimeout(() => {
      const cursor = ed.getCursor();
      socket.emit("group_cursor_show", { line: cursor.line, ch: cursor.ch });
      // Afficher localement
      const role = isAdmin ? "admin" : "student";
      onGroupCursorUpdate({ visible: true, line: cursor.line, ch: cursor.ch, role });
    }, 50);
  });

  wrapper.addEventListener("mouseup", () => {
    if (!joined) return;
    if (!isAdmin && !canCurrentUserEdit()) return;
    socket.emit("group_cursor_hide");
    onGroupCursorUpdate({ visible: false });
  });
}

function onGroupCursorUpdate(data) {
  const ed = getEditor();
  if (!ed) return;

  if (groupCursorWidget) {
    groupCursorWidget.remove();
    groupCursorWidget = null;
  }

  if (!data.visible) return;

  const circle = document.createElement("div");
  const color  = data.role === "admin" ? "255, 100, 0" : "0, 100, 255";
  circle.style.cssText = `
    position: absolute;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: rgba(${color}, 0.45);
    border: 2px solid rgba(${color}, 0.8);
    pointer-events: none;
    transform: translate(-50%, -50%);
    margin-left: 5px;
    margin-top: -5px;
    z-index: 999;
  `;
  

  ed.addWidget({ line: data.line, ch: data.ch }, circle, false);
  groupCursorWidget = circle;
}
/* ================================
   OUTILS CodeMirror
================================ */
function waitForPythonEditor(timeoutMs = 6000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (window.pythonEditor && typeof window.pythonEditor.getValue === "function") {
        resolve(window.pythonEditor);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("CodeMirror (window.pythonEditor) n'est pas prêt."));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

function getEditor() {
  return window.pythonEditor || null;
}

function getText() {
  const ed = getEditor();
  if (ed) return ed.getValue();
  const ta = document.getElementById("codeEditor");
  return ta ? ta.value : "";
}

function setText(text) {
  const ed = getEditor();
  if (ed) {
    ed.setValue(text);
    return;
  }
  const ta = document.getElementById("codeEditor");
  if (ta) ta.value = text;
}

function setReadOnly(readOnly) {
  const ed = getEditor();
  if (ed) {
    ed.setOption("readOnly", readOnly ? "nocursor" : false);

    // Ajouter/retirer le listener d'alerte sur le wrapper CodeMirror
    const wrapper = ed.getWrapperElement();
    if (!wrapper) return;
    if (readOnly) {
      if (!wrapper.__studentClickHandler) {
        wrapper.__studentClickHandler = () => {
          if (!joined || isAdmin) return;
          alert("En mode connexion Élève, pour modifier le code cliquez sur le bouton « Demander autorisation de modification » ci-dessous.");
        };
        wrapper.addEventListener("click", wrapper.__studentClickHandler);
      }
    } else {
      if (wrapper.__studentClickHandler) {
        wrapper.removeEventListener("click", wrapper.__studentClickHandler);
        wrapper.__studentClickHandler = null;
      }
    }
    return;
  }
  const ta = document.getElementById("codeEditor");
  if (ta) ta.readOnly = !!readOnly;
}

function getMarkdownTextarea() {
  return document.getElementById("exerciseText");
}

function getMarkdownPreview() {
  return document.getElementById("exercisePreview");
}

function setMarkdownReadOnly(readOnly) {
  const ta = getMarkdownTextarea();
  const preview = getMarkdownPreview();

  if (ta) {
    ta.readOnly = !!readOnly;
    ta.disabled = !!readOnly;
    ta.style.pointerEvents = readOnly ? "none" : "";
    ta.style.opacity = readOnly ? "0.7" : "";
    ta.style.cursor = readOnly ? "not-allowed" : "";
  }

  if (preview) {
    preview.style.pointerEvents = readOnly ? "none" : "";
    preview.style.opacity = readOnly ? "0.85" : "";
    preview.style.cursor = readOnly ? "not-allowed" : "";
    preview.title = readOnly ? "Le markdown est réservé à l'administrateur." : "";
  }
}

function canCurrentUserEditMarkdown() {
  if (!joined) return true;
  return isAdmin;
}

function applyMarkdownPermission() {
  setMarkdownReadOnly(!canCurrentUserEditMarkdown());
}

/* ================================
   BLOCAGE NAVIGATION PAGES (élève)
================================ */

/**
 * Désactive les boutons de navigation entre pages pour l'élève.
 * Le prof contrôle la page à distance via set_page.
 */
function lockPageNavigation() {
  // Barre d'outils haute : tout caché en mode groupe
  const hideTopIds = [
    "pagesPrevButton", "pagesNextButton",
    "pagesMultiplesIndicator",
    "pagesAddButton", "pagesRemoveButton"
  ];
  for (const id of hideTopIds) {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  }

  // Bas de page : forcer le conteneur visible (updateBottomPageNav le cache sinon)
  // On pose un flag global pour bloquer updateBottomPageNav en mode groupe
  window.__groupNavLocked = true;

  const nav = document.getElementById("bottomPageNav");
  if (nav) {
    nav.classList.remove("hidden");
    nav.style.display = "";
  }

  // PREC / SUIV : visibles mais désactivés
  const disableBottomIds = ["bottomPrevPageButton", "bottomNextPageButton"];
  for (const id of disableBottomIds) {
    const btn = document.getElementById(id);
    if (btn) {
      btn.disabled      = true;
      btn.title         = "Navigation réservée au professeur en mode groupe.";
      btn.style.opacity = "0.4";
      btn.style.cursor  = "not-allowed";
    }
  }

  // Indicateur bas de page : visible
  const bottomIndicator = document.getElementById("bottomPageNavIndicator");
  if (bottomIndicator) bottomIndicator.style.display = "";
}

/**
 * Réactive la navigation après déconnexion.
 */
function unlockPageNavigation() {
  // Lever le verrou groupe → updateBottomPageNav reprend son rôle normal
  window.__groupNavLocked = false;

  // Barre haute : ADD et REMOVE réactivés (les flèches sont gérées par pagesmultiples)
  const restoreIds = ["pagesAddButton", "pagesRemoveButton"];
  for (const id of restoreIds) {
    const el = document.getElementById(id);
    if (el) {
      el.style.display = "";
      el.disabled      = false;
      el.style.opacity = "";
      el.style.cursor  = "";
    }
  }

  // Bas de page : rétablir boutons et laisser updateBottomPageNav reprendre le contrôle
  const bottomIds = ["bottomPrevPageButton", "bottomNextPageButton"];
  for (const id of bottomIds) {
    const btn = document.getElementById(id);
    if (btn) {
      btn.disabled      = false;
      btn.title         = "";
      btn.style.opacity = "";
      btn.style.cursor  = "";
    }
  }

  // Remettre le nav dans son état normal (updateBottomPageNav s'en chargera)
  const nav = document.getElementById("bottomPageNav");
  if (nav) nav.style.display = "";
}


// Exposition pour les autres modules (notamment SOCKET_connexion_aide.js)
// qui sont chargés dans un scope séparé.
window.lockPageNavigation   = lockPageNavigation;
window.unlockPageNavigation = unlockPageNavigation;

/* ================================
   HTML
================================ */
const pseudoInput    = document.getElementById("pseudo");
const codeInput      = document.getElementById("code");
const joinBtn        = document.getElementById("join");
const leaveBtn       = document.getElementById("leave");
const statusEl       = document.getElementById("status");
const presenceCountEl= document.getElementById("presenceCount");
const typingInfoEl   = document.getElementById("typingInfo");
const adminPanel     = document.getElementById("adminPanel");
const editSelect     = document.getElementById("editSelect");
const requestEditBtn = document.getElementById("requestEdit");
const editRequestMsgEl = document.getElementById("editRequestMsg");

/* ================================
   OUTILS UI
================================ */
function getSelectedRole() {
  const el = document.querySelector('input[name="role"]:checked');
  return el ? el.value : "student";
}

function selectRole(role) {
  const r = document.querySelector(`input[name="role"][value="${role}"]`);
  if (r) r.checked = true;
}

let statusToastTimer = null;

function showStatusToast(message, kind = "warn", duration = 5000) {
  const text = String(message || "").trim();
  if (!text) return;

  let toast = document.getElementById("statusToast");

  if (!toast) {
    toast = document.createElement("div");
    toast.id = "statusToast";
    toast.className = "status-toast";
    document.body.appendChild(toast);

    toast.addEventListener("click", () => {
      toast.classList.remove("visible", "ok", "warn");
      if (statusToastTimer) {
        clearTimeout(statusToastTimer);
        statusToastTimer = null;
      }
    });
  }

  toast.textContent = text;
  toast.className = `status-toast visible ${kind}`;

  if (statusToastTimer) {
    clearTimeout(statusToastTimer);
  }

  statusToastTimer = setTimeout(() => {
    toast.classList.remove("visible", "ok", "warn");
    statusToastTimer = null;
  }, duration);
}

function setStatus(text, kind = "warn") {
  if (statusEl) {
    statusEl.textContent = text;
    // Appliquer la classe pour la couleur (ok = vert, warn = orange)
    statusEl.className = "group-status-label " + kind;
  }

  if (kind === "warn") {
    showStatusToast(text, kind, 5000);
  }
}

function showAdminRequestMessage(text) {
  if (editRequestMsgEl) {
    editRequestMsgEl.textContent = text;
    editRequestMsgEl.className = "warn";
  } else {
    setStatus(text, "warn");
  }

  showStatusToast(text, "warn", 5000);
}

/* ================================
   IDENTITÉ LOCALE
   sessionStorage = 1 identifiant par onglet
================================ */
function getOrCreateClientId() {
  const key = "dariush_client_id";
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}

const myId = getOrCreateClientId();

/* ================================
   ÉTAT
================================ */
let myName = "";
let sessionCode = "";
let joined = false;

let isAdmin = false;
let studentsCanEdit = false;
let allowedEditorId = null;
let adminPresent = false;

let applyingRemoteUpdate = false;
let lastSentText = "";
let sendTimer = null;

let pollTimer = null;
let heartbeatTimer = null;
let typingStopTimer = null;
let typingActive = false;

let lastEventId = 0;
let lastTypingSentAt = 0;
let lastLocalEditAt = 0;
let lastEditModeChangedAt = 0; // timestamp de la dernière modif de permissions (admin)

let reconnectTimer = null;
let isReconnecting = false;
let manualDisconnect = false;
let consecutiveSyncErrors = 0;
let lastRequestedRole = "student";

// Suivi du snapshot et de la page active côté élève
let lastAppliedSnapshot = null;   // évite de recharger 2× le même snapshot
let lastKnownPageIndex  = -1;     // évite de naviguer si la page n'a pas changé

const remoteTyping = new Map();
const editRequests = new Map();
const typingToastShownFor = new Set();

/* ================================
   API
================================ */
async function api(action, payload = {}) {

  // Actions routées vers WebSocket
  const wsActions = [
    "join", "leave",
    "push_text", "typing", "set_page",
    "push_snapshot", "request_edit", "set_edit",
    "send_chat", "heartbeat"
  ];

  if (wsActions.includes(action)) {
    return new Promise((resolve, reject) => {

      // Fire & forget : pas besoin d'attendre une réponse
      const fireAndForget = [
        "push_text", "typing", "set_page", "heartbeat", "send_chat"
      ];
      if (fireAndForget.includes(action)) {
        socket.emit(action, payload);
        resolve({ ok: true });
        return;
      }

      // Actions avec réponse attendue
      const resultEvent = {
        "join":         "join_result",
        "leave":        "leave_result",
        "push_snapshot":"push_snapshot_result",
        "request_edit": "request_edit_result",
        "set_edit":     "set_edit_result"
      }[action];

      socket.once(resultEvent, (data) => {
        if (!data.ok) reject(new Error(data.error || "Erreur WebSocket"));
        else resolve(data);
      });

      socket.emit(action, {
        session_code: sessionCode,
        client_id:    myId,
        pseudo:       myName,
        ...payload
      });
    });
  }

  // Tout le reste continue en fetch PHP
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({
      action,
      session_code: sessionCode,
      client_id:    myId,
      pseudo:       myName,
      ...payload
    })
  });

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error("Réponse brute du serveur :", raw);
    throw new Error("Réponse JSON invalide du serveur.");
  }

  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Erreur HTTP ${res.status}`);
  }

  return data;
}

// Membres mis à jour
// Membres mis à jour

socket.on("snapshot_needed", () => {
  if (!joined || !isAdmin) return;
  sendSnapshotToStudents();
});


socket.on("members_update", (data) => {
  console.log("members_update reçu :", data);
  if (!joined) return;
  if (Array.isArray(data.members)) {
    updatePresenceUI(data.members);
    buildParticipantOptions(data.members);
  }
  if (Array.isArray(data.requests)) {
    editRequests.clear();
    for (const r of data.requests) {
      editRequests.set(r.client_id, r.pseudo || "Quelqu'un");
    }
    if (isAdmin) renderEditRequests();
  }
});
// Texte mis à jour
socket.on("text_update", (data) => {
  if (!joined) return;
  if (applyingRemoteUpdate) return;
  const serverText     = data.text;
  const recentlyEdited = Date.now() - lastLocalEditAt < 1200;
  if (serverText !== getText() && !recentlyEdited) {
    applyingRemoteUpdate = true;
    if (window.PagesMultiples?.saveActivePageFromEditor && window.PagesMultiples?.getAllPages) {
      window.PagesMultiples.saveActivePageFromEditor();
      const pages     = window.PagesMultiples.getAllPages();
      const activeIdx = window.PagesMultiples.getActivePageIndex?.() ?? 0;
      if (pages && pages[activeIdx]) pages[activeIdx].code = serverText;
    }
    setText(serverText);
    applyingRemoteUpdate = false;
    lastSentText = serverText;
  }
});

// Typing mis à jour
socket.on("typing_update", (data) => {
  if (!joined) return;
  if (data.typing) {
    remoteTyping.set(data.client_id, { name: data.pseudo, ts: Date.now() });
  } else {
    remoteTyping.delete(data.client_id);
  }
});

// Page changée par le prof
socket.on("page_update", (data) => {
  if (!joined || isAdmin) return;
  applyRemotePageIndex(data.page_index);
});

// Snapshot reçu
socket.on("snapshot_update", (data) => {
  if (!joined || isAdmin) return;
  if (data.snapshot) {
    applySnapshot(data.snapshot).then(() => {
      if (typeof data.page_index === "number") {
        applyRemotePageIndex(data.page_index);
      }
    });
  }
});






socket.on("group_cursor_update", (data) => {
  if (!joined) return;
  onGroupCursorUpdate(data);
});

// Permissions d'édition mises à jour
socket.on("edit_update", (data) => {
  if (!joined || isAdmin) return;
  const editModeChangedRecently = Date.now() - lastEditModeChangedAt < 3000;
  if (editModeChangedRecently) return;
  studentsCanEdit = data.edit_mode === "all";
  allowedEditorId = data.edit_mode === "user" ? (data.allowed_editor_id || null) : null;
  applyEditPermission();
  applyMarkdownPermission();
});

// Demandes d'édition mises à jour (prof)
socket.on("requests_update", (data) => {
  if (!joined || !isAdmin) return;
  editRequests.clear();
  if (Array.isArray(data.requests)) {
    for (const r of data.requests) {
      editRequests.set(r.client_id, r.pseudo || "Quelqu'un");
    }
  }
  renderEditRequests();
});

// Chat mis à jour
socket.on("chat_update", (data) => {
  if (!joined) return;
  if (Array.isArray(data.messages)) updateGroupChat(data.messages);
});


// Freeze : session figée pendant chargement snapshot
socket.on("freeze", (data) => {
  isFrozen = true;
  freezeStatusShown = true;
  setStatus(data.message || "Synchronisation en cours…", "warn");
  console.log("[freeze] reçu");
});

// Unfreeze : reprise normale
socket.on("unfreeze", () => {
  isFrozen = false;
  freezeStatusShown = false;
  setStatus(
    isAdmin ? "Connecté ✅ (admin/prof)" : "Connecté ✅ (élève/participant)",
    "ok"
  );
  console.log("[unfreeze] reçu");
});

/* ================================
   PERMISSIONS
================================ */
function canCurrentUserEdit() {
  if (!joined) return false;
  if (!adminPresent && !isAdmin) return false;
  if (isAdmin) return true;
  if (studentsCanEdit) return true;
  if (allowedEditorId && allowedEditorId === myId) return true;
  return false;
}

function applyEditPermission() {
  setReadOnly(!canCurrentUserEdit());
}

function applyServerState(state) {
  if (!state) return;

  studentsCanEdit  = state.edit_mode === "all";
  allowedEditorId  = state.edit_mode === "user" ? (state.allowed_editor_id || null) : null;

  applyEditPermission();
  applyMarkdownPermission();

  if (!isAdmin && !adminPresent) {
    return;
  }

  const serverText     = typeof state.current_text === "string" ? state.current_text : "";
  const localText      = getText();
  const recentlyEdited = Date.now() - lastLocalEditAt < 1200;

  if (serverText !== localText && !recentlyEdited) {
    applyingRemoteUpdate = true;

    // Passer par PagesMultiples pour synchroniser pagesState
    // setText() seul écrase l'éditeur mais pas pagesState.pages[activeIndex]
    // ce qui fait que les autres pages sont perdues à la déconnexion.
    if (window.PagesMultiples?.saveActivePageFromEditor && window.PagesMultiples?.getAllPages) {
      // 1. Sauvegarder d'abord les autres pages
      window.PagesMultiples.saveActivePageFromEditor();
      // 2. Mettre à jour le code de la page active dans pagesState
      const pages = window.PagesMultiples.getAllPages();
      const activeIdx = window.PagesMultiples.getActivePageIndex?.() ?? 0;
      if (pages && pages[activeIdx]) {
        pages[activeIdx].code = serverText;
      }
    }

    setText(serverText);
    applyingRemoteUpdate = false;
    lastSentText = serverText;
  }
}

/* ================================
   SNAPSHOT  (chargement notebook complet)
================================ */

/**
 * Applique le snapshot reçu du serveur côté élève.
 * Utilise window.decode_url() qui est définie dans outils.js
 * et sait charger toutes les pages d'une URL buildLink().
 */
async function applySnapshot(snapshotUrl) {
  if (!snapshotUrl) return;
  if (snapshotUrl === lastAppliedSnapshot) return;

  if (typeof window.decode_url !== "function") {
    console.warn("decode_url non disponible, snapshot ignoré.");
    socket.emit("snapshot_loaded");
    return;
  }

  try {
    const ok = await window.decode_url(snapshotUrl);
    if (ok !== false) {
      lastAppliedSnapshot = snapshotUrl;
      lastKnownPageIndex  = -1;
      setStatus("Fichier du professeur reçu ✅", "ok");

      await new Promise(r => setTimeout(r, 100));
      if (window.MarkdownEditor?.showPreview) {
        await window.MarkdownEditor.showPreview();
      }

      if (window.__groupNavLocked) {
        const navIndicator = document.getElementById("bottomPageNavIndicator");
        if (navIndicator && window.PagesMultiples) {
          const pages = window.PagesMultiples.getAllPages() || [];
          const current = (window.PagesMultiples.getActivePageIndex?.() ?? 0) + 1;
          navIndicator.textContent = current + "/" + (pages.length || 1);
        }
      }
    } else {
      console.warn("decode_url a retourné false.");
    }
  } catch (e) {
    console.error("Erreur snapshot :", e);
  } finally {
    socket.emit("snapshot_loaded");
  }
}

/**
 * Synchronise la page active de l'élève sur celle du prof.
 * N'agit que si la page a changé.
 */
function applyRemotePageIndex(pageIndex) {
  if (typeof pageIndex !== "number") return;
  if (pageIndex === lastKnownPageIndex) return;
  if (!window.PagesMultiples) return;

  const total = (window.PagesMultiples.getAllPages() || []).length;
  if (total === 0) return;

  const safeIndex = Math.max(0, Math.min(pageIndex, total - 1));
  lastKnownPageIndex = safeIndex;

  // Charger la page sans écraser le contenu (saveCurrent: false car l'élève ne peut pas modifier)
  if (typeof window.PagesMultiples.setAllPages !== "function") return;

  const currentIndex = window.PagesMultiples.getActivePageIndex?.() ?? -1;
  if (currentIndex === safeIndex) return;

  // On utilise loadPageIntoEditor si accessible, sinon setAllPages en conservant les pages
  // loadPageIntoEditor n'est pas exposé → on passe par getAllPages + setAllPages
  const pages = window.PagesMultiples.getAllPages();
  if (pages && pages.length > safeIndex) {
    window.PagesMultiples.setAllPages(pages, safeIndex);
  }
}

/* ================================
   ENVOI AUTOMATIQUE DU SNAPSHOT (prof)
   Déclenché quand un élève signale qu'il a besoin du fichier
================================ */

let isSendingSnapshot = false; // évite les envois simultanés
let isFrozen = false;          // session figée pendant chargement snapshot
let freezeStatusShown = false; // évite les doublons de message

async function sendSnapshotToStudents() {
  if (!joined || !isAdmin) return;
  if (isSendingSnapshot) return;
  if (typeof window.buildLink !== "function") return;

  isSendingSnapshot = true;

  try {
    if (window.PagesMultiples?.saveActivePageFromEditor) {
      window.PagesMultiples.saveActivePageFromEditor();
    }

    const snapshotUrl = await window.buildLink({ askDate: false });
    if (!snapshotUrl) return;

    const activePageIndex = window.PagesMultiples?.getActivePageIndex?.() ?? 0;

    await api("push_snapshot", { snapshot: snapshotUrl, page_index: activePageIndex });
    console.log("Snapshot envoyé automatiquement aux élèves.");

  } catch (e) {
    console.warn("push_snapshot automatique :", e);
  } finally {
    isSendingSnapshot = false;
  }
}

// Ces fonctions sont gardées vides pour ne pas casser les appels existants
function ensureSendSnapshotButton() {}
function removeSendSnapshotButton() {}

/* ================================
   UI présence / typing / demandes
================================ */
function updatePresenceUI(members = []) {
  if (!presenceCountEl) return;
  presenceCountEl.textContent = `Connectés : ${members.length}`;
}

function cleanupTypingOld() {
  const now = Date.now();
  for (const [uid, obj] of remoteTyping.entries()) {
    if (now - obj.ts > TYPING_TTL_MS) {
      remoteTyping.delete(uid);
    }
  }
}

function updateTypingUI() {
  if (!typingInfoEl) return;

  cleanupTypingOld();

  const entries = Array.from(remoteTyping.entries());
  const names = entries
    .map(([, v]) => v.name)
    .filter(Boolean);

  if (names.length === 0) {
    typingInfoEl.textContent = "";
    typingToastShownFor.clear();
    return;
  }

  if (names.length === 1) {
    typingInfoEl.textContent = `${names[0]} est en train d'écrire…`;
  } else if (names.length === 2) {
    typingInfoEl.textContent = `${names[0]} et ${names[1]} sont en train d'écrire…`;
  } else {
    typingInfoEl.textContent = `${names[0]} et ${names.length - 1} autres sont en train d'écrire…`;
  }

  for (const [uid, obj] of entries) {
    if (!obj || !obj.name) continue;
    if (typingToastShownFor.has(uid)) continue;

    showStatusToast(`${obj.name} écrit…`, "warn", 4000);
    typingToastShownFor.add(uid);
  }

  const stillTypingIds = new Set(entries.map(([uid]) => uid));
  for (const uid of Array.from(typingToastShownFor)) {
    if (!stillTypingIds.has(uid)) {
      typingToastShownFor.delete(uid);
    }
  }
}

function renderEditRequests() {
  if (!isAdmin) return;

  const names = Array.from(editRequests.values())
    .map(n => (n || "").trim())
    .filter(Boolean);

  if (names.length === 0) {
    if (editRequestMsgEl) {
      editRequestMsgEl.textContent = "";
      editRequestMsgEl.className = "muted";
    }
    return;
  }

  showAdminRequestMessage(`Demandes d'autorisations : ${names.join(", ")}`);
}

function buildParticipantOptions(members = []) {
  if (!editSelect) return;

  const keepValue = editSelect.value || "none";
  editSelect.innerHTML = "";

  const optNone = document.createElement("option");
  optNone.value = "none";
  optNone.textContent = "1 : non";
  editSelect.appendChild(optNone);

  const optAll = document.createElement("option");
  optAll.value = "all";
  optAll.textContent = "2 : tous";
  editSelect.appendChild(optAll);

  const students = members
    .filter(m => m.client_id !== myId && m.role !== "admin")
    .sort((a, b) => (a.pseudo || "").localeCompare(b.pseudo || "", "fr", { sensitivity: "base" }));

  for (const m of students) {
    const opt = document.createElement("option");
    opt.value = m.client_id;
    opt.textContent = m.pseudo || "Participant";
    editSelect.appendChild(opt);
  }

  const has = Array.from(editSelect.options).some(o => o.value === keepValue);
  editSelect.value = has ? keepValue : (
    studentsCanEdit ? "all" : (allowedEditorId || "none")
  );
}

/* ================================
   UI connexion
================================ */
function stopReconnectLoop() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  isReconnecting = false;
}

function setDisconnectedUI() {
  joined           = false;
  isAdmin          = false;
  adminPresent     = false;
  studentsCanEdit  = false;
  allowedEditorId  = null;
  lastEventId      = 0;
  lastSentText     = "";
  typingActive     = false;
  consecutiveSyncErrors = 0;
  lastAppliedSnapshot   = null;
  lastKnownPageIndex    = -1;

 


  clearInterval(pollTimer);
  clearInterval(heartbeatTimer);
  clearTimeout(sendTimer);
  clearTimeout(typingStopTimer);
  stopReconnectLoop();

  pollTimer      = null;
  heartbeatTimer = null;
  sendTimer      = null;
  typingStopTimer= null;

  remoteTyping.clear();
  editRequests.clear();
  
  const chatZone = document.getElementById("groupChatZone");
  if (chatZone) chatZone.style.display = "none";

  if (leaveBtn)         leaveBtn.disabled  = true;
  if (joinBtn)          joinBtn.disabled   = false;
  if (adminPanel)       adminPanel.style.display    = "none";
  if (requestEditBtn)   requestEditBtn.style.display = "none";
  if (presenceCountEl)  presenceCountEl.textContent  = "Connectés : 0";
  if (typingInfoEl)     typingInfoEl.textContent      = "";
  if (editRequestMsgEl) {
    editRequestMsgEl.textContent = "";
    editRequestMsgEl.className   = "muted";
  }
  if (editSelect) editSelect.value = "none";

  if (groupCursorWidget) {
  groupCursorWidget.remove();
  groupCursorWidget = null;
}

  // Rétablir la navigation pages et les droits d'édition
  unlockPageNavigation();
  unlockStudentButtons();
  setReadOnly(false);
  applyMarkdownPermission();
  removeSendSnapshotButton();

  // Afficher le formulaire de login, cacher le bloc statut
  const loginForm = document.getElementById("groupLoginForm");
  const connectedStatus = document.getElementById("groupConnectedStatus");
  if (loginForm) loginForm.style.display = "";
  if (connectedStatus) connectedStatus.style.display = "none";
   if (window.__audioGroupeCleanup) window.__audioGroupeCleanup();
  setStatus("Pas connecté.", "warn");
}

function setConnectedUI() {
  if (leaveBtn) leaveBtn.disabled = false;
  if (joinBtn)  joinBtn.disabled  = true;

  // Cacher le formulaire de login, afficher le bloc statut
  const loginForm = document.getElementById("groupLoginForm");
  const connectedStatus = document.getElementById("groupConnectedStatus");
  if (loginForm) loginForm.style.display = "none";
  if (connectedStatus) connectedStatus.style.display = "";

  // Afficher "Pseudo(CodeSéance)" dans l'identité
  const identityEl = document.getElementById("groupIdentity");
  
  
 
  
  if (identityEl) {
    identityEl.textContent = myName + "(" + sessionCode + ")";
  }

   const chatZone = document.getElementById("groupChatZone");
  if (chatZone) chatZone.style.display = joined ? "" : "none";
  
  
  if (!isAdmin && !adminPresent) {
    if (adminPanel)     adminPanel.style.display    = "none";
    if (requestEditBtn) requestEditBtn.style.display = "none";

    lockPageNavigation();
    setReadOnly(true);
    applyMarkdownPermission();
    attachGroupCursorListener();
    setStatus("En attente de votre administrateur.", "warn");
    return;
  }

  if (adminPanel)     adminPanel.style.display    = isAdmin ? "block" : "none";
  if (requestEditBtn) requestEditBtn.style.display = isAdmin ? "none" : "inline-block";

  if (isAdmin) {
    // Prof : navigation libre, bouton snapshot
    unlockPageNavigation();
    ensureSendSnapshotButton();
    unlockStudentButtons();
  } else {
    // Élève avec admin présent : navigation bloquée
    lockPageNavigation();
    lockStudentButtons();
  }

  applyEditPermission();
  applyMarkdownPermission();
  attachGroupCursorListener();

  setStatus(
    isAdmin ? "Connecté ✅ (admin/prof)" : "Connecté ✅ (élève/participant)",
    "ok"
  );

  if (isAdmin) {
    renderEditRequests();
  }
  audioGroupe_updateUI();
  audioGroupe_initMicPermission();
}

/* ================================
   RECONNEXION AUTO
================================ */
function markSyncFailure(source, error) {
  console.error(`${source}:`, error);

  if (!joined || manualDisconnect) return;

  if (source !== "poll") {
    return;
  }

  consecutiveSyncErrors += 1;

  if (consecutiveSyncErrors >= 3) {
    scheduleReconnect();
  } else {
    setStatus("Problème de synchronisation avec le serveur.", "warn");
  }
}

function markSyncSuccess() {
  consecutiveSyncErrors = 0;
  stopReconnectLoop();
}

async function rejoinSilently() {
  if (!sessionCode || !myName) {
    throw new Error("Informations de reconnexion manquantes.");
  }

  const data = await api("join", {
    requested_role: lastRequestedRole
  });

  joined       = true;
  isAdmin      = data.me_role === "admin";
  adminPresent = !!data.admin_present;

  if (isAdmin) {
    const localText = getText();
    await api("push_text", { text: localText });
    if (data.state) {
      data.state.current_text = localText;
    }
    lastSentText  = localText;
    adminPresent  = true;
  }

  applyPollData(data);
  attachEditorHandlersOnce();
  startBackgroundLoops();
}

function scheduleReconnect() {
  if (isReconnecting || manualDisconnect || !sessionCode || !myName) return;

  isReconnecting = true;
  setStatus("Tentative de reconnexion…", "warn");

  clearInterval(pollTimer);
  clearInterval(heartbeatTimer);
  pollTimer      = null;
  heartbeatTimer = null;

  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    try {
      await rejoinSilently();
      markSyncSuccess();
      setConnectedUI();
      isReconnecting = false;
    } catch (e) {
      console.error("reconnect:", e);
      setStatus("Tentative de reconnexion…", "warn");
      isReconnecting = false;

      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        scheduleReconnect();
      }, RECONNECT_RETRY_MS);
    }
  }, RECONNECT_RETRY_MS);
}

/* ================================
   ÉCOUTE éditeur
================================ */
function sendTypingStart() {
  const now = Date.now();
  if (now - lastTypingSentAt < 700) return;
  lastTypingSentAt = now;

  api("typing", { typing: true }).catch((e) => {
    markSyncFailure("typing start", e);
  });
  typingActive = true;
}

function sendTypingStopSoon() {
  clearTimeout(typingStopTimer);
  typingStopTimer = setTimeout(() => {
    if (!joined || !typingActive) return;
    api("typing", { typing: false }).catch((e) => {
      markSyncFailure("typing stop", e);
    });
    typingActive = false;
  }, 900);
}

function attachEditorHandlersOnce() {
  const ed = getEditor();
  if (!ed) return;
  if (ed.__dariushPollingAttached) return;
  ed.__dariushPollingAttached = true;

  ed.on("change", () => {
    if (!joined) return;
    if (applyingRemoteUpdate) return;

    lastLocalEditAt = Date.now();

    if (canCurrentUserEdit()) {
      sendTypingStart();
      sendTypingStopSoon();
    }

    if (!canCurrentUserEdit()) return;

   clearTimeout(sendTimer);
sendTimer = setTimeout(async () => {
  if (isFrozen) return;
  const text = ed.getValue();
  if (text === lastSentText) return;
  lastSentText = text;

  try {
    await api("push_text", { text });
  } catch (e) {
    markSyncFailure("push_text", e);
  }
}, 300);
  });
}

/* ================================
   SUIVI PAGE ACTIVE (prof → élève)
================================ */

/**
 * Appelé quand le prof change de page localement.
 * Envoie le nouvel index au serveur pour que les élèves suivent.
 */
function notifyPageChange(newIndex) {
  if (!joined || !isAdmin) return;

  api("set_page", { page_index: newIndex }).catch((e) => {
    console.warn("set_page :", e);
  });
}

/**
 * Accroche les boutons de navigation du prof pour notifier le serveur.
 * Appelé une seule fois après la connexion admin.
 */
function attachPageNavHandlersOnce() {
  if (window.__dariushPageNavHooked) return;
  window.__dariushPageNavHooked = true;

  // On observe les changements de page via PagesMultiples si disponible
  // La méthode la plus simple : patcher goToPreviousPage / goToNextPage
  if (!window.PagesMultiples) return;

  const pm = window.PagesMultiples;

  const origPrev = pm.goToPreviousPage;
  const origNext = pm.goToNextPage;

  pm.goToPreviousPage = function () {
    if (origPrev) origPrev.call(pm);
    setTimeout(() => {
      const idx = pm.getActivePageIndex?.() ?? 0;
      notifyPageChange(idx);
    }, 50);
  };

  pm.goToNextPage = function () {
    if (origNext) origNext.call(pm);
    setTimeout(() => {
      const idx = pm.getActivePageIndex?.() ?? 0;
      notifyPageChange(idx);
    }, 50);
  };

  // Aussi pour les boutons bas de page
  const bottomPrev = document.getElementById("bottomPrevPageButton");
  const bottomNext = document.getElementById("bottomNextPageButton");

  if (bottomPrev && !bottomPrev.__groupHooked) {
    bottomPrev.__groupHooked = true;
    bottomPrev.addEventListener("click", () => {
      setTimeout(() => {
        const idx = pm.getActivePageIndex?.() ?? 0;
        notifyPageChange(idx);
      }, 80);
    });
  }

  if (bottomNext && !bottomNext.__groupHooked) {
    bottomNext.__groupHooked = true;
    bottomNext.addEventListener("click", () => {
      setTimeout(() => {
        const idx = pm.getActivePageIndex?.() ?? 0;
        notifyPageChange(idx);
      }, 80);
    });
  }
}

/* ================================
   BLOCAGE BOUTONS ÉLÈVE
================================ */

const STUDENT_BLOCKED_BUTTONS = [
  "btnExercices",
  "openPyButton",
  "newFileButton"
];


// Réapplique l'overlay de blocage du markdown sur le conteneur multi-blocs,
// SI l'élève doit être bloqué (__groupNavLocked) et SI l'overlay réel a disparu
// (typiquement après une régénération des blocs via innerHTML="").
// Appelée par markdown.js après chaque renderMarkdownBlocks.
function reapplyStudentMarkdownLock() {
  if (!window.__groupNavLocked) return; // l'élève n'est pas bloqué : rien à faire

  const mdWrap = document.getElementById("markdownsContainer");
  if (!mdWrap) return;

  // Nettoyer un flag obsolète si l'overlay référencé n'existe plus dans le DOM.
  if (mdWrap.__studentOverlay && !document.contains(mdWrap.__studentOverlay)) {
    mdWrap.__studentOverlay = null;
  }

  // Si un overlay valide est déjà en place, ne rien faire.
  if (mdWrap.__studentOverlay) return;

  const MSG = "Le markdown est réservé à l'administrateur.";
  const overlay = document.createElement("div");
  overlay.style.position = "absolute";
  overlay.style.inset    = "0";
  overlay.style.zIndex   = "9999";
  overlay.style.cursor   = "not-allowed";
  overlay.__isStudentOverlay = true;
  overlay.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    alert(MSG);
  });

  const prevPosition = mdWrap.style.position;
  mdWrap.__prevPosition = prevPosition;
  if (!prevPosition || prevPosition === "static") {
    mdWrap.style.position = "relative";
  }
  mdWrap.appendChild(overlay);
  mdWrap.__studentOverlay = overlay;
}

// Exposer pour que markdown.js (commun) puisse réappliquer le blocage
// après une régénération des blocs.
window.reapplyStudentMarkdownLock = reapplyStudentMarkdownLock;


// IDs des boutons navbar "Enseignant" et "Ouvrir" n'ont pas d'id,
// on les bloque via un overlay invisible sur la top-bar-menu
function lockStudentButtons() {
  
  const MSG = "En mode connecté Élève, ces fonctionnalités sont désactivées.";

  for (const id of STUDENT_BLOCKED_BUTTONS) {
    const btn = document.getElementById(id);
    if (!btn || btn.__studentOverlay) continue;

    const overlay = document.createElement("div");
    overlay.style.position  = "absolute";
    overlay.style.inset     = "0";
    overlay.style.zIndex    = "9999";
    overlay.style.cursor    = "not-allowed";
    overlay.__isStudentOverlay = true;
    overlay.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      alert(MSG);
    });

    const prevPosition = btn.style.position;
    btn.__prevPosition = prevPosition;
    if (!prevPosition || prevPosition === "static") {
      btn.style.position = "relative";
    }
    btn.appendChild(overlay);
    btn.__studentOverlay = overlay;
    btn.style.opacity = "0.45";
    btn.title = MSG;
  }

  // Bloquer boutons Enseignant / Aide / Code/Licence dans la top-bar
  const topBarBtns = document.querySelectorAll("#topBarMenu .nav-item");
  for (const btn of topBarBtns) {
    const txt = (btn.textContent || "").trim();
    if (!["Enseignant", "Aide", "Code/Licence"].includes(txt)) continue;
    if (btn.__studentOverlay) continue;

    const overlay = document.createElement("div");
    overlay.style.position = "absolute";
    overlay.style.inset    = "0";
    overlay.style.zIndex   = "9999";
    overlay.style.cursor   = "not-allowed";
    overlay.__isStudentOverlay = true;
    overlay.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      alert(MSG);
    });

    const prevPosition = btn.style.position;
    btn.__prevPosition = prevPosition;
    if (!prevPosition || prevPosition === "static") {
      btn.style.position = "relative";
    }
    btn.appendChild(overlay);
    btn.__studentOverlay = overlay;
    btn.style.opacity = "0.45";
    btn.title = MSG;
  }

 // Bloquer le markdown via un overlay. Si le système multi-blocs est actif,
  // on cible #markdownsContainer (les vrais blocs). Sinon, l'ancienne zone.
  const mdWrap = (window.MARKDOWNS_MULTIPLES_ACTIFS &&
                  document.getElementById("markdownsContainer"))
    ? document.getElementById("markdownsContainer")
    : document.getElementById("fenetrescommentaires");

 // Si le flag existe mais que l'overlay a été détruit (ex : régénération des
  // blocs via innerHTML), on nettoie le flag obsolète pour pouvoir le reposer.
  if (mdWrap && mdWrap.__studentOverlay && !document.contains(mdWrap.__studentOverlay)) {
    mdWrap.__studentOverlay = null;
  }

  if (mdWrap && !mdWrap.__studentOverlay) {
    const overlay = document.createElement("div");
    overlay.style.position = "absolute";
    overlay.style.inset    = "0";
    overlay.style.zIndex   = "9999";
    overlay.style.cursor   = "not-allowed";
    overlay.__isStudentOverlay = true;
    overlay.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      alert(MSG);
    });

    const prevPosition = mdWrap.style.position;
    mdWrap.__prevPosition = prevPosition;
    if (!prevPosition || prevPosition === "static") {
      mdWrap.style.position = "relative";
    }
    mdWrap.appendChild(overlay);
    mdWrap.__studentOverlay = overlay;
  }
}

function unlockStudentButtons() {
 
  
  for (const id of STUDENT_BLOCKED_BUTTONS) {
    const btn = document.getElementById(id);
    if (!btn || !btn.__studentOverlay) continue;
    btn.__studentOverlay.remove();
    btn.__studentOverlay = null;
    btn.style.opacity = "";
    btn.title = "";
    if (btn.__prevPosition !== undefined) {
      btn.style.position = btn.__prevPosition;
      btn.__prevPosition = undefined;
    }
  }

  const topBarBtns = document.querySelectorAll("#topBarMenu .nav-item");
  for (const btn of topBarBtns) {
    if (!btn.__studentOverlay) continue;
    btn.__studentOverlay.remove();
    btn.__studentOverlay = null;
    btn.style.opacity = "";
    btn.title = "";
    if (btn.__prevPosition !== undefined) {
      btn.style.position = btn.__prevPosition;
      btn.__prevPosition = undefined;
    }
  }

  // Débloquer le markdown : on retire l'overlay sur les DEUX cibles possibles
  // (le conteneur multi-blocs ET l'ancienne zone), pour couvrir tous les cas
  // sans dépendre de l'état du drapeau au moment du déblocage.
  for (const id of ["markdownsContainer", "fenetrescommentaires"]) {
    const mdWrap = document.getElementById(id);
    if (mdWrap && mdWrap.__studentOverlay) {
      mdWrap.__studentOverlay.remove();
      mdWrap.__studentOverlay = null;
      if (mdWrap.__prevPosition !== undefined) {
        mdWrap.style.position = mdWrap.__prevPosition;
        mdWrap.__prevPosition = undefined;
      }
    }
  }
}
/* ================================
   CHAT DE GROUPE
================================ */

async function sendChatMessage() {
  const input = document.getElementById("groupChatInput");
  if (!input) return;
  const text = input.value.trim();
  if (!text || !joined) return;

  input.value = "";
  input.disabled = true;

  try {
    await api("send_chat", { text });
  } catch (e) {
    console.error("send_chat:", e);
  } finally {
    input.disabled = false;
    input.focus();
  }
}

function updateGroupChat(messages) {
  const display = document.getElementById("groupChatDisplay");
  if (!display) return;

  if (!Array.isArray(messages) || messages.length === 0) {
    display.value = "";
    return;
  }

  const lines = messages.map(m => {
    const time = m.created_at ? m.created_at.substring(11, 16) : "";
    return `[${time}] ${m.pseudo} : ${m.text}`;
  });

  const newContent = lines.join("\n");
  if (display.value !== newContent) {
    display.value = newContent;
    // Auto-scroll vers le bas
    display.scrollTop = display.scrollHeight;
  }
}

function initGroupChat() {
  const btn   = document.getElementById("groupChatSendBtn");
  const input = document.getElementById("groupChatInput");

  if (btn) {
    btn.addEventListener("click", sendChatMessage);
  }

  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
      }
    });
  }
}

/* ================================
   POLLING / HEARTBEAT
================================ */
async function heartbeat() {
  if (!joined || isReconnecting) return;

  try {
    await api("heartbeat");
  } catch (e) {
    console.error("heartbeat:", e);
  }
}

async function applyPollData(data) {
  const members  = Array.isArray(data.members)  ? data.members  : [];
  const requests = Array.isArray(data.requests) ? data.requests : [];
  const events   = Array.isArray(data.events)   ? data.events   : [];

  isAdmin      = data.me_role === "admin";
  adminPresent = !!data.admin_present;
  
    if (Array.isArray(data.chat_messages)) updateGroupChat(data.chat_messages);

  // --- Snapshot élève : chargement complet du notebook du prof ---
  // DOIT être awaité avant applyServerState et setConnectedUI
  if (!isAdmin && data.state?.snapshot) {
    await applySnapshot(data.state.snapshot);
  }

  // --- Page active élève : synchroniser après chargement snapshot ---
  if (!isAdmin && typeof data.state?.current_page_index === "number") {
    applyRemotePageIndex(data.state.current_page_index);
  }

  if (isAdmin) {
    applyServerState(data.state);
  } else {
    // Élève : appliquer les permissions
    // Ignorer si le prof vient de changer les permissions (évite la race condition
    // où le poll élève reçoit encore l'ancien edit_mode avant propagation BDD)
    const editModeChangedRecently = Date.now() - lastEditModeChangedAt < 3000;
    if (data.state && !editModeChangedRecently) {
      studentsCanEdit = data.state.edit_mode === "all";
      allowedEditorId = data.state.edit_mode === "user"
        ? (data.state.allowed_editor_id || null)
        : null;
      applyEditPermission();
      applyMarkdownPermission();
    }

    // Élève : synchroniser le current_text sur la page active uniquement
    // (uniquement si le snapshot a déjà été chargé, sinon on attend le snapshot)
    // On ne touche PAS aux autres pages — juste le code de la page courante.
    if (lastAppliedSnapshot && data.state) {
      const serverText     = typeof data.state.current_text === "string" ? data.state.current_text : "";
      const localText      = getText();
      const recentlyEdited = Date.now() - lastLocalEditAt < 1200;

      if (serverText !== localText && !recentlyEdited) {
        // Mettre à jour la page active dans pagesState ET l'éditeur
        if (window.PagesMultiples) {
          window.PagesMultiples.saveActivePageFromEditor();
          const pages    = window.PagesMultiples.getAllPages();
          const activeIdx= window.PagesMultiples.getActivePageIndex?.() ?? 0;
          if (pages && pages[activeIdx]) {
            pages[activeIdx].code = serverText;
          }
        }
        applyingRemoteUpdate = true;
        setText(serverText);
        applyingRemoteUpdate = false;
        lastSentText = serverText;
      }
    }
  }

  updatePresenceUI(members);

  remoteTyping.clear();
  for (const m of members) {
    if (!m.is_typing) continue;
    if (m.client_id === myId) continue;
    remoteTyping.set(m.client_id, {
      name: m.pseudo || "Quelqu'un",
      ts: Date.now()
    });
  }
  updateTypingUI();

  editRequests.clear();
  for (const r of requests) {
    if (r.client_id) {
      editRequests.set(r.client_id, r.pseudo || "Quelqu'un");
    }
  }

  if (isAdmin) {
    buildParticipantOptions(members);
    renderEditRequests();

    // Envoi automatique si un élève attend le fichier
    if (data.state?.snapshot_requested) {
      sendSnapshotToStudents();
    }
  }

  for (const ev of events) {
    lastEventId = Math.max(lastEventId, Number(ev.id) || 0);

    if (ev.event_type === "system" && ev.event_data?.type === "admin_demoted_to_student") {
      if (ev.event_data?.client_id === myId && data.me_role === "student") {
        isAdmin = false;
        selectRole("student");
        setStatus("Administrateur déjà présent : connecté en tant qu'élève.", "warn");
      }
    }
  }

  setConnectedUI();
}

async function pollOnce() {
  if (!joined || isReconnecting) return;

  try {
    const data = await api("poll", { last_event_id: lastEventId });
    applyPollData(data);
    markSyncSuccess();
  } catch (e) {
    console.error("poll:", e);
    markSyncFailure("poll", e);
  }
}

function startBackgroundLoops() {
  clearInterval(pollTimer);
  clearInterval(heartbeatTimer);

  // Plus de poll PHP — les mises à jour arrivent via WebSocket
  pollTimer = null;

  // Heartbeat léger toutes les 20s pour maintenir last_seen à jour
  heartbeatTimer = setInterval(() => {
    if (!joined || isReconnecting) return;
    socket.emit("heartbeat", {});
  }, HEARTBEAT_INTERVAL_MS);
}

/* ================================
   DIALOGUE ÉLÈVE AVANT CONNEXION
================================ */
async function askStudentJoinBehavior() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.position       = "fixed";
    overlay.style.inset          = "0";
    overlay.style.background     = "rgba(0,0,0,0.35)";
    overlay.style.display        = "flex";
    overlay.style.alignItems     = "center";
    overlay.style.justifyContent = "center";
    overlay.style.zIndex         = "99999";

    const panel = document.createElement("div");
    panel.style.background   = "white";
    panel.style.padding       = "16px";
    panel.style.borderRadius  = "10px";
    panel.style.maxWidth      = "560px";
    panel.style.width         = "calc(100vw - 40px)";
    panel.style.boxShadow     = "0 10px 30px rgba(0,0,0,0.25)";
    overlay.appendChild(panel);

    panel.innerHTML = `
      <div style="font-weight:bold; margin-bottom:12px;">
        Connexion à un groupe
      </div>

      <div style="margin-bottom:16px; line-height:1.45;">
        En vous connectant à un groupe, si le professeur a partagé son fichier,
        il remplacera votre écran actuel.<br><br>
        La navigation entre les pages sera contrôlée par le professeur.
        Vous pourrez consulter toutes les pages mais pas les modifier.<br><br>
        Voulez-vous enregistrer votre travail avant de vous connecter ?
      </div>

      <div style="display:flex; flex-direction:column; gap:8px;">
        <button type="button" id="studentJoinSaveBtn">Oui : enregistrer puis se connecter</button>
        <button type="button" id="studentJoinDiscardBtn">Non : perdre mon travail et me connecter</button>
        <button type="button" id="studentJoinCancelBtn">Abandonner la connexion</button>
      </div>
    `;

    function close(choice) {
      overlay.remove();
      resolve(choice);
    }

    panel.querySelector("#studentJoinSaveBtn")?.addEventListener("click", () => close("save"));
    panel.querySelector("#studentJoinDiscardBtn")?.addEventListener("click", () => close("discard"));
    panel.querySelector("#studentJoinCancelBtn")?.addEventListener("click", () => close("cancel"));

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close("cancel");
    });

    document.body.appendChild(overlay);
  });
}

async function maybeSaveBeforeStudentJoin() {
  const choice = await askStudentJoinBehavior();

  if (choice === "cancel" || !choice) {
    return false;
  }

  if (choice === "save") {
    if (typeof window.saveDariushFileToDiskWithFixedName === "function") {
      const ok = window.saveDariushFileToDiskWithFixedName("sauvegarde_avant_connexion.dpy");
      if (ok === false) {
        setStatus("Impossible d'enregistrer avant connexion.", "warn");
        return false;
      }
    } else {
      alert("Fonction de sauvegarde automatique introuvable.");
      return false;
    }
  }

  return true;
}

/* ================================
   ACTIONS
================================ */
joinBtn?.addEventListener("click", async () => {
  myName        = (pseudoInput?.value ?? "").trim();
  sessionCode   = (codeInput?.value  ?? "").trim();
  lastRequestedRole = getSelectedRole();
  manualDisconnect  = false;

  if (!myName) {
    setStatus("Entre un pseudo.", "warn");
    return;
  }

  if (!sessionCode) {
    setStatus("Entre un code de séance.", "warn");
    return;
  }
 if (sessionCode.length < 6) {
    setStatus("Le code de séance doit faire au moins 6 caractères.", "warn");
    return;
}
  try {
    await waitForPythonEditor(6000);
  } catch (e) {
    console.error(e);
    setStatus("Erreur : l'éditeur Python n'est pas prêt. Recharge la page.", "warn");
    return;
  }

  try {
   if (lastRequestedRole === "student") {
      const okToContinue = await maybeSaveBeforeStudentJoin();
      if (!okToContinue) {
        setStatus("Connexion annulée.", "warn");
        return;
      }
    }

    setStatus("Connexion…", "warn");

    const data = await api("join", {
      requested_role: lastRequestedRole
    });

    joined       = true;
    isAdmin      = data.me_role === "admin";
    adminPresent = !!data.admin_present;
    consecutiveSyncErrors = 0;
    lastAppliedSnapshot   = null;
    lastKnownPageIndex    = -1;

    if (data.me_role === "student" && lastRequestedRole === "teacher") {
  selectRole("student");
  setStatus("Administrateur déjà présent : connecté en tant qu'élève.", "warn");
  
  // Afficher le dialogue AVANT applyPollData (avant que le snapshot soit appliqué)
  const okToContinue = await maybeSaveBeforeStudentJoin();
  if (!okToContinue) {
    manualDisconnect = true;
    await api("leave");
    setDisconnectedUI();
    setStatus("Connexion annulée.", "warn");
    return;
  }
}

    const localTextOnJoin = getText();

    if (isAdmin) {
      try {
        await api("push_text", { text: localTextOnJoin });
        if (data.state) {
          data.state.current_text = localTextOnJoin;
        }
        lastSentText = localTextOnJoin;
        adminPresent = true;

        // Aussi envoyer la page active courante
        const currentIdx = window.PagesMultiples?.getActivePageIndex?.() ?? 0;
        await api("set_page", { page_index: currentIdx });

      } catch (err) {
        console.error("Impossible d'imposer le texte de l'administrateur :", err);
        throw err;
      }
    } else {
      lastSentText = "";
    }

   applyPollData(data);

// Les snapshots arrivent via freeze/snapshot_update/snapshot_loaded
if (!isAdmin && typeof data.state?.current_page_index === "number") {
  applyRemotePageIndex(data.state.current_page_index);
}

    attachEditorHandlersOnce();

    if (isAdmin) {
      attachPageNavHandlersOnce();
    }

    startBackgroundLoops();

    await heartbeat();
    

    if (!isAdmin && !adminPresent) {
      lockPageNavigation();
      setReadOnly(true);
      setStatus("En attente de votre administrateur.", "warn");
    }

  } catch (e) {
    console.error(e);
    setDisconnectedUI();
    setStatus(e.message || "Erreur de connexion.", "warn");
  }
});

leaveBtn?.addEventListener("click", async () => {
  manualDisconnect = true;

  // Sauvegarder la page active AVANT déconnexion
  // pour que PagesMultiples ait toutes les pages à jour
  if (joined && !isAdmin && window.PagesMultiples?.saveActivePageFromEditor) {
    window.PagesMultiples.saveActivePageFromEditor();
  }

  try {
    if (joined) {
      await api("leave");
    }
  } catch (e) {
    console.error(e);
  } finally {
    setDisconnectedUI();
    if (window.__audioGroupeCleanup) window.__audioGroupeCleanup(); 
    // Après déconnexion : afficher le preview markdown de la page courante
    setTimeout(() => {
      if (window.MarkdownEditor?.showPreview) {
        window.MarkdownEditor.showPreview();
      }
    }, 100);
  }
});

requestEditBtn?.addEventListener("click", async () => {
  if (!joined) {
    setStatus("Connecte-toi d'abord.", "warn");
    return;
  }
  if (isAdmin) {
    setStatus("Tu es admin.", "ok");
    return;
  }

  try {
    await api("request_edit");
    setStatus("Demande envoyée à l'administrateur.", "ok");
  } catch (e) {
    markSyncFailure("request_edit", e);
  }
});

editSelect?.addEventListener("change", async () => {
  if (!joined || !isAdmin) return;

  const v = editSelect.value;

  try {
    if (v === "all") {
      await api("set_edit", { mode: "all", allowed_editor_id: null });
      studentsCanEdit = true;
      allowedEditorId = null;
      if (audio_g_eleveSocketId) {
        socket.emit("audio_session_stop", { eleveSocketId: audio_g_eleveSocketId });
      }
      audio_g_eleveSocketId = null;
      audio_g_sessionActive = false;
      audioGroupe_closePeer();
      audio_g_isSpeaking = false;
      if (audio_g_localStream) {
        audio_g_localStream.getTracks().forEach(t => { t.enabled = false; });
      }
      audioGroupe_closeExtra();
      audioGroupe_updateUI();

    } else if (v === "none") {
      await api("set_edit", { mode: "none", allowed_editor_id: null });
      studentsCanEdit = false;
      allowedEditorId = null;
      if (audio_g_eleveSocketId) {
        socket.emit("audio_session_stop", { eleveSocketId: audio_g_eleveSocketId });
      }
      audio_g_eleveSocketId = null;
      audio_g_sessionActive = false;
      audioGroupe_closePeer();
      audio_g_isSpeaking = false;
      if (audio_g_localStream) {
        audio_g_localStream.getTracks().forEach(t => { t.enabled = false; });
      }
      audioGroupe_closeExtra();
      audioGroupe_updateUI();

    } else {
      await api("set_edit", { mode: "user", allowed_editor_id: v });
      studentsCanEdit = false;
      allowedEditorId = v;
      editRequests.delete(v);
      renderEditRequests();
      if (audio_g_eleveSocketId) {
        socket.emit("audio_session_stop", { eleveSocketId: audio_g_eleveSocketId });
      }
      audio_g_isSpeaking = false;
      if (audio_g_localStream) {
        audio_g_localStream.getTracks().forEach(t => { t.enabled = false; });
      }
      audioGroupe_closeExtra();
      audioGroupe_stopSession();
      socket.emit("audio_get_eleve_socket_id", { clientId: v });
    }

    lastEditModeChangedAt = Date.now();
    applyEditPermission();

  } catch (e) {
    markSyncFailure("set_edit", e);
  }
});


// Prof reçoit le socket.id de l'élève sélectionné → démarre session audio
socket.on("audio_eleve_socket_id", async (data) => {
  if (!joined || !isAdmin) return;
  const { eleveSocketId } = data;
  audio_g_eleveSocketId = eleveSocketId;

  // Notifier l'élève d'abord
  socket.emit("audio_session_start", { eleveSocketId });
  
  // Attendre un peu que l'élève soit prêt avant d'envoyer l'offre
  await new Promise(r => setTimeout(r, 300));
  
  // Démarrer la session côté prof
  await audioGroupe_startSession(eleveSocketId, true);
});

/* ================================
   INIT
================================ */
document.addEventListener("DOMContentLoaded", async () => {
  try {
    await waitForPythonEditor(6000);
  } catch (_) {
    // on continue quand même
  }

  setDisconnectedUI();
  setInterval(updateTypingUI, 800);
  initGroupChat();

  // Quitter proprement si l'utilisateur ferme l'onglet/navigateur sans cliquer "Quitter"
  // sendBeacon est conçu pour ça : fiable même en cours de fermeture de page
  function sendLeaveBeacon() {
    if (!joined || manualDisconnect) return;
    if (!sessionCode || !myId) return;

    const payload = JSON.stringify({
      action:       "leave",
      session_code: sessionCode,
      client_id:    myId,
      pseudo:       myName
    });

    navigator.sendBeacon(API_URL, new Blob([payload], { type: "application/json" }));
  }
  // pagehide est plus fiable que beforeunload sur mobile et navigateurs modernes
  window.addEventListener("pagehide", sendLeaveBeacon);
  // beforeunload en complément pour les cas où pagehide n'est pas déclenché
  window.addEventListener("beforeunload", sendLeaveBeacon);
   // Expose l'état groupe pour connexion_aide.js
  window.groupeJoined  = () => joined;
  window.groupeIsAdmin = () => isAdmin;
  window.groupeCanEdit = () => canCurrentUserEdit();
  
});




/* ================================================================
   AUDIO WebRTC — GROUPE
   Architecture : une seule RTCPeerConnection prof ↔ élève sélectionné
   Les autres élèves reçoivent en lecture seule via leurs connexions.
================================================================ */

/* --------------------------------
   ÉTAT
-------------------------------- */
let audio_g_localStream   = null;
let audio_g_peerConn      = null;
let audio_g_remotePeerId  = null;
let audio_g_isSpeaking    = false;
let audio_g_sessionActive = false;
let audio_g_eleveSocketId = null;
let audio_g_profSocketId  = null;

/* --------------------------------
   STUN
-------------------------------- */
const audio_g_iceConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

/* --------------------------------
   OBTENIR LE MICRO
-------------------------------- */
async function audioGroupe_getStream() {
  if (audio_g_localStream) return audio_g_localStream;
  try {
    audio_g_localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return audio_g_localStream;
  } catch (e) {
    console.warn("[audio-groupe] Micro refusé :", e.message);
    return null;
  }
}

/* --------------------------------
   CRÉER LA CONNEXION BIDIRECTIONNELLE
-------------------------------- */
async function audioGroupe_createPeer(toSocketId, initier) {
  audioGroupe_closePeer();

  const pc = new RTCPeerConnection(audio_g_iceConfig);
  pc.onconnectionstatechange = () => {
  if (pc.connectionState === "failed" && isAdmin) {
    alert("La connexion audio a échoué. Déconnectez-vous du groupe et reconnectez-vous pour la relancer.");
  }
};
  audio_g_peerConn     = pc;
  audio_g_remotePeerId = toSocketId;

  if (audio_g_localStream) {
    audio_g_localStream.getTracks().forEach(t => {
      t.enabled = false;
      pc.addTrack(t, audio_g_localStream);
    });
  }

  pc.ontrack = (event) => {
    let el = document.getElementById("audio_g_remote");
    if (!el) {
      el = document.createElement("audio");
      el.id       = "audio_g_remote";
      el.autoplay = true;
      document.body.appendChild(el);
    }
    el.srcObject = event.streams[0];
  };

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    socket.emit("webrtc_ice", {
      targetId:  toSocketId,
      candidate: event.candidate,
      fromId:    socket.id
    });
  };

  if (initier) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("webrtc_offer", {
      targetId: toSocketId,
      sdp:      pc.localDescription,
      fromId:   socket.id
    });
  }

  return pc;
}

/* --------------------------------
   FERMER LA CONNEXION
-------------------------------- */
function audioGroupe_closePeer() {
  if (audio_g_peerConn) {
    audio_g_peerConn.close();
    audio_g_peerConn     = null;
    audio_g_remotePeerId = null;
  }
  const el = document.getElementById("audio_g_remote");
  if (el) el.remove();
}

/* --------------------------------
   DÉMARRER SESSION
-------------------------------- */
async function audioGroupe_startSession(remoteSocketId, jeInitie) {
  audio_g_sessionActive = true;
  audio_g_isSpeaking    = false;

  const stream = await audioGroupe_getStream();
  if (!stream) {
    console.warn("[audio-groupe] Pas de micro disponible.");
    return;
  }

  await audioGroupe_createPeer(remoteSocketId, jeInitie);
  audioGroupe_updateUI();

  const msg = isAdmin
    ? "L'élève sélectionné peut prendre la parole. Son micro coupera le vôtre."
    : "Vous avez la parole. Appuyez sur 🎤 pour parler — cela coupera le micro du professeur.";
  showStatusToast(msg, "ok", 5000);
}

/* --------------------------------
   ARRÊTER SESSION
-------------------------------- */
function audioGroupe_stopSession() {
  audio_g_sessionActive = false;
  audio_g_isSpeaking    = false;
  audio_g_eleveSocketId = null;
  audio_g_profSocketId  = null;

  if (audio_g_localStream) {
    audio_g_localStream.getTracks().forEach(t => { t.enabled = false; });
  }
  audioGroupe_closeExtra();
  audioGroupe_closePeer();
  audioGroupe_updateUI();
}

/* --------------------------------
   TOGGLE PAROLE
-------------------------------- */
async function audioGroupe_toggleSpeak() {
  // Élève sans session active → bloqué
  if (!isAdmin && !audio_g_sessionActive) return;

  // S'assurer qu'on a un stream
  if (!audio_g_localStream) {
    await audioGroupe_getStream();
    if (!audio_g_localStream) return;
  }

  audio_g_isSpeaking = !audio_g_isSpeaking;

  audio_g_localStream.getTracks().forEach(t => {
    t.enabled = audio_g_isSpeaking;
  });

  socket.emit("audio_speaking", {
   
    session_code: sessionCode,
    speaking:     audio_g_isSpeaking,
    role:         isAdmin ? "prof" : "student"
  });
  if (audio_g_isSpeaking) {
    await audioGroupe_connectExtra();
  } else {
    audioGroupe_closeExtra();
  }
  audioGroupe_updateUI();
}  

/* --------------------------------
   NETTOYAGE COMPLET
-------------------------------- */
function audioGroupe_cleanup() {
  audioGroupe_stopSession();

  if (audio_g_localStream) {
    audio_g_localStream.getTracks().forEach(t => t.stop());
    audio_g_localStream = null;
  }

  audio_g_isSpeaking = false;
  audioGroupe_closeExtra();
  audioGroupe_updateUI();
}

/* --------------------------------
   UI
-------------------------------- */
function audioGroupe_updateUI() {
  const btn  = document.getElementById("audioBtnGroupe");
  const zone = document.getElementById("audioGroupeZone");
  if (!zone) return;

  if (!joined) {
    zone.style.display = "none";
    return;
  }

  if (isAdmin) {
    zone.style.display = "";
    if (!btn) return;
    btn.style.display  = "inline-block";
    btn.disabled       = false;
    btn.style.opacity  = "1";

    if (!audio_g_localStream) {
      btn.textContent = "🎤 Activer le micro";
      btn.title       = "Cliquer pour activer le micro";
    } else {
      btn.textContent = audio_g_isSpeaking ? "🔴 Je parle…" : "🎤 Prendre la parole";
      btn.title       = audio_g_isSpeaking ? "Cliquer pour couper" : "Cliquer pour parler";
    }

  } else {
    if (!btn) return;
    if (!audio_g_sessionActive) {
      zone.style.display = "none";
      btn.style.display  = "none";
    } else {
      zone.style.display = "";
      btn.style.display  = "inline-block";
      btn.disabled       = false;
      btn.style.opacity  = "1";
      btn.textContent    = audio_g_isSpeaking ? "🔴 Je parle…" : "🎤 Prendre la parole";
      btn.title          = audio_g_isSpeaking ? "Cliquer pour couper" : "Cliquer pour parler";
    }
  }
}

/* --------------------------------
   LISTENERS SOCKET WebRTC
-------------------------------- */

socket.on("webrtc_offer", async (data) => {
  if (!joined) return;
  const { fromId, sdp } = data;

  const pc = await audioGroupe_createPeer(fromId, false);
  if (!pc) return;

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  socket.emit("webrtc_answer", {
    targetId: fromId,
    sdp:      pc.localDescription,
    fromId:   socket.id
  });
});

socket.on("webrtc_answer", async (data) => {
  if (!joined || !audio_g_peerConn) return;
  await audio_g_peerConn.setRemoteDescription(new RTCSessionDescription(data.sdp));
});

socket.on("webrtc_ice", async (data) => {
  if (!joined || !audio_g_peerConn) return;
  const { candidate } = data;
  try {
    await audio_g_peerConn.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    console.warn("[audio-groupe] ICE ignoré :", e.message);
  }
});

socket.on("audio_speaking_update", (data) => {
  if (!joined) return;
  if (!audio_g_localStream) return;

  const jesuisLeLocuteur = (
    (isAdmin && data.role === "prof") ||
    (!isAdmin && data.role === "student")
  );

  if (!jesuisLeLocuteur && data.speaking) {
    audio_g_isSpeaking = false;
    audio_g_localStream.getTracks().forEach(t => { t.enabled = false; });
    audioGroupe_updateUI();
  }
});

socket.on("audio_session_start", async (data) => {
  if (!joined || isAdmin) return;
  audio_g_profSocketId = data.profSocketId;
  await audioGroupe_startSession(data.profSocketId, false);
});

socket.on("audio_session_stop", () => {
  if (!joined || isAdmin) return;
  audioGroupe_stopSession();
});

/* --------------------------------
   BOUTON MICRO
-------------------------------- */
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("audioBtnGroupe");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    if (!joined) return;
    await audioGroupe_toggleSpeak();
  });
});


async function audioGroupe_initMicPermission() {
  let state = "prompt";
  try {
    const perm = await navigator.permissions.query({ name: "microphone" });
    state = perm.state;
  } catch (e) {
    state = "prompt";
  }

  // Déjà autorisé → bouton visible, rien à faire
  if (state === "granted") {
    audioGroupe_updateUI();
    return;
  }

  // Refusé définitivement → bouton caché, message
  if (state === "denied") {
    const zone = document.getElementById("audioGroupeZone");
    if (zone) zone.style.display = "none";
    return;
  }

  // "prompt" → demander à l'utilisateur
  const ok = confirm("Voulez-vous pouvoir utiliser votre micro pendant cette session ?");
  if (!ok) {
    const zone = document.getElementById("audioGroupeZone");
    if (zone) zone.style.display = "none";
    return;
  }

  // Bloquer le panel pendant getUserMedia
  const joinBtn  = document.getElementById("join");
  const leaveBtn = document.getElementById("leave");
  if (joinBtn)  joinBtn.disabled  = true;
  if (leaveBtn) leaveBtn.disabled = true;

  try {
    await audioGroupe_getStream();
  } catch(e) {
    // L'utilisateur a cliqué "Bloquer" → cacher le bouton
    const zone = document.getElementById("audioGroupeZone");
    if (zone) zone.style.display = "none";
  }

  // Débloquer
  if (joinBtn)  joinBtn.disabled  = false;
  if (leaveBtn) leaveBtn.disabled = false;

  audioGroupe_updateUI();
}

/* --------------------------------
   ACCROCHAGE DÉCONNEXION
-------------------------------- */
window.__audioGroupeCleanup = audioGroupe_cleanup;



/* ================================================================
   GESTION DES EXTRAS
   Connexions unidirectionnelles vers les autres élèves
   quand quelqu'un prend la parole.
================================================================ */

let audio_g_extraPeers = {};


async function audioGroupe_connectExtra() {
  if (!audio_g_localStream) return;
  await new Promise(r => setTimeout(r, 300));
  socket.emit("audio_request_peers", {});
}


function audioGroupe_closeExtra() {
  for (const peerId of Object.keys(audio_g_extraPeers)) {
    audio_g_extraPeers[peerId].close();
    const el = document.getElementById("audio_g_extra_" + peerId);
    if (el) el.remove();
  }
  audio_g_extraPeers = {};
}

socket.on("audio_peers_list", async (data) => {
  if (!joined) return;
  const { peerIds } = data;
  for (const peerId of peerIds) {
    if (peerId === socket.id) continue;
   // if (peerId === audio_g_remotePeerId) continue;
    if (audio_g_remotePeerId && peerId === audio_g_remotePeerId) continue;
    if (audio_g_extraPeers[peerId]) continue;

    const pc = new RTCPeerConnection(audio_g_iceConfig);
    audio_g_extraPeers[peerId] = pc;

    if (audio_g_localStream) {
      audio_g_localStream.getTracks().forEach(t => pc.addTrack(t, audio_g_localStream));
    }

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      socket.emit("webrtc_ice_extra", {
        targetId:  peerId,
        candidate: event.candidate,
        fromId:    socket.id
      });
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("webrtc_offer_extra", {
      targetId: peerId,
      sdp:      pc.localDescription,
      fromId:   socket.id
    });
  }
});

/* Offre entrante d'un extra peer */
socket.on("webrtc_offer_extra", async (data) => {
   if (!joined) return;
  const { fromId, sdp } = data;
  
  // Fermer l'ancienne connexion extra si elle existe
  if (audio_g_extraPeers[fromId]) {
    audio_g_extraPeers[fromId].close();
    delete audio_g_extraPeers[fromId];
    const el = document.getElementById("audio_g_extra_" + fromId);
    if (el) el.remove();
  }

  
  const pc = new RTCPeerConnection(audio_g_iceConfig);
  audio_g_extraPeers[fromId] = pc;

  pc.ontrack = (event) => {
    const audioId = "audio_g_extra_" + fromId;
    let el = document.getElementById(audioId);
    if (!el) {
      el = document.createElement("audio");
      el.id       = audioId;
      el.autoplay = true;
      document.body.appendChild(el);
    }
    el.srcObject = event.streams[0];
  };

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    socket.emit("webrtc_ice_extra", {
      targetId:  fromId,
      candidate: event.candidate,
      fromId:    socket.id
    });
  };

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  socket.emit("webrtc_answer_extra", {
    targetId: fromId,
    sdp:      pc.localDescription,
    fromId:   socket.id
  });
});

/* Réponse d'un extra peer */
socket.on("webrtc_answer_extra", async (data) => {
  if (!joined) return;
  const pc = audio_g_extraPeers[data.fromId];
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
});

/* ICE d'un extra peer */
socket.on("webrtc_ice_extra", async (data) => {
  if (!joined) return;
  const pc = audio_g_extraPeers[data.fromId];
  if (!pc) return;
  try {
    await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
  } catch (e) {
    console.warn("[audio-extra] ICE ignoré :", e.message);
  }
});


