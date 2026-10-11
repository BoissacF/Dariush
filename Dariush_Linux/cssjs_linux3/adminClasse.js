/*
  adminClasse.js — Administrateur de classe (Dariush Linux)

  Tant qu'une classe n'a pas d'administrateur, le serveur demande à chaque
  personne qui ouvre son terminal si elle est le professeur de la classe. Celle
  qui répond avec un code utilisateur valide devient l'administrateur : elle
  voit alors le bouton « Gérer la classe », qui liste les dossiers de sa classe
  et permet de les supprimer. Les autres ne voient plus rien.

  L'administrateur ne peut que supprimer : son terminal reste celui d'un élève,
  il ne lit donc aucun fichier protégé. Un dossier supprimé reste 7 jours dans
  la corbeille du serveur.

  Module autonome : toute l'interface est créée ici, juste
  au-dessus du terminal. Côté serveur : Dariush-node/linuxAdmin.js.
*/

(function () {
  "use strict";

  const EXPLICATION =
    "L'administrateur peut supprimer les dossiers de sa classe. " +
    "Il ne peut pas lire les fichiers protégés par un élève.";

  const STYLE_BLOC =
    "margin-top:12px; padding:12px; border-radius:6px; color:#222; " +
    "display:none; flex-wrap:wrap; gap:8px; align-items:center;";
  const STYLE_BOUTON = "padding:6px 16px; border-radius:4px; cursor:pointer;";

  const LIBELLES = { compte: "compte", dossier: "dossier", fichier: "fichier", lien: "lien" };

  let socket = null;
  let classe = "";
  let bilanSuppression = "";

  let blocQuestion = null;
  let champCode = null;
  let statutQuestion = null;
  let blocAdmin = null;
  let titreAdmin = null;
  let panneau = null;
  let liste = null;
  let statutPanneau = null;

  // ── Petits outils ─────────────────────────────────────────────
  // Tout texte venu du serveur (noms de dossiers choisis par les élèves) est
  // posé avec textContent, jamais interprété comme du HTML.
  function creer(balise, style, texte) {
    const el = document.createElement(balise);
    if (style) el.style.cssText = style;
    if (texte) el.textContent = texte;
    return el;
  }

  function bouton(texte, action) {
    const b = creer("button", STYLE_BOUTON, texte);
    b.type = "button";
    b.addEventListener("click", action);
    return b;
  }

  function montrer(el, visible) {
    if (el) el.style.display = visible ? "flex" : "none";
  }

  function dire(el, texte, erreur) {
    if (!el) return;
    el.textContent = texte || "";
    el.style.color = erreur ? "#c62828" : "#2e7d32";
  }

  function envoyer(nom, donnees) {
    if (socket && socket.connected) socket.emit(nom, donnees);
  }

  // ── Question « Êtes-vous le professeur de cette classe ? » ────
  function construireQuestion() {
    blocQuestion = creer("div", STYLE_BLOC + "background:#fff8e1; border:1px solid #ffcc80;");
    blocQuestion.id = "linuxAdminQuestion";
    blocQuestion.title = EXPLICATION;

    const texte = creer("div", "flex-basis:100%;");
    texte.appendChild(creer("strong", "", "Êtes-vous le professeur de cette classe ?"));
    texte.appendChild(creer("div", "font-size:0.9em; margin-top:4px;",
      EXPLICATION + " Si oui, entrez votre code utilisateur et cliquez sur Oui."));

    champCode = creer("input", "flex:1; min-width:160px; padding:6px 10px; border-radius:4px; border:1px solid #ffb74d;");
    champCode.type = "password";
    champCode.id = "linuxAdminCode";
    champCode.placeholder = "Code utilisateur";
    champCode.autocomplete = "off";
    champCode.addEventListener("keydown", (e) => {
      if (e.key === "Enter") repondreOui();
    });

    statutQuestion = creer("span", "font-size:0.85em;");

    blocQuestion.appendChild(texte);
    blocQuestion.appendChild(champCode);
    blocQuestion.appendChild(bouton("Oui", repondreOui));
    blocQuestion.appendChild(bouton("Non", () => montrer(blocQuestion, false)));
    blocQuestion.appendChild(statutQuestion);
  }

  function repondreOui() {
    const code = champCode.value.trim();
    if (code === "") {
      dire(statutQuestion, "Entrez votre code utilisateur.", true);
      return;
    }
    dire(statutQuestion, "Vérification…", false);
    envoyer("linux_admin_devenir", { code });
  }

  // ── Barre et panneau de l'administrateur ──────────────────────
  function construireAdmin() {
    blocAdmin = creer("div", STYLE_BLOC + "background:#e8f5e9; border:1px solid #a5d6a7;");
    blocAdmin.id = "linuxAdminBarre";

    titreAdmin = creer("span", "flex:1; min-width:200px;");

    const gerer = bouton("Gérer la classe", () => {
      const ouvert = panneau.style.display !== "none";
      montrer(panneau, !ouvert);
      if (!ouvert) actualiser();
    });
    gerer.title = EXPLICATION;

    panneau = creer("div", "display:none; flex-basis:100%; flex-direction:column; gap:8px;");

    const actions = creer("div", "display:flex; flex-wrap:wrap; gap:8px; align-items:center;");
    actions.appendChild(bouton("Actualiser", actualiser));
    actions.appendChild(bouton("Tout supprimer", toutSupprimer));
    statutPanneau = creer("span", "font-size:0.85em;");
    actions.appendChild(statutPanneau);

    liste = creer("div", "max-height:260px; overflow:auto; background:#fff; border:1px solid #c8e6c9; border-radius:4px;");

    panneau.appendChild(actions);
    panneau.appendChild(liste);
    panneau.appendChild(creer("div", "font-size:0.8em; color:#555;",
      "Un dossier supprimé reste récupérable 7 jours auprès du responsable du site. Votre propre dossier n'apparaît pas ici."));

    blocAdmin.appendChild(titreAdmin);
    blocAdmin.appendChild(gerer);
    blocAdmin.appendChild(panneau);
  }

  function actualiser() {
    dire(statutPanneau, "Chargement…", false);
    envoyer("linux_admin_lister");
  }

  function supprimerUn(nom) {
    if (!confirm("Supprimer « " + nom + " » de la classe " + classe + " ?")) return;
    dire(statutPanneau, "Suppression…", false);
    envoyer("linux_admin_supprimer", { noms: [nom] });
  }

  function toutSupprimer() {
    if (!confirm("Supprimer TOUS les dossiers de la classe " + classe + ", sauf le vôtre ?")) return;
    dire(statutPanneau, "Suppression…", false);
    envoyer("linux_admin_supprimer", { tout: true });
  }

  function afficherListe(reponse) {
    liste.textContent = "";

    if (!reponse || !reponse.ok) {
      dire(statutPanneau, (reponse && reponse.message) || "Liste indisponible.", true);
      return;
    }

    const dossiers = Array.isArray(reponse.dossiers) ? reponse.dossiers : [];
    if (dossiers.length === 0) {
      liste.appendChild(creer("div", "padding:8px; color:#555;", "La classe ne contient aucun autre dossier."));
    }

    for (const d of dossiers) {
      const ligne = creer("div", "display:flex; gap:8px; align-items:center; padding:4px 8px; border-bottom:1px solid #eee;");
      ligne.appendChild(creer("span", "flex:1; word-break:break-all;", String(d.nom)));
      ligne.appendChild(creer("span", "font-size:0.8em; color:#777;",
        (LIBELLES[d.type] || "élément") + (d.connecte ? " · connecté" : "")));
      ligne.appendChild(bouton("Supprimer", () => supprimerUn(String(d.nom))));
      liste.appendChild(ligne);
    }

    const cache = (reponse.total || 0) - dossiers.length;
    const messages = [];
    if (bilanSuppression) messages.push(bilanSuppression);
    if (cache > 0) messages.push(cache + " autres éléments ne sont pas affichés.");
    dire(statutPanneau, messages.join(" "), false);
    bilanSuppression = "";
  }

  // ── Réponses du serveur ───────────────────────────────────────
  function toutCacher() {
    montrer(blocQuestion, false);
    montrer(blocAdmin, false);
    montrer(panneau, false);
    if (champCode) champCode.value = "";
    dire(statutQuestion, "", false);
  }

  function recevoirEtat(etat) {
    if (!etat) return;
    classe = String(etat.classe || "");

    if (etat.role === "admin") {
      montrer(blocQuestion, false);
      if (champCode) champCode.value = "";
      titreAdmin.textContent = "Vous êtes l'administrateur de la classe " + classe + ".";
      montrer(blocAdmin, true);
      return;
    }

    montrer(blocAdmin, false);
    montrer(panneau, false);
    dire(statutQuestion, "", false);
    montrer(blocQuestion, etat.question === true);
  }

  function attacher() {
    socket.on("linux_admin_etat", recevoirEtat);

    socket.on("linux_admin_reponse", (reponse) => {
      if (reponse && !reponse.ok) dire(statutQuestion, reponse.message || "Refusé.", true);
    });

    socket.on("linux_admin_liste", afficherListe);

    // Le serveur envoie ensuite la liste à jour : le bilan s'affiche avec elle
    socket.on("linux_admin_suppression", (reponse) => {
      if (!reponse || !reponse.ok) {
        dire(statutPanneau, (reponse && reponse.message) || "Suppression impossible.", true);
        return;
      }
      bilanSuppression = reponse.supprimes + " supprimé(s)"
        + (reponse.echecs > 0 ? ", " + reponse.echecs + " échec(s)." : ".");
    });

    // Terminal fermé ou connexion perdue : plus rien à administrer
    socket.on("linux_exit", toutCacher);
    socket.on("linux_error", toutCacher);
    socket.on("disconnect", toutCacher);
  }

  // ── Démarrage ─────────────────────────────────────────────────
  // Le socket est créé par SOCKET_connexion.js (chargé en module), qui peut
  // arriver après DOMContentLoaded : même attente que dans terminal.js.
  function attendreSocket(essais) {
    if (window._dariushSocket) {
      socket = window._dariushSocket;
      attacher();
      return;
    }
    if (essais > 0) setTimeout(() => attendreSocket(essais - 1), 200);
  }

  document.addEventListener("DOMContentLoaded", () => {
    const terminal = document.getElementById("terminalContainer");
    if (!terminal || !terminal.parentNode) return;

    construireQuestion();
    construireAdmin();
    terminal.parentNode.insertBefore(blocQuestion, terminal);
    terminal.parentNode.insertBefore(blocAdmin, terminal);

    attendreSocket(25);
  });
})();
