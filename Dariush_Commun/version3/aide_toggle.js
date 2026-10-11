/* =====================================================
   Ouverture / fermeture du panneau aide
   Utilise la classe group-open (même CSS que groupe)
   Positionnement dynamique : même écart que IA / Groupe
===================================================== */

document.addEventListener("DOMContentLoaded", function () {
  const btn        = document.getElementById("boutonAide");
  const panneau    = document.getElementById("panneauAide");
  const fermer     = document.getElementById("aideBtnFermer");
  const btnGroupe  = document.getElementById("boutonmenuconnexion");
  const btnIA      = document.getElementById("openIaPanel");

  if (!btn || !panneau) return;

  /* ── Calcule et applique la position du bouton aide ──
     On mesure l'écart entre IA et Groupe, et on applique
     ce même écart à gauche du bouton Groupe.            */
 function positionnerBoutonAide() {
    if (!btnIA) return;

    const rectIA = btnIA.getBoundingClientRect();

    // Cas 1 — Dariush Python : on a un bouton "Travail en groupe" entre IA et Aide.
    // Bouton Aide placé à gauche du bouton Groupe, avec le même écart que celui
    // qui sépare Groupe de IA.
    if (btnGroupe) {
      const rectGroupe   = btnGroupe.getBoundingClientRect();
      const ecart        = rectIA.left - rectGroupe.right;
      const rightGroupe  = window.innerWidth - rectGroupe.right;
      const largeurGroupe = rectGroupe.width;
      btn.style.right = (rightGroupe + largeurGroupe + ecart) + "px";
      return;
    }

    // Cas 2 — Dariush Linux (et futurs : SQL, JS) : pas de bouton Groupe.
    // Bouton Aide placé à gauche du bouton IA, avec un écart fixe de 12 px.
    const rightIA = window.innerWidth - rectIA.right;
    const largeurIA = rectIA.width;
    const ecartFixe = 5;
    btn.style.right = (rightIA + largeurIA + ecartFixe) + "px";
  }
  
  function positionnerToastAide() {
  const toast = document.getElementById("aideToast");
  if (!toast || !btn) return;
  const rectBtn = btn.getBoundingClientRect();
  const rightBtn = window.innerWidth - rectBtn.right;
  toast.style.right = rightBtn + "px";
}

  // Applique au chargement et au redimensionnement
  positionnerBoutonAide();
positionnerToastAide();
window.addEventListener("resize", () => {
  positionnerBoutonAide();
  positionnerToastAide();
});
  
  


  /* ── Ouverture / fermeture ── */
  function ouvrirAide() {
    panneau.classList.add("group-open");
  }

  function fermerAide() {
    panneau.classList.remove("group-open");
  }

  btn.addEventListener("click", () => {
    if (panneau.classList.contains("group-open")) {
      fermerAide();
    } else {
      ouvrirAide();
    }
  });

  fermer?.addEventListener("click", fermerAide);
});