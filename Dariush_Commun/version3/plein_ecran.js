/*
  plein_ecran.js
  Bouton "Plein écran" ajouté dans la barre de menu (#topBarMenu), juste avant "Home".
  Un clic masque la barre du navigateur, un second clic (ou Échap) revient à l'affichage normal.
  Module autonome : le bouton est créé ici.
*/

(function () {
  "use strict";

  const LIBELLE_ENTRER = "⛶ Plein écran";
  const LIBELLE_QUITTER = "✕ Quitter le plein écran";

  let bouton = null;

  // ── Compatibilité (préfixe webkit pour les anciens Safari) ─────
  function pleinEcranDisponible() {
    return !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  }

  function estEnPleinEcran() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function entrerPleinEcran() {
    const racine = document.documentElement;
    const demande = racine.requestFullscreen || racine.webkitRequestFullscreen;
    if (!demande) return;

    const resultat = demande.call(racine);
    if (resultat && typeof resultat.catch === "function") {
      resultat.catch((err) => console.warn("Plein écran refusé :", err));
    }
  }

  function quitterPleinEcran() {
    const sortie = document.exitFullscreen || document.webkitExitFullscreen;
    if (!sortie) return;

    const resultat = sortie.call(document);
    if (resultat && typeof resultat.catch === "function") {
      resultat.catch(() => {});
    }
  }

  function basculerPleinEcran() {
    if (estEnPleinEcran()) {
      quitterPleinEcran();
    } else {
      entrerPleinEcran();
    }
  }

  // ── Bouton ────────────────────────────────────────────────────
  function mettreAJourBouton() {
    if (!bouton) return;

    const actif = estEnPleinEcran();
    bouton.textContent = actif ? LIBELLE_QUITTER : LIBELLE_ENTRER;
    bouton.title = actif ? "Revenir à l'affichage normal" : "Masquer la barre du navigateur";
    bouton.setAttribute("aria-pressed", actif ? "true" : "false");
  }

  function creerBouton() {
    const menu = document.getElementById("topBarMenu");
    if (!menu || !pleinEcranDisponible()) return;
    if (document.getElementById("btnPleinEcran")) return;

    bouton = document.createElement("button");
    bouton.type = "button";
    bouton.id = "btnPleinEcran";
    bouton.className = "nav-item nav-btn";
    bouton.addEventListener("click", basculerPleinEcran);

    menu.insertBefore(bouton, menu.querySelector(".nav-home"));
    mettreAJourBouton();
  }

  // Le libellé suit l'état réel : Échap ou F11 sortent du plein écran sans passer par le bouton
  document.addEventListener("fullscreenchange", mettreAJourBouton);
  document.addEventListener("webkitfullscreenchange", mettreAJourBouton);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", creerBouton);
  } else {
    creerBouton();
  }

  window.basculerPleinEcran = basculerPleinEcran;
})();
