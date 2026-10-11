/* =========================================================

   connexion_aide.js
   -----------------
   Fonctionnalité "Demander de l'aide"
   Version WebSocket — dissociée de connexion.js

   Le socket est partagé avec connexion.js via window._dariushSocket.
   Tous les événements aide sont préfixés "aide_".
   Room serveur : "aide_<code_aide>"

   ========================================================= */

/* ================================
   CONFIG
================================ */
const AIDE_HEARTBEAT_MS = 20000;

/* ================================
   ÉTAT GLOBAL
================================ */
let aideConnecte_aide            = false;
let aideEstProf_aide             = false;
let aideCodeAide_aide            = "";
let aidePseudo_aide              = "";
let aideEleveActif_aide          = null;
let aideSnapshotEnvoye_aide      = false;
let aideSnapshotRecu_aide        = false;
let aideDeconnexionManuelle_aide = false;
let aideIsSendingSnapshot_aide   = false;
let aideToastAttenteMontre_aide  = false;
let aideToastTimer_aide          = null;
let aideDernierCodeEnvoye_aide   = null;
let aideApplyingRemote_aide      = false;
let aideSendTimer_aide           = null;
let aideHeartbeatTimer_aide      = null;
let aideChangementPageInitiéParProf_aide = false;
let aideEleveDansGroupe_aide     = false;
let aideCursorWidget_aide = null;

/* ================================
   ACCÈS AU SOCKET PARTAGÉ
================================ */
function getSocketAide() {
  return window._dariushSocket || null;
}

/* ================================
   TOAST AU-DESSUS DU BOUTON AIDE
================================ */
function showToastAide(message, duration = 6000) {
  const toast = document.getElementById("aideToast");
  if (!toast) return;

  toast.textContent = message;
  toast.classList.add("visible");

  if (aideToastTimer_aide) clearTimeout(aideToastTimer_aide);
  aideToastTimer_aide = setTimeout(() => {
    toast.classList.remove("visible");
    aideToastTimer_aide = null;
  }, duration);

  toast.onclick = () => {
    toast.classList.remove("visible");
    document.getElementById("panneauAide")?.classList.add("group-open");
  };
}

/* ================================
   DOUBLE CONNEXION : colorations
================================ */
function mettreAJourContexteVisuel_aide() {
  const doubleConnexion = aideConnecte_aide &&
    typeof window.groupeJoined === "function" &&
    window.groupeJoined();

  ajusterPastille_aide("boutonmenuconnexion", "bleu",   doubleConnexion);
  ajusterPastille_aide("boutonAide",          "orange", doubleConnexion);
  ajusterPastille_aide("groupChatSendBtn",    "bleu",   doubleConnexion);
  ajusterPastille_aide("aideBtnEnvoyerMsg",   "orange", doubleConnexion);
}

function ajusterPastille_aide(btnId, couleur, visible) {
  const btn = document.getElementById(btnId);
  if (!btn) return;

  const existante = btn.querySelector(".btn-pastille");

  if (visible && !existante) {
    const p = document.createElement("span");
    p.className = `btn-pastille btn-pastille-${couleur}`;
    btn.appendChild(p);
  } else if (!visible && existante) {
    existante.remove();
  }
}

/* ================================
   ACCÈS ÉDITEUR
================================ */
function getEditorAide() {
  return window.pythonEditor || null;
}

function getTextAide() {
  const ed = getEditorAide();
  if (ed) return ed.getValue();
  const ta = document.getElementById("codeEditor");
  return ta ? ta.value : "";
}

/* ================================
   SNAPSHOT ÉLÈVE → PROF
   Envoie le notebook complet + numéro de page active
   + flag indiquant si l'élève est dans un groupe
================================ */
async function sendSnapshotAide() {
  if (aideIsSendingSnapshot_aide) return;
  if (typeof window.buildLink !== "function") {
    console.warn("[aide] buildLink introuvable, snapshot impossible.");
    return;
  }

  aideIsSendingSnapshot_aide = true;

  try {
    if (window.PagesMultiples?.saveActivePageFromEditor) {
      window.PagesMultiples.saveActivePageFromEditor();
    }

    const snapshotUrl = await window.buildLink({ askDate: false });
    if (!snapshotUrl) return;

    const activeIndex = window.PagesMultiples?.getActivePageIndex?.() ?? 0;

    const sock = getSocketAide();
    if (!sock) return;

    sock.emit("aide_push_snapshot", {
      snapshot:          snapshotUrl,
      active_page_index: activeIndex,
      eleve_dans_groupe: typeof window.groupeJoined === "function" && window.groupeJoined()
    });

    console.log("[aide] Snapshot envoyé au prof, page active :", activeIndex);

  } catch (e) {
    console.warn("[aide] sendSnapshotAide :", e);
  } finally {
    aideIsSendingSnapshot_aide = false;
  }
}

/* ================================
   SNAPSHOT PROF ← ÉLÈVE
================================ */
async function applySnapshotAide(snapshotUrl, indexActif = 0) {
  if (!snapshotUrl) return;

  if (typeof window.decode_url !== "function") {
    console.warn("[aide] decode_url non disponible, snapshot ignoré.");
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
      console.warn("[aide] decode_url a retourné false.");
    }
  } catch (e) {
    console.error("[aide] Erreur application snapshot :", e);
  }
}

/* ================================
   ÉDITEUR : listener changement de code
   Flag sur l'éditeur lui-même pour ne poser
   le listener qu'une seule fois.
================================ */
function attachEditorListenerAide() {
  const ed = getEditorAide();
  if (!ed) return;
  if (ed.__aideListenerAttached) return;
  ed.__aideListenerAttached = true;

  ed.on("change", () => {
    if (!aideConnecte_aide) return;
    if (aideApplyingRemote_aide) return;

    clearTimeout(aideSendTimer_aide);
    aideSendTimer_aide = setTimeout(() => {
      const code = getTextAide();
      if (code === aideDernierCodeEnvoye_aide) return;
      aideDernierCodeEnvoye_aide = code;

      const sock = getSocketAide();
      if (!sock) return;

      sock.emit("aide_send_code", {
        contenu: code,
        auteur:  aideEstProf_aide ? "prof" : "eleve"
      });
    }, 300);
  });
}

/* ================================
   NAVIGATION PAGES — BOUTONS BAS DE PAGE
   Branché une seule fois au DOMContentLoaded.
   - Si prof et élève PAS dans un groupe : émet aide_set_page
   - Si élève sans groupe : envoie son snapshot
   - Si élève dans un groupe : boutons cachés par connexion.js, rien à faire
================================ */
function attachPageNavListenerAide() {
  const btnPrev = document.getElementById("bottomPrevPageButton");
  const btnNext = document.getElementById("bottomNextPageButton");

  const onNav = () => {
    if (!aideConnecte_aide) return;

    setTimeout(() => {
      const pageIndex = window.PagesMultiples?.getActivePageIndex?.() ?? 0;
      const sock = getSocketAide();
      if (!sock) return;

      if (aideEstProf_aide) {
        if (!aideEleveActif_aide) return;
        // Si l'élève est dans un groupe, les boutons sont cachés → ce code ne s'exécute jamais
        // mais on garde le guard par sécurité
        if (aideEleveDansGroupe_aide) return;
        aideChangementPageInitiéParProf_aide = true;
        sock.emit("aide_set_page", { page_index: pageIndex });
      } else {
        // Élève sans groupe → envoie son snapshot
        if (!window.groupeJoined || !window.groupeJoined()) {
          sendSnapshotAide();
        }
      }
    }, 100);
  };

  btnPrev?.addEventListener("click", onNav);
  btnNext?.addEventListener("click", onNav);
}

/* ================================
   BLOCAGE NAVIGATION PROF
   Quand l'élève est dans un groupe, on cache
   les boutons de navigation côté prof.
   Un bouton caché ne peut pas être cliqué.
================================ */
function lockPageNavAide() {
  const btnPrev = document.getElementById("bottomPrevPageButton");
  const btnNext = document.getElementById("bottomNextPageButton");
  if (btnPrev) btnPrev.style.display = "none";
  if (btnNext) btnNext.style.display = "none";
}

function unlockPageNavAide() {
  const btnPrev = document.getElementById("bottomPrevPageButton");
  const btnNext = document.getElementById("bottomNextPageButton");
  if (btnPrev) btnPrev.style.display = "";
  if (btnNext) btnNext.style.display = "";
}

/* ================================
   UI
================================ */
function getUI_aide(id) {
  return document.getElementById(id);
}

function setStatutAide(msg, type = "info") {
  const el = getUI_aide("aideStatut");
  if (!el) return;
  el.textContent = msg;
  el.className   = "group-msg-muted";
  if (type === "warn")    el.style.color = "#a66a00";
  else if (type === "ok") el.style.color = "#0a7a31";
  else                    el.style.color = "#555";
}

function showChatZoneAide() {
  const zone = getUI_aide("aideChatZone");
  if (zone) zone.style.display = "";
}

function hideChatZoneAide() {
  const zone = getUI_aide("aideChatZone");
  if (zone) zone.style.display = "none";
}

function updateChatAide(messages) {
  const chat = getUI_aide("aideChatMessages");
  if (!chat) return;

  if (!Array.isArray(messages) || messages.length === 0) {
    chat.value = "";
    return;
  }

  const lines = messages.map(m => {
    const time = m.created_at ? m.created_at.substring(11, 16) : "";
    return `[${time}] ${m.pseudo} : ${m.text}`;
  }).join("\n");

  if (chat.dataset.last === lines) return;
  chat.dataset.last = lines;
  chat.value = lines;
  chat.scrollTop = chat.scrollHeight;
}

function clearChatAide() {
  const chat = getUI_aide("aideChatMessages");
  if (chat) { chat.value = ""; chat.dataset.last = ""; }
}

function renderFileAttente_aide(file) {
  const el = getUI_aide("aideFileAttente");
  if (!el) return;
  if (!file || file.length === 0) {
    el.innerHTML = "<em>Aucun élève en attente.</em>";
    return;
  }
  el.innerHTML = file.map((m, i) => {
    const actif = m.statut === "actif" ? " <strong>(en cours)</strong>" : "";
    return `<div>${i + 1}. ${m.pseudo_eleve}${actif}</div>`;
  }).join("");
}

function renderSelectEleves_aide(file) {
  const sel = getUI_aide("aideSelectEleve");
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">-- Choisir un élève --</option>';
  file.forEach(m => {
    const opt = document.createElement("option");
    opt.value       = m.pseudo_eleve;
    opt.textContent = m.pseudo_eleve;
    sel.appendChild(opt);
  });
  if (current && [...sel.options].some(o => o.value === current)) {
    sel.value = current;
  }
}

/* ================================
   PANELS
================================ */
function showPanelConnexionAide() {
  if (getUI_aide("aidePanelConnexion")) getUI_aide("aidePanelConnexion").style.display = "";
  if (getUI_aide("aidePanelProf"))      getUI_aide("aidePanelProf").style.display      = "none";
  if (getUI_aide("aidePanelEleve"))     getUI_aide("aidePanelEleve").style.display     = "none";
  hideChatZoneAide();
  audioAide_updateUI();
}

function showPanelProfAide() {
  if (getUI_aide("aidePanelConnexion")) getUI_aide("aidePanelConnexion").style.display = "none";
  if (getUI_aide("aidePanelProf"))      getUI_aide("aidePanelProf").style.display      = "";
  if (getUI_aide("aidePanelEleve"))     getUI_aide("aidePanelEleve").style.display     = "none";
  hideChatZoneAide();
  mettreAJourContexteVisuel_aide();
  audioAide_updateUI();
  audioAide_initMicPermission();
}

function showPanelEleveAide() {
  if (getUI_aide("aidePanelConnexion")) getUI_aide("aidePanelConnexion").style.display = "none";
  if (getUI_aide("aidePanelProf"))      getUI_aide("aidePanelProf").style.display      = "none";
  if (getUI_aide("aidePanelEleve"))     getUI_aide("aidePanelEleve").style.display     = "";
  hideChatZoneAide();
  mettreAJourContexteVisuel_aide();
  audioAide_updateUI();
  audioAide_initMicPermission();
}

/* ================================
   HEARTBEAT
================================ */
function startHeartbeatAide() {
  stopHeartbeatAide();
  aideHeartbeatTimer_aide = setInterval(() => {
    if (!aideConnecte_aide) return;
    const sock = getSocketAide();
    if (sock) sock.emit("aide_heartbeat");
  }, AIDE_HEARTBEAT_MS);
}

function stopHeartbeatAide() {
  if (aideHeartbeatTimer_aide) {
    clearInterval(aideHeartbeatTimer_aide);
    aideHeartbeatTimer_aide = null;
  }
}

/* ================================
   CONNEXION PROF
================================ */
async function connexionProf_aide() {
  const pseudo = (getUI_aide("aidePseudoInput")?.value ?? "").trim();
  const code   = (getUI_aide("aideCodeInput")?.value ?? "").trim();

  if (!pseudo) { setStatutAide("Entrez un pseudo.", "warn"); return; }
  if (!code)   { setStatutAide("Entrez un code d'aide.", "warn"); return; }
  if (code.length < 6) { setStatutAide("Le code doit faire au moins 6 caractères.", "warn"); return; }

  const sock = getSocketAide();
  if (!sock || !sock.connected) {
    setStatutAide("Serveur non disponible. Rechargez la page.", "warn");
    return;
  }

  setStatutAide("Connexion…", "info");

  sock.once("aide_join_result", (data) => {
    if (!data.ok) {
      setStatutAide("Erreur : " + data.error, "warn");
      return;
    }

    aideConnecte_aide            = true;
    window.__aideConnecte        = true;
    aideEstProf_aide             = true;
    aideCodeAide_aide            = code;
    aidePseudo_aide              = pseudo;
    aideEleveActif_aide          = null;
    aideDeconnexionManuelle_aide = false;

    showPanelProfAide();
    setStatutAide("Session démarrée. En attente d'élèves…", "info");

    if (data.queue && data.queue.length > 0) {
      renderSelectEleves_aide(data.queue);
      renderFileAttente_aide(data.queue);
      const enAttente = data.queue.filter(m => m.statut === "attente").length;
      if (enAttente > 0) {
        showToastAide(
          enAttente === 1
            ? "1 élève attend votre aide — cliquez pour le sélectionner"
            : `${enAttente} élèves attendent votre aide — cliquez pour en sélectionner un`
        );
      }
    }

    startHeartbeatAide();
    attachSocketListenersAide();
  });

  sock.emit("aide_join_prof", { code_aide: code, pseudo_prof: pseudo });
}

/* ================================
   CONNEXION ÉLÈVE
================================ */
async function connexionEleve_aide() {
  const pseudo = (getUI_aide("aidePseudoInput")?.value ?? "").trim();
  const code   = (getUI_aide("aideCodeInput")?.value ?? "").trim();

  if (!pseudo) { setStatutAide("Entrez un pseudo.", "warn"); return; }
  if (!code)   { setStatutAide("Entrez un code d'aide.", "warn"); return; }

  if (typeof window.groupeJoined === "function" && window.groupeJoined()) {
    if (typeof window.groupeCanEdit === "function" && !window.groupeCanEdit()) {
      setStatutAide(
        "Vous êtes connecté à un groupe sans droits de modification. " +
        "Demandez l'autorisation à votre professeur avant de demander de l'aide.",
        "warn"
      );
      return;
    }
  }

  const sock = getSocketAide();
  if (!sock || !sock.connected) {
    setStatutAide("Serveur non disponible. Rechargez la page.", "warn");
    return;
  }

  setStatutAide("Connexion…", "info");

  sock.once("aide_join_result", (data) => {
    if (!data.ok) {
      setStatutAide("Erreur : " + data.error, "warn");
      return;
    }

    aideConnecte_aide            = true;
    window.__aideConnecte        = true;
    aideEstProf_aide             = false;
    aideCodeAide_aide            = code;
    aidePseudo_aide              = pseudo;
    aideSnapshotEnvoye_aide      = false;
    aideDeconnexionManuelle_aide = false;

    const rang  = data.rang  || 1;
    const total = data.total || 1;

    showPanelEleveAide();
    setStatutAide(
      `Vous avez sollicité une aide à votre professeur. ` +
      `Veuillez patienter, vous êtes ${rang}${rang === 1 ? "er" : "ème"} ` +
      `sur ${total} en file d'attente.`,
      "info"
    );

    startHeartbeatAide();
    attachSocketListenersAide();
  });

  sock.emit("aide_join_eleve", { code_aide: code, pseudo_eleve: pseudo });
}

/* ================================
   BRANCHEMENT DES ÉVÉNEMENTS SOCKET AIDE
================================ */
function attachSocketListenersAide() {
  const sock = getSocketAide();
  if (!sock) return;

  sock.on("aide_queue_update",      onAideQueueUpdate);
  sock.on("aide_actif_update",      onAideActifUpdate);
  sock.on("aide_snapshot_received", onAideSnapshotReceived);
  sock.on("aide_code_update",       onAideCodeUpdate);
  sock.on("aide_chat_update",       onAideChatUpdate);
  sock.on("aide_prof_disconnected", onAideProfDisconnected);
  sock.on("aide_session_closed",    onAideSessionClosed);
  sock.on("aide_page_update",       onAidePageUpdate);
  sock.on("aide_cursor_update", onAideCursorUpdate);
}

function offSocketListenersAide() {
  const sock = getSocketAide();
  if (!sock) return;

  sock.off("aide_queue_update",      onAideQueueUpdate);
  sock.off("aide_actif_update",      onAideActifUpdate);
  sock.off("aide_snapshot_received", onAideSnapshotReceived);
  sock.off("aide_code_update",       onAideCodeUpdate);
  sock.off("aide_chat_update",       onAideChatUpdate);
  sock.off("aide_prof_disconnected", onAideProfDisconnected);
  sock.off("aide_session_closed",    onAideSessionClosed);
  sock.off("aide_page_update",       onAidePageUpdate);
  sock.off("aide_cursor_update", onAideCursorUpdate);
}

/* ================================
   HANDLERS SOCKET AIDE
================================ */

function onAideQueueUpdate(data) {
  if (!aideEstProf_aide) return;

  const file = data.queue || [];
  renderSelectEleves_aide(file);
  renderFileAttente_aide(file);

  const enAttente = file.filter(m => m.statut === "attente").length;
  if (enAttente > 0) {
    showToastAide(
      enAttente === 1
        ? "1 élève attend votre aide — cliquez pour le sélectionner"
        : `${enAttente} élèves attendent votre aide — cliquez pour en sélectionner un`
    );
  }

  if (aideEleveActif_aide) {
    const encorePresent = file.some(m => m.pseudo_eleve === aideEleveActif_aide);
    if (!encorePresent) {
      aideEleveActif_aide        = null;
      aideSnapshotRecu_aide      = false;
      aideDernierCodeEnvoye_aide = null;
      clearChatAide();
      hideChatZoneAide();
      setStatutAide("L'élève a mis fin à la connexion. En attente d'un nouvel élève…", "warn");
    }
  }
}

function onAideActifUpdate(data) {
  if (aideEstProf_aide) return;
  if (aideSnapshotEnvoye_aide) return;

  aideSnapshotEnvoye_aide = true;
  showChatZoneAide();
  setStatutAide("Votre professeur est connecté sur votre écran.", "ok");
  showToastAide("Votre professeur est connecté sur votre écran. 🎓");
  attachEditorListenerAide();
  attachCursorListenerAide();

  // Verrouillage navigation : on emprunte la mécanique du groupe.
  // Pose __groupNavLocked qui est respecté par updateBottomPageNav
  // (interpreteur.js) et par isNavigationAllowed (pageScrollbar.js).
  // L'élève actif ne peut plus naviguer, seul le prof pilote.
  if (typeof lockPageNavigation === "function") {
    window.lockPageNavigation();
  }

  sendSnapshotAide();
}

async function onAideSnapshotReceived(data) {
  if (!aideEstProf_aide) return;

  if (aideChangementPageInitiéParProf_aide) {
    aideChangementPageInitiéParProf_aide = false;
    return;
  }

  const { pseudo_eleve, snapshot, active_page_index } = data;

  if (pseudo_eleve && pseudo_eleve !== aideEleveActif_aide) {
    aideEleveActif_aide = pseudo_eleve;
    clearChatAide();
    showChatZoneAide();
    attachEditorListenerAide();
  }

  // Toujours brancher le curseur (flag interne évite le double branchement)
  attachCursorListenerAide();

  aideEleveDansGroupe_aide = !!data.eleve_dans_groupe;

  if (aideEleveDansGroupe_aide) {
    lockPageNavAide();
    setStatutAide("Aide en cours — navigation bloquée : l'élève est dans un groupe.", "warn");
  } else {
    unlockPageNavAide();
    setStatutAide("Code de l'élève chargé. Aide en cours.", "ok");
  }

  const pageIndex = active_page_index ?? 0;
  await applySnapshotAide(snapshot, pageIndex);
}
function onAideCodeUpdate(data) {
  const { contenu, auteur } = data;

  if (aideEstProf_aide  && auteur !== "eleve") return;
  if (!aideEstProf_aide && auteur !== "prof")  return;

  const ed = getEditorAide();
  if (!ed) return;
  if (ed.getValue() === contenu) return;

  aideApplyingRemote_aide    = true;
  aideDernierCodeEnvoye_aide = contenu;
  ed.setValue(contenu);
  aideApplyingRemote_aide    = false;
}

function onAideChatUpdate(data) {
  updateChatAide(data.messages || []);
}

/* ================================
   CHANGEMENT DE PAGE
   Reçu par l'élève quand le prof change de page.
   L'élève navigue puis renvoie son snapshot.
================================ */
async function onAidePageUpdate(data) {
  if (aideEstProf_aide) return;

  const { page_index } = data;
  if (!window.PagesMultiples) return;

  const pages    = window.PagesMultiples.getAllPages() || [];
  const safeIndex = Math.min(page_index, pages.length - 1);

  window.PagesMultiples.setAllPages(pages, safeIndex);

  await new Promise(r => setTimeout(r, 150));
  await sendSnapshotAide();
}

function onAideProfDisconnected(data) {
  if (aideEstProf_aide) return;

  stopHeartbeatAide();
  offSocketListenersAide();
  resetEtatAide();
  showPanelConnexionAide();
  setStatutAide("Le professeur a mis fin à son intervention. Connexion terminée.", "warn");
  showToastAide("Votre professeur a mis fin à la session d'aide.", 8000);
}

function onAideSessionClosed(data) {
  if (aideEstProf_aide) return;

  stopHeartbeatAide();
  offSocketListenersAide();

  const sock = getSocketAide();
  if (sock) sock.emit("aide_leave");

  resetEtatAide();
  showPanelConnexionAide();
  setStatutAide("La session d'aide est terminée.", "info");
  showToastAide("Votre session d'aide est terminée.", 6000);
}

/* ================================
   DÉCONNEXION PROF
================================ */
async function deconnexionProf_aide() {
  aideDeconnexionManuelle_aide = true;
  stopHeartbeatAide();
  offSocketListenersAide();

  const sock = getSocketAide();
  if (sock) sock.emit("aide_leave");

  resetEtatAide();
  showPanelConnexionAide();
  setStatutAide("Session terminée.", "info");
}

/* ================================
   DÉCONNEXION ÉLÈVE
================================ */
async function deconnexionEleve_aide() {
  aideDeconnexionManuelle_aide = true;
  stopHeartbeatAide();
  offSocketListenersAide();

  const sock = getSocketAide();
  if (sock) sock.emit("aide_leave");

  resetEtatAide();
  showPanelConnexionAide();
  setStatutAide("Déconnecté.", "info");
}

/* ================================
   CLÔTURE ÉLÈVE ACTIF (côté prof)
================================ */
async function cloturerEleveActif_aide(pseudoEleve) {
  if (!pseudoEleve) return;

  const sock = getSocketAide();
  if (sock) sock.emit("aide_cloturer", { pseudo_eleve: pseudoEleve });

  aideEleveActif_aide          = null;
  aideSnapshotRecu_aide        = false;
  aideDernierCodeEnvoye_aide   = null;
  clearChatAide();
  hideChatZoneAide();
  setStatutAide("Aide terminée. En attente d'un nouvel élève…", "info");
}

/* ================================
   RESET ÉTAT
================================ */
function resetEtatAide() {
  // Si on est un élève actif en aide (donc qui avait été verrouillé via
  // lockPageNavigation), on lève le verrou groupe AVANT de tout reset.
  // Le test : on était actif si snapshot avait été envoyé.
  // ATTENTION : ne lever le verrou que si on n'est PAS également connecté
  // à un vrai groupe en tant qu'élève (sinon on casserait son verrou groupe).
  const etaitEleveActifAide = !aideEstProf_aide && aideSnapshotEnvoye_aide;
  const estDansGroupeAvecRestrictions =
    typeof window.groupeJoined === "function" && window.groupeJoined() &&
    typeof window.groupeCanEdit === "function" && !window.groupeCanEdit();

  if (etaitEleveActifAide && !estDansGroupeAvecRestrictions) {
    if (typeof unlockPageNavigation === "function") {
      window.unlockPageNavigation();
    }
  }

  aideConnecte_aide            = false;
  window.__aideConnecte        = false;
  aideEstProf_aide             = false;
  aideCodeAide_aide            = "";
  aidePseudo_aide              = "";
  aideEleveActif_aide          = null;
  aideSnapshotEnvoye_aide      = false;
  aideSnapshotRecu_aide        = false;
  aideDernierCodeEnvoye_aide   = null;
  aideIsSendingSnapshot_aide   = false;
  aideToastAttenteMontre_aide  = false;
  aideChangementPageInitiéParProf_aide = false;
  aideEleveDansGroupe_aide     = false;
  if (aideCursorWidget_aide) {
    aideCursorWidget_aide.remove();
    aideCursorWidget_aide = null;
  }
  unlockPageNavAide();
  clearChatAide();
  hideChatZoneAide();
  mettreAJourContexteVisuel_aide();
}

/* ================================
   ENVOI MESSAGE CHAT
================================ */
async function envoyerMessageAide() {
  const input = getUI_aide("aideChatInput");
  if (!input) return;
  const texte = input.value.trim();
  if (!texte) return;

  const sock = getSocketAide();
  if (!sock) return;

  input.disabled = true;
  try {
    sock.emit("aide_send_chat", { text: texte });
    input.value = "";
  } finally {
    input.disabled = false;
    input.focus();
  }
}

/* ================================
   INIT
================================ */
document.addEventListener("DOMContentLoaded", () => {

  // Brancher la navigation pages une seule fois au chargement
  attachPageNavListenerAide();

  getUI_aide("aideBtnConnexion")?.addEventListener("click", () => {
    const role = document.querySelector('input[name="aideRole"]:checked')?.value ?? "eleve";
    if (role === "prof") connexionProf_aide();
    else                 connexionEleve_aide();
  });

  getUI_aide("aideBtnQuitterProf")?.addEventListener("click", () => {
    if (confirm("Terminer la session d'aide ? Tous les élèves seront déconnectés.")) {
      deconnexionProf_aide();
    }
  });

  getUI_aide("aideBtnQuitterEleve")?.addEventListener("click", () => {
    deconnexionEleve_aide();
  });

  getUI_aide("aideBtnTerminer")?.addEventListener("click", () => {
    if (aideEleveActif_aide) cloturerEleveActif_aide(aideEleveActif_aide);
  });

  getUI_aide("aideSelectEleve")?.addEventListener("change", async (e) => {
    const pseudoChoisi = e.target.value;
    if (!pseudoChoisi) return;

    if (aideEleveActif_aide && aideEleveActif_aide !== pseudoChoisi) {
      await cloturerEleveActif_aide(aideEleveActif_aide);
    }

    const sock = getSocketAide();
    if (!sock) return;

    aideEleveActif_aide   = pseudoChoisi;
    aideSnapshotRecu_aide = false;

    // Couper le micro du prof au changement d'élève
    audio_a_isSpeaking = false;
    if (audio_a_localStream) {
      audio_a_localStream.getTracks().forEach(t => { t.enabled = false; });
    }
    audioAide_stopSession();
    audioAide_updateUI();

    clearChatAide();
    showChatZoneAide();
    attachEditorListenerAide();
    setStatutAide("Connexion avec " + pseudoChoisi + "…", "ok");

    sock.emit("aide_activer_eleve", { pseudo_eleve: pseudoChoisi });
  });

  getUI_aide("aideBtnEnvoyerMsg")?.addEventListener("click", envoyerMessageAide);
  getUI_aide("aideChatInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); envoyerMessageAide(); }
  });

  showPanelConnexionAide();
  setStatutAide("", "info");
});


/* ================================
   CURSEUR PARTAGÉ
================================ */
function attachCursorListenerAide() {
  const ed = getEditorAide();
  if (!ed) return;
  if (ed.__aideCursorAttached) return;
  ed.__aideCursorAttached = true;

  const wrapper = ed.getWrapperElement();

 wrapper.addEventListener("mousedown", () => {
  if (!aideConnecte_aide) return;
  setTimeout(() => {
    const cursor = ed.getCursor();
    const sock = getSocketAide();
    if (sock) sock.emit("aide_cursor_show", { line: cursor.line, ch: cursor.ch });
    
    // Afficher aussi localement
    const role = aideEstProf_aide ? "prof" : "eleve";
    onAideCursorUpdate({ visible: true, line: cursor.line, ch: cursor.ch, role });
  }, 50);
});

wrapper.addEventListener("mouseup", () => {
  if (!aideConnecte_aide) return;
  const sock = getSocketAide();
  if (sock) sock.emit("aide_cursor_hide");
  
  // Cacher aussi localement
  onAideCursorUpdate({ visible: false });
});
}

function onAideCursorUpdate(data) {
  const ed = getEditorAide();
  if (!ed) return;

  if (aideCursorWidget_aide) {
    aideCursorWidget_aide.remove();
    aideCursorWidget_aide = null;
  }

  if (!data.visible) return;

  const circle = document.createElement("div");
  const color  = data.role === "prof" ? "255, 100, 0" : "0, 100, 255";
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
  aideCursorWidget_aide = circle;
}
/* ================================================================
   AUDIO WebRTC — AIDE
   Calqué exactement sur le bloc GROUPE.
   Préfixes : audio_a_ et audioAide_
   Pas d'extraPeers — seulement 2 participants.
================================================================ */

/* --------------------------------
   ÉTAT
-------------------------------- */
let audio_a_localStream   = null;
let audio_a_peerConn      = null;
let audio_a_remotePeerId  = null;
let audio_a_isSpeaking    = false;
let audio_a_sessionActive = false;
let audio_a_eleveSocketId = null;
let audio_a_profSocketId  = null;

/* --------------------------------
   STUN
-------------------------------- */
const audio_a_iceConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

/* --------------------------------
   OBTENIR LE MICRO
-------------------------------- */
async function audioAide_getStream() {
  if (audio_a_localStream) return audio_a_localStream;
  try {
    audio_a_localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    return audio_a_localStream;
  } catch (e) {
    console.warn("[audio-aide] Micro refusé :", e.message);
    return null;
  }
}

/* --------------------------------
   CRÉER LA CONNEXION
-------------------------------- */
async function audioAide_createPeer(toSocketId, initier) {
  audioAide_closePeer();

  const sock = window._dariushSocket;
  if (!sock) return null;

  const pc = new RTCPeerConnection(audio_a_iceConfig);
  pc.onconnectionstatechange = () => {
  if (pc.connectionState === "failed" && aideEstProf_aide) {
    alert("La connexion audio a échoué. Déconnectez-vous de l'aide et reconnectez-vous pour la relancer.");
  }
};
  audio_a_peerConn     = pc;
  audio_a_remotePeerId = toSocketId;

  if (audio_a_localStream) {
    audio_a_localStream.getTracks().forEach(t => {
      t.enabled = false;
      pc.addTrack(t, audio_a_localStream);
    });
  }

  pc.ontrack = (event) => {
    let el = document.getElementById("audio_a_remote");
    if (!el) {
      el = document.createElement("audio");
      el.id       = "audio_a_remote";
      el.autoplay = true;
      document.body.appendChild(el);
    }
    el.srcObject = event.streams[0];
  };

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    sock.emit("webrtc_ice_aide", {
      targetId:  toSocketId,
      candidate: event.candidate,
      fromId:    sock.id
    });
  };

  if (initier) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sock.emit("webrtc_offer_aide", {
      targetId: toSocketId,
      sdp:      pc.localDescription,
      fromId:   sock.id
    });
  }

  return pc;
}

/* --------------------------------
   FERMER LA CONNEXION
-------------------------------- */
function audioAide_closePeer() {
  if (audio_a_peerConn) {
    audio_a_peerConn.close();
    audio_a_peerConn     = null;
    audio_a_remotePeerId = null;
  }
  const el = document.getElementById("audio_a_remote");
  if (el) el.remove();
}

/* --------------------------------
   DÉMARRER SESSION
   Calqué sur audioGroupe_startSession
-------------------------------- */
async function audioAide_startSession(remoteSocketId, jeInitie) {
  audio_a_sessionActive = true;
  audio_a_isSpeaking    = false;

  const stream = await audioAide_getStream();
  if (!stream) {
    console.warn("[audio-aide] Pas de micro disponible.");
    return;
  }

  await audioAide_createPeer(remoteSocketId, jeInitie);
  audioAide_updateUI();

  const msg = aideEstProf_aide
    ? "L'élève peut prendre la parole. Son micro coupera le vôtre."
    : "Vous avez la parole. Appuyez sur 🎤 pour parler.";
  if (typeof showAideToast === "function") showAideToast(msg, "ok", 5000);
}

/* --------------------------------
   ARRÊTER SESSION
-------------------------------- */
function audioAide_stopSession() {
  audio_a_sessionActive = false;
  audio_a_isSpeaking    = false;
  audio_a_eleveSocketId = null;
  audio_a_profSocketId  = null;

  if (audio_a_localStream) {
    audio_a_localStream.getTracks().forEach(t => { t.enabled = false; });
  }

  audioAide_closePeer();
  audioAide_updateUI();
}

/* --------------------------------
   TOGGLE PAROLE
   Calqué sur audioGroupe_toggleSpeak
   La RTCPeerConnection est déjà créée
-------------------------------- */
async function audioAide_toggleSpeak() {
  if (!aideEstProf_aide && !audio_a_sessionActive) return;
  if (!audio_a_localStream) return;

  audio_a_isSpeaking = !audio_a_isSpeaking;

  audio_a_localStream.getTracks().forEach(t => {
    t.enabled = audio_a_isSpeaking;
  });

  window._dariushSocket.emit("audio_speaking_aide", {
    code_aide: aideCodeAide_aide,
    speaking:  audio_a_isSpeaking,
    role:      aideEstProf_aide ? "prof" : "student"
  });

  audioAide_updateUI();
}

/* --------------------------------
   NETTOYAGE COMPLET
-------------------------------- */
function audioAide_cleanup() {
  audioAide_stopSession();

  if (audio_a_localStream) {
    audio_a_localStream.getTracks().forEach(t => t.stop());
    audio_a_localStream = null;
  }

  audio_a_isSpeaking = false;
  audioAide_updateUI();
}

/* --------------------------------
   UI
-------------------------------- */
function audioAide_updateUI() {
  const btn  = document.getElementById("audioBtnAide");
  const zone = document.getElementById("audioAideZone");
  if (!zone) return;

  if (!aideConnecte_aide) {
    zone.style.display = "none";
    return;
  }

  if (aideEstProf_aide) {
    zone.style.display = "";
    if (!btn) return;
    btn.style.display  = "inline-block";
    btn.disabled       = false;
    btn.style.opacity  = "1";

    if (!audio_a_localStream) {
      btn.textContent = "🎤 Activer le micro";
      btn.title       = "Cliquer pour activer le micro";
    } else {
      btn.textContent = audio_a_isSpeaking ? "🔴 Je parle…" : "🎤 Prendre la parole";
      btn.title       = audio_a_isSpeaking ? "Cliquer pour couper" : "Cliquer pour parler";
    }

  } else {
    if (!btn) return;
    if (!audio_a_sessionActive) {
      zone.style.display = "none";
      btn.style.display  = "none";
    } else {
      zone.style.display = "";
      btn.style.display  = "inline-block";
      btn.disabled       = false;
      btn.style.opacity  = "1";
      btn.textContent    = audio_a_isSpeaking ? "🔴 Je parle…" : "🎤 Prendre la parole";
      btn.title          = audio_a_isSpeaking ? "Cliquer pour couper" : "Cliquer pour parler";
    }
  }
}

/* --------------------------------
   LISTENERS SOCKET WebRTC — AIDE
   Calqués sur le groupe
-------------------------------- */

/* Offre reçue */
window._dariushSocket.on("webrtc_offer_aide", async (data) => {
  if (!aideConnecte_aide) return;
  const { fromId, sdp } = data;

  const pc = await audioAide_createPeer(fromId, false);
  if (!pc) return;

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  window._dariushSocket.emit("webrtc_answer_aide", {
    targetId: fromId,
    sdp:      pc.localDescription,
    fromId:   window._dariushSocket.id
  });
});

/* Réponse reçue */
window._dariushSocket.on("webrtc_answer_aide", async (data) => {
  if (!aideConnecte_aide || !audio_a_peerConn) return;
  await audio_a_peerConn.setRemoteDescription(new RTCSessionDescription(data.sdp));
});

/* Candidat ICE reçu */
window._dariushSocket.on("webrtc_ice_aide", async (data) => {
  if (!aideConnecte_aide || !audio_a_peerConn) return;
  try {
    await audio_a_peerConn.addIceCandidate(new RTCIceCandidate(data.candidate));
  } catch (e) {
    console.warn("[audio-aide] ICE ignoré :", e.message);
  }
});

/* Alternance micro */
window._dariushSocket.on("audio_speaking_update_aide", (data) => {
  if (!aideConnecte_aide) return;
  if (!audio_a_localStream) return;

  const jesuisLeLocuteur = (
    (aideEstProf_aide  && data.role === "prof") ||
    (!aideEstProf_aide && data.role === "student")
  );

  if (!jesuisLeLocuteur && data.speaking) {
    audio_a_isSpeaking = false;
    audio_a_localStream.getTracks().forEach(t => { t.enabled = false; });
    audioAide_updateUI();
  }
});

/* Prof reçoit socket.id de l'élève
   → démarre immédiatement la session (comme audio_eleve_socket_id dans le groupe) */
window._dariushSocket.on("aide_audio_eleve_id", async (data) => {
  if (!aideConnecte_aide || !aideEstProf_aide) return;
  audio_a_eleveSocketId = data.eleveSocketId;

  /* Notifier l'élève d'abord */
  window._dariushSocket.emit("aide_audio_session_start", {
    eleveSocketId: audio_a_eleveSocketId
  });

  /* Attendre que l'élève soit prêt */
  await new Promise(r => setTimeout(r, 300));

  /* Démarrer la session côté prof */
  await audioAide_startSession(audio_a_eleveSocketId, true);
});

/* Élève reçoit l'ordre de démarrer
   → crée sa RTCPeerConnection et attend l'offre */
window._dariushSocket.on("aide_audio_session_start", async (data) => {
  if (!aideConnecte_aide || aideEstProf_aide) return;
  audio_a_profSocketId = data.profSocketId;
  await audioAide_startSession(data.profSocketId, false);
});

/* Session terminée côté élève */
window._dariushSocket.on("aide_session_closed", () => {
  if (!aideConnecte_aide || aideEstProf_aide) return;
  audioAide_stopSession();
});

/* Élève envoie son socket.id au prof dès qu'il est actif */
window._dariushSocket.on("aide_actif_update", () => {
  if (!aideConnecte_aide || aideEstProf_aide) return;
  window._dariushSocket.emit("aide_audio_request_prof_id");
});

/* --------------------------------
   BOUTON MICRO AIDE
-------------------------------- */
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("audioBtnAide");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    if (!aideConnecte_aide) return;
    await audioAide_toggleSpeak();
  });
});


async function audioAide_initMicPermission() {
  let state = "prompt";
  try {
    const perm = await navigator.permissions.query({ name: "microphone" });
    state = perm.state;
  } catch (e) {
    state = "prompt";
  }

  // Déjà autorisé → bouton visible, rien à faire
  if (state === "granted") {
    audioAide_updateUI();
    return;
  }

  // Refusé définitivement → bouton caché
  if (state === "denied") {
    const zone = document.getElementById("audioAideZone");
    if (zone) zone.style.display = "none";
    return;
  }

  // "prompt" → demander à l'utilisateur
  const ok = confirm("Voulez-vous pouvoir utiliser votre micro pendant cette session ?");
  if (!ok) {
    const zone = document.getElementById("audioAideZone");
    if (zone) zone.style.display = "none";
    return;
  }

  // Bloquer le panel aide pendant getUserMedia
  const panelConnexion = document.getElementById("aidePanelConnexion");
  if (panelConnexion) panelConnexion.style.pointerEvents = "none";

  try {
    await audioAide_getStream();
  } catch(e) {
    // L'utilisateur a cliqué "Bloquer"
    const zone = document.getElementById("audioAideZone");
    if (zone) zone.style.display = "none";
  }

  // Débloquer
  if (panelConnexion) panelConnexion.style.pointerEvents = "";

  audioAide_updateUI();
}
/* --------------------------------
   ACCROCHAGE DÉCONNEXION
-------------------------------- */
window.__audioAideCleanup = audioAide_cleanup;