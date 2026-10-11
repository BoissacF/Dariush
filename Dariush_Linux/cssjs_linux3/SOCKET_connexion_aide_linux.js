/* =========================================================

   SOCKET_connexion_aide_linux.js
   ──────────────────────────────
   Fonctionnalité "Demander de l'aide" — SPÉCIFIQUE DARIUSH LINUX
   Version WebSocket — totalement dissociée de SOCKET_connexion_aide.js (Python)

   Ce fichier est calqué sur SOCKET_connexion_aide.js Python mais
   adapté pour la CO-ÉDITION DE TERMINAL au lieu du snapshot
   notebook + échange de code Python.

   Différences principales avec la version Python :
   - Pas de snapshot notebook : le prof voit en direct ce que tape l'élève
     via la duplication du PTY (event "aide_linux_pty_output").
   - Pas d'échange de code Python : le prof tape dans son faux terminal,
     ça part directement dans le PTY de l'élève via "aide_linux_input".
   - Pas de curseur partagé (contrairement à Python) : peu d'intérêt
     pédagogique sur un terminal car la position d'écriture est toujours
     au prompt. Le chat + le micro suffisent pour pointer une erreur.
   - Un second xterm.js est créé côté prof dans #terminalContainerAide.

   Le socket est partagé avec SOCKET_connexion.js via window._dariushSocket.
   Tous les événements sont préfixés "aide_linux_".
   Room serveur : "aide_linux_<code_aide>"

   ========================================================= */

/* ================================
   CONFIG
================================ */
const AIDE_LINUX_HEARTBEAT_MS = 20000;

/* ================================
   ÉTAT GLOBAL
================================ */
let aideLinuxConnecte            = false;
let aideLinuxEstProf             = false;
let aideLinuxCodeAide            = "";
let aideLinuxPseudo              = "";
let aideLinuxEleveActif          = null;
let aideLinuxDeconnexionManuelle = false;
let aideLinuxToastAttenteMontre  = false;
let aideLinuxToastTimer          = null;
let aideLinuxHeartbeatTimer      = null;

/* Faux terminal du prof — xterm.js */
let aideLinuxFauxTerm     = null;
let aideLinuxFauxTermFit  = null;

/* Snapshot + multipage (calqué sur l'aide Python) */
let aideLinuxIsSendingSnapshot       = false;
let aideLinuxChangementPageInitieParProf = false;

/* Audio WebRTC */
let aideLinuxLocalStream    = null;
let aideLinuxPeerConn       = null;
let aideLinuxRemotePeerId   = null;
let aideLinuxEleveSocketId  = null;
let aideLinuxProfSocketId   = null;
let aideLinuxSessionActive  = false;
let aideLinuxIsSpeaking     = false;

/* ================================
   ACCÈS AU SOCKET PARTAGÉ
================================ */
function getSocketAideLinux() {
  return window._dariushSocket || null;
}

/* ================================
   TOAST AU-DESSUS DU BOUTON AIDE
================================ */
function showToastAideLinux(message, duration = 6000) {
  const toast = document.getElementById("aideToast");
  if (!toast) return;

  toast.textContent = message;
  toast.classList.add("visible");

  if (aideLinuxToastTimer) clearTimeout(aideLinuxToastTimer);
  aideLinuxToastTimer = setTimeout(() => {
    toast.classList.remove("visible");
  }, duration);
}

/* ================================
   ACCÈS UI
================================ */
function getUI_aideLinux(id) {
  return document.getElementById(id);
}

function setStatutAideLinux(msg, type = "info") {
  const el = getUI_aideLinux("aideStatut");
  if (!el) return;
  el.textContent = msg;
  el.className = "group-msg-muted";
  if (type === "warn") el.style.color = "#c0392b";
  else if (type === "ok") el.style.color = "#1e7a44";
  else el.style.color = "";
}

/* ================================
   ZONE CHAT
================================ */
function showChatZoneAideLinux() {
  const zone = getUI_aideLinux("aideChatZone");
  if (zone) zone.style.display = "";
}

function hideChatZoneAideLinux() {
  const zone = getUI_aideLinux("aideChatZone");
  if (zone) zone.style.display = "none";
}

function updateChatAideLinux(messages) {
  const chat = getUI_aideLinux("aideChatMessages");
  if (!chat) return;
  if (!messages || messages.length === 0) {
    chat.value = "";
    return;
  }
  const lignes = messages.map(m => {
    const d = new Date(m.created_at);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `[${hh}:${mm}] ${m.pseudo} : ${m.text}`;
  });
  chat.value = lignes.join("\n");
  chat.scrollTop = chat.scrollHeight;
}

function clearChatAideLinux() {
  const chat = getUI_aideLinux("aideChatMessages");
  if (chat) chat.value = "";
}

/* ================================
   RENDU FILE D'ATTENTE
================================ */
function renderFileAttenteLinux(file) {
  const el = getUI_aideLinux("aideFileAttente");
  if (!el) return;
  if (!file || file.length === 0) {
    el.innerHTML = "<em>Aucun élève en attente.</em>";
    return;
  }
  const lignes = file.map((m, idx) => {
    const badge = m.statut === "actif" ? "🟢 actif" : (idx === 0 ? "⏳ prochain" : "⏳ en attente");
    return `<div>${idx + 1}. ${m.pseudo_eleve} — ${badge}</div>`;
  });
  el.innerHTML = lignes.join("");
}

function renderSelectElevesLinux(file) {
  const sel = getUI_aideLinux("aideSelectEleve");
  if (!sel) return;
  const valActuelle = sel.value;
  sel.innerHTML = "";
  const optDefaut = document.createElement("option");
  optDefaut.value = "";
  optDefaut.textContent = "-- Sélectionner un élève --";
  sel.appendChild(optDefaut);
  for (const m of file) {
    const opt = document.createElement("option");
    opt.value = m.pseudo_eleve;
    opt.textContent = m.pseudo_eleve + (m.statut === "actif" ? " (actif)" : "");
    sel.appendChild(opt);
  }
  if (valActuelle && file.some(m => m.pseudo_eleve === valActuelle)) {
    sel.value = valActuelle;
  }
}

/* ================================
   PANNEAUX (connexion / prof / élève)
================================ */
function showPanelConnexionAideLinux() {
  getUI_aideLinux("aidePanelConnexion").style.display = "";
  getUI_aideLinux("aidePanelProf").style.display      = "none";
  getUI_aideLinux("aidePanelEleve").style.display     = "none";
  hideChatZoneAideLinux();
  hideFauxTerminalLinux();
}

function showPanelProfAideLinux() {
  getUI_aideLinux("aidePanelConnexion").style.display = "none";
  getUI_aideLinux("aidePanelProf").style.display      = "";
  getUI_aideLinux("aidePanelEleve").style.display     = "none";
}

function showPanelEleveAideLinux() {
  getUI_aideLinux("aidePanelConnexion").style.display = "none";
  getUI_aideLinux("aidePanelProf").style.display      = "none";
  getUI_aideLinux("aidePanelEleve").style.display     = "";
}

/* ================================
   FAUX TERMINAL (côté prof)
================================ */
function showFauxTerminalLinux(pseudoEleve) {
  const wrap = getUI_aideLinux("terminalContainerAideWrap");
  if (!wrap) return;
  wrap.style.display = "";

  // Cacher le propre terminal du prof pour libérer la vue
  const ownTerm = getUI_aideLinux("terminalContainer");
  if (ownTerm) ownTerm.style.display = "none";

  const label = getUI_aideLinux("aideTerminalEleveLabel");
  if (label) label.textContent = pseudoEleve ? `— ${pseudoEleve}` : "";

  // Créer le terminal s'il n'existe pas encore
  if (!aideLinuxFauxTerm) {
    if (typeof Terminal === "undefined" || typeof FitAddon === "undefined") {
      console.error("[aide-linux] xterm.js non chargé");
      return;
    }
    aideLinuxFauxTerm = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      theme: {
        background: "#1e1e1e",
        foreground: "#d4d4d4",
        cursor:     "#ffffff",
      },
      scrollback: 1000,
      convertEol: true,
    });
    aideLinuxFauxTermFit = new FitAddon.FitAddon();
    aideLinuxFauxTerm.loadAddon(aideLinuxFauxTermFit);

    const container = getUI_aideLinux("terminalContainerAide");
    aideLinuxFauxTerm.open(container);
    aideLinuxFauxTerm.attachCustomKeyEventHandler(() => true);
    aideLinuxFauxTermFit.fit();

    // Quand le prof tape, on envoie au serveur qui écrira dans le PTY de l'élève
    aideLinuxFauxTerm.onData((data) => {
      const sock = getSocketAideLinux();
      if (sock && sock.connected && aideLinuxConnecte && aideLinuxEstProf) {
        sock.emit("aide_linux_input", data);
      }
    });

    // Demander la taille actuelle du PTY de l'élève pour adapter le faux terminal
    const sock = getSocketAideLinux();
    if (sock) sock.emit("aide_linux_resize_request");
  } else {
    aideLinuxFauxTerm.clear();
    aideLinuxFauxTermFit.fit();
  }
}

function hideFauxTerminalLinux() {
  const wrap = getUI_aideLinux("terminalContainerAideWrap");
  if (wrap) wrap.style.display = "none";

  // Remettre le propre terminal du prof visible
  const ownTerm = getUI_aideLinux("terminalContainer");
  if (ownTerm) ownTerm.style.display = "";

  if (aideLinuxFauxTerm) {
    aideLinuxFauxTerm.clear();
  }
}

/* ════════════════════════════════════════════════════════════
   SNAPSHOT + MULTIPAGE
   Calqué AU MOT PRÈS sur l'aide Python (sendSnapshotAide /
   applySnapshotAide / attachPageNavListenerAide).
   Seuls les noms d'events portent le suffixe "_linux", et les
   références au "groupe" (inexistant en Linux) sont retirées.
════════════════════════════════════════════════════════════ */

/* ================================
   SNAPSHOT ÉLÈVE → PROF
   Envoie le notebook complet + numéro de page active
================================ */
async function sendSnapshotAideLinux() {
  if (aideLinuxIsSendingSnapshot) return;
  if (typeof window.buildLink !== "function") {
    console.warn("[aide-linux] buildLink introuvable, snapshot impossible.");
    return;
  }

  aideLinuxIsSendingSnapshot = true;

  try {
    if (window.PagesMultiples?.saveActivePageFromEditor) {
      window.PagesMultiples.saveActivePageFromEditor();
    }

    const snapshotUrl = await window.buildLink({ askDate: false });
    if (!snapshotUrl) return;

    const activeIndex = window.PagesMultiples?.getActivePageIndex?.() ?? 0;

    const sock = getSocketAideLinux();
    if (!sock) return;

    sock.emit("aide_linux_push_snapshot", {
      snapshot:          snapshotUrl,
      active_page_index: activeIndex
    });

    console.log("[aide-linux] Snapshot envoyé au prof, page active :", activeIndex);

  } catch (e) {
    console.warn("[aide-linux] sendSnapshotAideLinux :", e);
  } finally {
    aideLinuxIsSendingSnapshot = false;
  }
}

/* ================================
   SNAPSHOT PROF ← ÉLÈVE
================================ */
async function applySnapshotAideLinux(snapshotUrl, indexActif = 0) {
  if (!snapshotUrl) return;

  if (typeof window.decode_url !== "function") {
    console.warn("[aide-linux] decode_url non disponible, snapshot ignoré.");
    return;
  }

  try {
    const result = await window.decode_url(snapshotUrl);
    if (result !== false) {
      await new Promise(r => setTimeout(r, 150));

      if (window.PagesMultiples) {
        const pages = window.PagesMultiples.getAllPages() || [];
        const safeIndex = Math.min(indexActif, pages.length - 1);
        window.PagesMultiples.setAllPages(pages, safeIndex);
        await new Promise(r => setTimeout(r, 100));
      }

      if (window.MarkdownEditor?.showPreview) {
        await window.MarkdownEditor.showPreview();
      }
    } else {
      console.warn("[aide-linux] decode_url a retourné false.");
    }
  } catch (e) {
    console.error("[aide-linux] Erreur application snapshot :", e);
  }
}

/* ================================
   NAVIGATION PAGES — BOUTONS BAS DE PAGE
   Branché une seule fois au DOMContentLoaded.
   - Prof : émet aide_linux_set_page
   - Élève : envoie son snapshot
================================ */
function attachPageNavListenerAideLinux() {
  const btnPrev = document.getElementById("bottomPrevPageButton");
  const btnNext = document.getElementById("bottomNextPageButton");

  const onNav = () => {
    if (!aideLinuxConnecte) return;

    setTimeout(() => {
      const pageIndex = window.PagesMultiples?.getActivePageIndex?.() ?? 0;
      const sock = getSocketAideLinux();
      if (!sock) return;

      if (aideLinuxEstProf) {
        if (!aideLinuxEleveActif) return;
        aideLinuxChangementPageInitieParProf = true;
        sock.emit("aide_linux_set_page", { page_index: pageIndex });
      } else {
        // Élève → envoie son snapshot
        sendSnapshotAideLinux();
      }
    }, 100);
  };

  btnPrev?.addEventListener("click", onNav);
  btnNext?.addEventListener("click", onNav);
}

/* ================================
   HEARTBEAT
================================ */
function startHeartbeatAideLinux() {
  stopHeartbeatAideLinux();
  aideLinuxHeartbeatTimer = setInterval(() => {
    if (!aideLinuxConnecte) return;
    const sock = getSocketAideLinux();
    if (sock) sock.emit("aide_linux_heartbeat");
  }, AIDE_LINUX_HEARTBEAT_MS);
}

function stopHeartbeatAideLinux() {
  if (aideLinuxHeartbeatTimer) {
    clearInterval(aideLinuxHeartbeatTimer);
    aideLinuxHeartbeatTimer = null;
  }
}

/* ================================
   CONNEXION PROF
================================ */
async function connexionProf_aideLinux() {
  const pseudo = (getUI_aideLinux("aidePseudoInput")?.value ?? "").trim();
  const code   = (getUI_aideLinux("aideCodeInput")?.value ?? "").trim();

  if (!pseudo) { setStatutAideLinux("Entrez un pseudo.", "warn"); return; }
  if (!code)   { setStatutAideLinux("Entrez un code d'aide.", "warn"); return; }
  if (code.length < 6) { setStatutAideLinux("Le code doit faire au moins 6 caractères.", "warn"); return; }

  const sock = getSocketAideLinux();
  if (!sock || !sock.connected) {
    setStatutAideLinux("Serveur non disponible. Rechargez la page.", "warn");
    return;
  }

  setStatutAideLinux("Connexion…", "info");

  sock.once("aide_linux_join_result", (data) => {
    if (!data.ok) {
      setStatutAideLinux("Erreur : " + data.error, "warn");
      return;
    }

    aideLinuxConnecte            = true;
    window.__aideConnecte        = true;
    aideLinuxEstProf             = true;
    aideLinuxCodeAide            = code;
    aideLinuxPseudo              = pseudo;
    aideLinuxEleveActif          = null;
    aideLinuxDeconnexionManuelle = false;

    showPanelProfAideLinux();
    setStatutAideLinux("Session démarrée. En attente d'élèves…", "info");

    if (data.queue && data.queue.length > 0) {
      renderSelectElevesLinux(data.queue);
      renderFileAttenteLinux(data.queue);
      const enAttente = data.queue.filter(m => m.statut === "attente").length;
      if (enAttente > 0) {
        showToastAideLinux(
          enAttente === 1
            ? "1 élève attend votre aide — cliquez pour le sélectionner"
            : `${enAttente} élèves attendent votre aide — cliquez pour en sélectionner un`
        );
      }
    }

    startHeartbeatAideLinux();
    attachSocketListenersAideLinux();
  });

  sock.emit("aide_linux_join_prof", { code_aide: code, pseudo_prof: pseudo });
}

/* ================================
   CONNEXION ÉLÈVE
================================ */
async function connexionEleve_aideLinux() {
  const pseudo = (getUI_aideLinux("aidePseudoInput")?.value ?? "").trim();
  const code   = (getUI_aideLinux("aideCodeInput")?.value ?? "").trim();

  if (!pseudo) { setStatutAideLinux("Entrez un pseudo.", "warn"); return; }
  if (!code)   { setStatutAideLinux("Entrez un code d'aide.", "warn"); return; }

  const sock = getSocketAideLinux();
  if (!sock || !sock.connected) {
    setStatutAideLinux("Serveur non disponible. Rechargez la page.", "warn");
    return;
  }

  setStatutAideLinux("Connexion…", "info");

  sock.once("aide_linux_join_result", (data) => {
    if (!data.ok) {
      setStatutAideLinux("Erreur : " + data.error, "warn");
      return;
    }

    aideLinuxConnecte            = true;
    window.__aideConnecte        = true;
    aideLinuxEstProf             = false;
    aideLinuxCodeAide            = code;
    aideLinuxPseudo              = pseudo;
    aideLinuxDeconnexionManuelle = false;

    const rang  = data.rang  || 1;
    const total = data.total || 1;

    showPanelEleveAideLinux();
    setStatutAideLinux(
      `Vous avez sollicité une aide à votre professeur. ` +
      `Veuillez patienter, vous êtes ${rang}${rang === 1 ? "er" : "ème"} ` +
      `sur ${total} en file d'attente.`,
      "info"
    );

    startHeartbeatAideLinux();
    attachSocketListenersAideLinux();
  });

  sock.emit("aide_linux_join_eleve", { code_aide: code, pseudo_eleve: pseudo });
}

/* ================================
   BRANCHEMENT DES ÉVÉNEMENTS SOCKET
================================ */
function attachSocketListenersAideLinux() {
  const sock = getSocketAideLinux();
  if (!sock) return;

  sock.on("aide_linux_queue_update",       onAideLinuxQueueUpdate);
  sock.on("aide_linux_actif_update",       onAideLinuxActifUpdate);
  sock.on("aide_linux_pty_output",         onAideLinuxPtyOutput);
  sock.on("aide_linux_resize_info",        onAideLinuxResizeInfo);
  sock.on("aide_linux_chat_update",        onAideLinuxChatUpdate);
  sock.on("aide_linux_session_closed",     onAideLinuxSessionClosed);
  sock.on("aide_linux_prof_disconnected",  onAideLinuxProfDisconnected);
  sock.on("aide_linux_snapshot_received",  onAideLinuxSnapshotReceived);
  sock.on("aide_linux_page_update",        onAideLinuxPageUpdate);
}

function offSocketListenersAideLinux() {
  const sock = getSocketAideLinux();
  if (!sock) return;

  sock.off("aide_linux_queue_update",      onAideLinuxQueueUpdate);
  sock.off("aide_linux_actif_update",      onAideLinuxActifUpdate);
  sock.off("aide_linux_pty_output",        onAideLinuxPtyOutput);
  sock.off("aide_linux_resize_info",       onAideLinuxResizeInfo);
  sock.off("aide_linux_chat_update",       onAideLinuxChatUpdate);
  sock.off("aide_linux_session_closed",    onAideLinuxSessionClosed);
  sock.off("aide_linux_prof_disconnected", onAideLinuxProfDisconnected);
  sock.off("aide_linux_snapshot_received", onAideLinuxSnapshotReceived);
  sock.off("aide_linux_page_update",       onAideLinuxPageUpdate);
}

/* ================================
   HANDLERS ÉVÉNEMENTS
================================ */
function onAideLinuxQueueUpdate(data) {
  if (!aideLinuxConnecte) return;
  const queue = data.queue || [];
  if (aideLinuxEstProf) {
    renderSelectElevesLinux(queue);
    renderFileAttenteLinux(queue);
    const enAttente = queue.filter(m => m.statut === "attente").length;
    if (enAttente > 0 && !aideLinuxToastAttenteMontre) {
      aideLinuxToastAttenteMontre = true;
      showToastAideLinux(
        enAttente === 1
          ? "1 élève attend votre aide — cliquez pour le sélectionner"
          : `${enAttente} élèves attendent votre aide — cliquez pour en sélectionner un`
      );
    }
    if (enAttente === 0) aideLinuxToastAttenteMontre = false;
  } else {
    // Élève : recalculer son rang
    const idx = queue.findIndex(m => m.pseudo_eleve === aideLinuxPseudo);
    if (idx >= 0) {
      const m = queue[idx];
      if (m.statut === "attente") {
        const rang = idx + 1;
        setStatutAideLinux(
          `Vous êtes ${rang}${rang === 1 ? "er" : "ème"} sur ${queue.length} en file d'attente.`,
          "info"
        );
      }
    }
  }
}

function onAideLinuxActifUpdate(data) {
  if (!aideLinuxConnecte || aideLinuxEstProf) return;
  setStatutAideLinux("Votre professeur est connecté sur votre écran.", "ok");
  showToastAideLinux("Votre professeur est connecté sur votre écran. 🎓");
  showChatZoneAideLinux();

  // Verrouillage navigation : on emprunte la mécanique du groupe.
  // Pose __groupNavLocked qui est respecté par updateBottomPageNav
  // (interpreteur.js) et par isNavigationAllowed (pageScrollbar.js).
  // L'élève actif ne peut plus naviguer, seul le prof pilote.
  if (typeof window.lockPageNavigation === "function") {
    window.lockPageNavigation();
  }

  // Envoyer le snapshot initial (notebook complet + page active) au prof.
  // Calqué sur l'aide Python : l'élève passe en actif → il envoie son snapshot.
  sendSnapshotAideLinux();

  // Demander la connexion audio au prof
  const sock = getSocketAideLinux();
  if (sock) sock.emit("aide_linux_audio_request_prof_id");
}

function onAideLinuxPtyOutput(data) {
  // Reçu uniquement par le prof — sortie du PTY de l'élève à afficher dans le faux terminal
  if (!aideLinuxConnecte || !aideLinuxEstProf) return;
  if (!aideLinuxFauxTerm) return;
  if (data && typeof data.data !== "undefined") {
    aideLinuxFauxTerm.write(data.data);
  }
}

function onAideLinuxResizeInfo(data) {
  // Reçu par le prof — info sur la taille du PTY de l'élève
  // On ne resize PAS le faux terminal automatiquement (il a sa propre taille).
  // C'est juste informatif pour qu'on puisse adapter visuellement si besoin.
  if (!aideLinuxFauxTerm || !aideLinuxFauxTermFit) return;
  // Pour l'instant : on s'adapte au container
  aideLinuxFauxTermFit.fit();
}

function onAideLinuxChatUpdate(data) {
  if (!aideLinuxConnecte) return;
  updateChatAideLinux(data.messages || []);
}

/* ================================
   SNAPSHOT REÇU (côté prof)
   Calqué sur onAideSnapshotReceived (Python)
================================ */
async function onAideLinuxSnapshotReceived(data) {
  if (!aideLinuxConnecte || !aideLinuxEstProf) return;

  // Si c'est le prof qui a initié le changement de page, on ignore
  // le snapshot de retour (il a déjà la bonne page).
  if (aideLinuxChangementPageInitieParProf) {
    aideLinuxChangementPageInitieParProf = false;
    return;
  }

  const { snapshot, active_page_index } = data;
  const pageIndex = active_page_index ?? 0;
  await applySnapshotAideLinux(snapshot, pageIndex);
  setStatutAideLinux("Notebook de l'élève chargé. Aide en cours.", "ok");
}

/* ================================
   CHANGEMENT DE PAGE (reçu par l'élève quand le prof change)
   L'élève navigue puis renvoie son snapshot.
   Calqué sur onAidePageUpdate (Python)
================================ */
async function onAideLinuxPageUpdate(data) {
  if (aideLinuxEstProf) return;

  const { page_index } = data;
  if (!window.PagesMultiples) return;

  const pages     = window.PagesMultiples.getAllPages() || [];
  const safeIndex = Math.min(page_index, pages.length - 1);

  window.PagesMultiples.setAllPages(pages, safeIndex);

  await new Promise(r => setTimeout(r, 150));
  await sendSnapshotAideLinux();
}




function onAideLinuxSessionClosed(data) {
  if (!aideLinuxConnecte || aideLinuxEstProf) return;

  stopHeartbeatAideLinux();
  offSocketListenersAideLinux();

  const sock = getSocketAideLinux();
  if (sock) sock.emit("aide_linux_leave");

  resetEtatAideLinux();
  showPanelConnexionAideLinux();
  setStatutAideLinux(data?.reason || "La session d'aide est terminée.", "info");
  showToastAideLinux(data?.reason || "Votre session d'aide est terminée.", 6000);
}


function onAideLinuxProfDisconnected(data) {
  if (!aideLinuxConnecte) return;
  showToastAideLinux(data?.message || "Votre professeur a quitté la session.", 8000);
  setStatutAideLinux("Le professeur s'est déconnecté.", "warn");
  hideChatZoneAideLinux();
  audioAideLinux_stopSession();

  // Pour l'élève : retour panneau connexion
  if (!aideLinuxEstProf) {
    deconnexionEleve_aideLinux(true);
  }
}

/* ================================
   DÉCONNEXION PROF
================================ */
async function deconnexionProf_aideLinux() {
  aideLinuxDeconnexionManuelle = true;
  stopHeartbeatAideLinux();
  offSocketListenersAideLinux();

  const sock = getSocketAideLinux();
  if (sock) sock.emit("aide_linux_leave");

  resetEtatAideLinux();
  showPanelConnexionAideLinux();
  setStatutAideLinux("Session terminée.", "info");
}

/* ================================
   DÉCONNEXION ÉLÈVE
================================ */
async function deconnexionEleve_aideLinux(silencieux = false) {
  aideLinuxDeconnexionManuelle = true;
  stopHeartbeatAideLinux();
  offSocketListenersAideLinux();

  const sock = getSocketAideLinux();
  if (sock && !silencieux) sock.emit("aide_linux_leave");

  resetEtatAideLinux();
  showPanelConnexionAideLinux();
  setStatutAideLinux(silencieux ? "Session terminée par le professeur." : "Déconnecté.", "info");
}

/* ================================
   CLÔTURE ÉLÈVE ACTIF (côté prof)
================================ */
async function cloturerEleveActif_aideLinux(pseudoEleve) {
  if (!pseudoEleve) return;

  const sock = getSocketAideLinux();
  if (sock) sock.emit("aide_linux_cloturer", { pseudo_eleve: pseudoEleve });

  aideLinuxEleveActif = null;
  clearChatAideLinux();
  hideChatZoneAideLinux();
  hideFauxTerminalLinux();
  audioAideLinux_stopSession();
  setStatutAideLinux("Aide terminée. En attente d'un nouvel élève…", "info");
}

/* ================================
   RESET ÉTAT
================================ */
function resetEtatAideLinux() {
  // Si on était un élève actif en aide (donc qui avait été verrouillé via
  // lockPageNavigation), on lève le verrou groupe AVANT de tout reset.
  // ATTENTION : ne pas lever le verrou si on est aussi dans un vrai groupe
  // sans droits modif (sinon on casserait son verrou groupe).
  const estDansGroupeAvecRestrictions =
    typeof window.groupeJoined === "function" && window.groupeJoined() &&
    typeof window.groupeCanEdit === "function" && !window.groupeCanEdit();

  if (!aideLinuxEstProf && !estDansGroupeAvecRestrictions) {
    if (typeof window.unlockPageNavigation === "function") {
      window.unlockPageNavigation();
    }
  }

  aideLinuxConnecte            = false;
  window.__aideConnecte        = false;
  aideLinuxEstProf             = false;
  aideLinuxCodeAide            = "";
  aideLinuxPseudo              = "";
  aideLinuxEleveActif          = null;
  aideLinuxToastAttenteMontre  = false;
  aideLinuxChangementPageInitieParProf = false;

  clearChatAideLinux();
  hideChatZoneAideLinux();
  hideFauxTerminalLinux();
  audioAideLinux_cleanup();
}

/* ================================
   ENVOI MESSAGE CHAT
================================ */
async function envoyerMessageAideLinux() {
  const input = getUI_aideLinux("aideChatInput");
  if (!input) return;
  const texte = input.value.trim();
  if (!texte) return;

  const sock = getSocketAideLinux();
  if (!sock) return;

  input.disabled = true;
  try {
    sock.emit("aide_linux_send_chat", { text: texte });
    input.value = "";
  } finally {
    input.disabled = false;
    input.focus();
  }
}

/* ================================
   INIT — DOMContentLoaded
================================ */
document.addEventListener("DOMContentLoaded", () => {

  getUI_aideLinux("aideBtnConnexion")?.addEventListener("click", () => {
    const role = document.querySelector('input[name="aideRole"]:checked')?.value ?? "eleve";
    if (role === "prof") connexionProf_aideLinux();
    else                 connexionEleve_aideLinux();
  });

  getUI_aideLinux("aideBtnQuitterProf")?.addEventListener("click", () => {
    if (confirm("Terminer la session d'aide ? Tous les élèves seront déconnectés.")) {
      deconnexionProf_aideLinux();
    }
  });

  getUI_aideLinux("aideBtnQuitterEleve")?.addEventListener("click", () => {
    deconnexionEleve_aideLinux();
  });

  getUI_aideLinux("aideBtnTerminer")?.addEventListener("click", () => {
    if (aideLinuxEleveActif) cloturerEleveActif_aideLinux(aideLinuxEleveActif);
  });

  getUI_aideLinux("aideSelectEleve")?.addEventListener("change", async (e) => {
    const pseudoChoisi = e.target.value;
    if (!pseudoChoisi) return;

    if (aideLinuxEleveActif && aideLinuxEleveActif !== pseudoChoisi) {
      await cloturerEleveActif_aideLinux(aideLinuxEleveActif);
    }

    const sock = getSocketAideLinux();
    if (!sock) return;

    aideLinuxEleveActif = pseudoChoisi;

    // Couper le micro du prof au changement d'élève
    aideLinuxIsSpeaking = false;
    if (aideLinuxLocalStream) {
      aideLinuxLocalStream.getTracks().forEach(t => { t.enabled = false; });
    }
    audioAideLinux_stopSession();
    audioAideLinux_updateUI();

    clearChatAideLinux();
    showChatZoneAideLinux();
    showFauxTerminalLinux(pseudoChoisi);
    setStatutAideLinux("Connexion avec " + pseudoChoisi + "…", "ok");

    sock.emit("aide_linux_activer_eleve", { pseudo_eleve: pseudoChoisi });
    // PROMPT NEUF : une fois la session établie côté serveur, le prof
    // envoie un Ctrl+C dans le terminal de l'élève. Cela annule la ligne
    // en cours (sans l'exécuter) et fait afficher un prompt neuf, visible
    // côté prof comme côté élève. Le délai laisse au serveur le temps de
    // router l'élève en statut "actif".
    setTimeout(() => {
      if (!aideLinuxConnecte || !aideLinuxEstProf) return;
      if (aideLinuxEleveActif !== pseudoChoisi) return;  // l'élève a changé entre-temps
      const s = getSocketAideLinux();
      if (s && s.connected) {
        s.emit("aide_linux_input", "\x03");   // Ctrl+C
       
      }
    }, 400);
  });

  getUI_aideLinux("aideBtnEnvoyerMsg")?.addEventListener("click", envoyerMessageAideLinux);
  getUI_aideLinux("aideChatInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); envoyerMessageAideLinux(); }
  });

  // Navigation pages (boutons bas de page) — snapshot / set_page
  attachPageNavListenerAideLinux();

  showPanelConnexionAideLinux();
  setStatutAideLinux("", "info");
});

/* ================================
   SENDBEACON SUR PAGEHIDE/BEFOREUNLOAD
   Déconnexion propre côté serveur
================================ */
function aideLinuxSendBeaconLeave() {
  if (!aideLinuxConnecte) return;
  const sock = getSocketAideLinux();
  if (sock) sock.emit("aide_linux_leave");
}

window.addEventListener("pagehide",     aideLinuxSendBeaconLeave);
window.addEventListener("beforeunload", aideLinuxSendBeaconLeave);

/* ═══════════════════════════════════════════════════════════════════════
   ═══════════════════════════════════════════════════════════════════════
   AUDIO WebRTC — AIDE LINUX
   Calqué fidèlement sur audioAide_* de SOCKET_connexion_aide.js Python
   Tous les events portent le suffixe "_aide_linux" pour isolation totale.
   ═══════════════════════════════════════════════════════════════════════
   ═══════════════════════════════════════════════════════════════════════ */

async function audioAideLinux_getStream() {
  if (aideLinuxLocalStream) return aideLinuxLocalStream;
  try {
    aideLinuxLocalStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    aideLinuxLocalStream.getTracks().forEach(t => { t.enabled = false; });
    return aideLinuxLocalStream;
  } catch (e) {
    console.warn("[audio-aide-linux] Pas d'accès micro :", e.message);
    aideLinuxLocalStream = null;
    return null;
  }
}

async function audioAideLinux_createPeer(toSocketId, initier) {
  const sock = getSocketAideLinux();
  if (!sock) return null;

  if (aideLinuxPeerConn) audioAideLinux_closePeer();

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });
  aideLinuxPeerConn     = pc;
  aideLinuxRemotePeerId = toSocketId;

  if (aideLinuxLocalStream) {
    aideLinuxLocalStream.getTracks().forEach(t => {
      t.enabled = false;
      pc.addTrack(t, aideLinuxLocalStream);
    });
  }

  pc.ontrack = (event) => {
    let el = document.getElementById("audio_aide_linux_remote");
    if (!el) {
      el = document.createElement("audio");
      el.id       = "audio_aide_linux_remote";
      el.autoplay = true;
      document.body.appendChild(el);
    }
    el.srcObject = event.streams[0];
  };

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    sock.emit("webrtc_ice_aide_linux", {
      targetId:  toSocketId,
      candidate: event.candidate,
      fromId:    sock.id
    });
  };

  if (initier) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sock.emit("webrtc_offer_aide_linux", {
      targetId: toSocketId,
      sdp:      pc.localDescription,
      fromId:   sock.id
    });
  }

  return pc;
}

function audioAideLinux_closePeer() {
  if (aideLinuxPeerConn) {
    aideLinuxPeerConn.close();
    aideLinuxPeerConn     = null;
    aideLinuxRemotePeerId = null;
  }
  const el = document.getElementById("audio_aide_linux_remote");
  if (el) el.remove();
}

async function audioAideLinux_startSession(remoteSocketId, jeInitie) {
  aideLinuxSessionActive = true;
  aideLinuxIsSpeaking    = false;

  const stream = await audioAideLinux_getStream();
  if (!stream) {
    console.warn("[audio-aide-linux] Pas de micro disponible.");
    return;
  }

  await audioAideLinux_createPeer(remoteSocketId, jeInitie);
  audioAideLinux_updateUI();
}

function audioAideLinux_stopSession() {
  aideLinuxSessionActive  = false;
  aideLinuxIsSpeaking     = false;
  aideLinuxEleveSocketId  = null;
  aideLinuxProfSocketId   = null;

  if (aideLinuxLocalStream) {
    aideLinuxLocalStream.getTracks().forEach(t => { t.enabled = false; });
  }
  audioAideLinux_closePeer();
  audioAideLinux_updateUI();
}

async function audioAideLinux_toggleSpeak() {
  if (!aideLinuxLocalStream) return;
  if (!aideLinuxEstProf && !aideLinuxSessionActive) return;

  aideLinuxIsSpeaking = !aideLinuxIsSpeaking;

  aideLinuxLocalStream.getTracks().forEach(t => {
    t.enabled = aideLinuxIsSpeaking;
  });

  audioAideLinux_updateUI();
}

function audioAideLinux_cleanup() {
  audioAideLinux_stopSession();
  if (aideLinuxLocalStream) {
    aideLinuxLocalStream.getTracks().forEach(t => t.stop());
    aideLinuxLocalStream = null;
  }
  aideLinuxIsSpeaking = false;
  audioAideLinux_updateUI();
}

function audioAideLinux_updateUI() {
  const btn  = document.getElementById("audioBtnAide");
  const zone = document.getElementById("audioAideZone");
  if (!zone) return;

  if (!aideLinuxConnecte) {
    zone.style.display = "none";
    return;
  }

  if (aideLinuxEstProf) {
    zone.style.display = "";
    if (!btn) return;
    btn.style.display  = "inline-block";
    btn.disabled       = false;
    if (!aideLinuxLocalStream) {
      btn.textContent = "🎤 Activer le micro";
    } else {
      btn.textContent = aideLinuxIsSpeaking ? "🔴 Je parle…" : "🎤 Prendre la parole";
    }
  } else {
    if (!btn) return;
    if (!aideLinuxSessionActive) {
      zone.style.display = "none";
      btn.style.display  = "none";
    } else {
      zone.style.display = "";
      btn.style.display  = "inline-block";
      btn.disabled       = false;
      btn.textContent    = aideLinuxIsSpeaking ? "🔴 Je parle…" : "🎤 Prendre la parole";
    }
  }
}

/* ================================
   LISTENERS SOCKET WebRTC AUDIO
================================ */
document.addEventListener("DOMContentLoaded", () => {
  // Attendre que le socket soit créé
  function waitSock(n) {
    if (n <= 0) return;
    const sock = getSocketAideLinux();
    if (!sock) { setTimeout(() => waitSock(n - 1), 200); return; }

    sock.on("webrtc_offer_aide_linux", async (data) => {
      if (!aideLinuxConnecte) return;
      const { fromId, sdp } = data;
      const pc = await audioAideLinux_createPeer(fromId, false);
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sock.emit("webrtc_answer_aide_linux", {
        targetId: fromId,
        sdp:      pc.localDescription,
        fromId:   sock.id
      });
    });

    sock.on("webrtc_answer_aide_linux", async (data) => {
      if (!aideLinuxConnecte || !aideLinuxPeerConn) return;
      await aideLinuxPeerConn.setRemoteDescription(new RTCSessionDescription(data.sdp));
    });

    sock.on("webrtc_ice_aide_linux", async (data) => {
      if (!aideLinuxConnecte || !aideLinuxPeerConn) return;
      try {
        await aideLinuxPeerConn.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (e) {
        console.warn("[audio-aide-linux] ICE ignoré :", e.message);
      }
    });

    /* Prof reçoit l'ID de l'élève → démarre la session */
    sock.on("aide_linux_audio_eleve_id", async (data) => {
      if (!aideLinuxConnecte || !aideLinuxEstProf) return;
      aideLinuxEleveSocketId = data.eleveSocketId;
      sock.emit("aide_linux_audio_session_start", { eleveSocketId: aideLinuxEleveSocketId });
      await new Promise(r => setTimeout(r, 300));
      await audioAideLinux_startSession(aideLinuxEleveSocketId, true);
    });

    /* Élève reçoit l'ID du prof → démarre la session */
    sock.on("aide_linux_audio_prof_id", async (data) => {
      if (!aideLinuxConnecte || aideLinuxEstProf) return;
      aideLinuxProfSocketId = data.profSocketId;
    });

    sock.on("aide_linux_audio_session_start", async (data) => {
      if (!aideLinuxConnecte || aideLinuxEstProf) return;
      aideLinuxProfSocketId = data.profSocketId;
      await audioAideLinux_startSession(data.profSocketId, false);
    });
  }
  waitSock(25);

  // Bouton micro
  const btn = document.getElementById("audioBtnAide");
  if (btn) {
    btn.addEventListener("click", async () => {
      if (!aideLinuxConnecte) return;
      await audioAideLinux_toggleSpeak();
    });
  }
});

/* Exposer la cleanup pour les autres scripts si besoin */
window.__audioAideLinuxCleanup = audioAideLinux_cleanup;