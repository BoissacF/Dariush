// =============================
//menu avec les differents panneaux modals
// =============================

let exercicesData = [];
let pagesExercicesParCle = {};
const exercicesParPage = 50;

let codeUtilisateurSuppressionValide = "";
let exercicesUtilisateurSuppression = [];

let codeUtilisateurModificationValide = "";
let exercicesUtilisateurModification = [];

let codeUtilisateurRestreintValide = "";

// =============================
// PANNEAUX / MODALE
// =============================

function getMenuModalElements() {
  return {
    overlay: document.getElementById("menuModalOverlay"),
    panelsContainer: document.getElementById("menuPanels"),
    title: document.getElementById("menuModalTitle")
  };
}

function hideMenuPanels() {
  const { overlay, panelsContainer, title } = getMenuModalElements();
  if (!overlay || !panelsContainer) return;

  overlay.style.display = "none";

  panelsContainer.querySelectorAll(".menu-panel").forEach(panel => {
    panel.style.display = "none";
  });

  if (title) {
    title.textContent = "Menu";
  }
}

function showMenuPanel(panelId) {
  const { overlay, panelsContainer, title } = getMenuModalElements();
  if (!overlay || !panelsContainer) return;

  panelsContainer.querySelectorAll(".menu-panel").forEach(panel => {
    panel.style.display = "none";
  });

  const target = document.getElementById(panelId);
  if (!target) return;

  target.style.display = "block";
  overlay.style.display = "flex";

  if (title) {
    title.textContent = target.dataset.title || "Menu";
  }

  if (typeof closeDropdown === "function") {
    closeDropdown();
  }
}

function handleMenuModalBackdrop(event) {
  if (event.target && event.target.id === "menuModalOverlay") {
    hideMenuPanels();
  }
}

window.showMenuPanel = showMenuPanel;
window.hideMenuPanels = hideMenuPanels;
window.handleMenuModalBackdrop = handleMenuModalBackdrop;

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hideMenuPanels();
  }
});

// =============================
// DROPDOWN
// =============================

function closeDropdown() {
  document.querySelectorAll(".nav-dropdown").forEach(drop => {
    drop.classList.remove("open");
  });
}

// =============================
// OUTILS TEXTE
// =============================

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}


// Suffixe identifiant une correction (4 étoiles de chaque côté) — doit rester
// synchronisé avec SUFFIXE_CORRECTION dans modifier_exercice.php / supprimer_exercice.php
const SUFFIXE_CORRECTION = "****correction****";

// Renvoie true si le descriptif désigne une correction
function estCorrection(descriptif) {
  return typeof descriptif === "string" && descriptif.endsWith(SUFFIXE_CORRECTION);
}

// Renvoie le descriptif d'origine (sans le suffixe correction)
function descriptifSansSuffixe(descriptif) {
  if (estCorrection(descriptif)) {
    return descriptif.slice(0, -SUFFIXE_CORRECTION.length);
  }
  return descriptif;
}

function normaliserTexte(str) {
  return String(str ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
}

function forcerMajuscules(input) {
  if (!input) return;
  input.value = input.value.toUpperCase();
}

function formatAuteur(ex) {
  const nom = (ex.nom || "").trim();
  const prenom = (ex.prenom || "").trim();

  if (!nom && !prenom) return "CONTRIBUTEUR INCONNU";
  return `${nom} ${prenom}`.trim();
}

function formatNiveau(niveau) {
  const map = {
    debutant: "Débutant",
    premiere: "Première NSI — bases",
    premiere2: "Première NSI — avancé",
    terminale: "Terminale NSI — bases",
    terminale2: "Terminale NSI — avancé",
    BAC: "BAC",
    superieur: "Supérieur",
    expert: "Expert"
  };
  return map[niveau] || niveau || "";
}

// =============================
// MENUS DEROULANTS PAR NIVEAU
// =============================

// Structure de la fenetre de resultats : un menu = un titre + les niveaux
// bruts qu'il regroupe. "sousMenus" est optionnel ; un menu qui en a deplie
// ses sous-menus, un menu qui n'en a pas deplie directement ses exercices.
const ARBRE_NIVEAUX = [
  { cle: "debutant", libelle: "Débutant", niveaux: ["debutant"] },
  {
    cle: "premiere",
    libelle: "Première NSI",
    niveaux: ["premiere", "premiere2"],
    sousMenus: [
      { cle: "premiere-bases",  libelle: "Bases (cours + exos classiques)", niveaux: ["premiere"] },
      { cle: "premiere-avance", libelle: "Avancé : activités et problèmes", niveaux: ["premiere2"] }
    ]
  },
  {
    cle: "terminale",
    libelle: "Terminale NSI",
    niveaux: ["terminale", "terminale2"],
    sousMenus: [
      { cle: "terminale-bases",  libelle: "Bases (cours + exos classiques)", niveaux: ["terminale"] },
      { cle: "terminale-avance", libelle: "Avancé : activités et problèmes", niveaux: ["terminale2"] }
    ]
  },
  { cle: "bac",       libelle: "BAC",       niveaux: ["BAC"] },
  { cle: "superieur", libelle: "Supérieur", niveaux: ["superieur"] },
  { cle: "expert",    libelle: "Expert",    niveaux: ["expert"] }
];

// Clés des menus actuellement dépliés.
let clesNiveauxDepliees = [];

// =============================
// CONSTRUCTION DES LISTES
// =============================

function construireOptionsAuteurs(data) {
  const map = new Map();

  for (const ex of data) {
    const auteur = formatAuteur(ex);
    const cle = normaliserTexte(auteur);

    if (!map.has(cle)) {
      map.set(cle, auteur);
    }
  }

  return Array.from(map.values()).sort((a, b) =>
    a.localeCompare(b, "fr", { sensitivity: "base" })
  );
}

function remplirSelect(selectId, items, texteDefaut, valeurSelectionnee = "") {
  const select = document.getElementById(selectId);
  if (!select) return;

  let html = `<option value="">${escapeHtml(texteDefaut)}</option>`;

  for (const item of items) {
    const selected = item === valeurSelectionnee ? " selected" : "";
    html += `<option value="${escapeHtml(item)}"${selected}>${escapeHtml(item)}</option>`;
  }

  select.innerHTML = html;
}

// =============================
// FILTRES EN CHAINE
// =============================

function getValeursFiltres() {
  return {
    texteAuteur: document.getElementById("chercheAuteur")?.value || "",
    auteurSelectionne: document.getElementById("filtreAuteur")?.value || "",
    texteDescriptif: document.getElementById("chercheDescriptif")?.value || ""
  };
}

function calculerBaseAuteur() {
  const { texteAuteur, auteurSelectionne } = getValeursFiltres();

  let data = [...exercicesData];

  if (texteAuteur) {
    const prefixeAuteur = normaliserTexte(texteAuteur);
    data = data.filter(ex =>
      normaliserTexte(formatAuteur(ex)).startsWith(prefixeAuteur)
    );
  }

  if (auteurSelectionne) {
    data = data.filter(ex => formatAuteur(ex) === auteurSelectionne);
  }

  return data;
}

function getResultatsFiltres() {
  const { texteDescriptif } = getValeursFiltres();

  let data = calculerBaseAuteur();

  if (texteDescriptif) {
    const mots = normaliserTexte(texteDescriptif)
      .split(/\s+/)
      .filter(Boolean);

    data = data.filter(ex => {
      const texte = normaliserTexte((ex.descriptif || "").trim());
      return mots.every(mot => texte.includes(mot));
    });
  }

  return data;
}

function mettreAJourSelectAuteur() {
  const data = [...exercicesData];
  const { texteAuteur, auteurSelectionne } = getValeursFiltres();

  let auteurs = construireOptionsAuteurs(data);

  if (texteAuteur) {
    const prefixeAuteur = normaliserTexte(texteAuteur);
    auteurs = auteurs.filter(auteur =>
      normaliserTexte(auteur).startsWith(prefixeAuteur)
    );
  }

  const valeurConservee = auteurs.includes(auteurSelectionne) ? auteurSelectionne : "";
  remplirSelect("filtreAuteur", auteurs, "Tous les contributeurs", valeurConservee);
}

function rafraichirChaineExercices() {
  mettreAJourSelectAuteur();
  pagesExercicesParCle = {};
  afficherArbreExercices();
}

// =============================
// AFFICHAGE RESULTATS
// =============================

// Base d'URL selon l'application courante (Python / Linux / SQL)
function getBaseUrlExercices() {
  const isLinux = window.location.pathname.includes("Dariush_Linux");
  const isSql   = window.location.pathname.includes("Dariush_SQL");

  return isLinux
    ? "https://physalgo.fr/Dariush_Linux/index.html"
    : isSql
    ? "https://physalgo.fr/Dariush_SQL/index.html"
    : "https://physalgo.fr/Dariush_Python/index.html";
}

// Une ligne <li> d'exercice, avec son lien court et son corrigé éventuel.
function construireLigneExerciceHtml(ex, correctionsParTitre, baseUrlExo) {
  let html = "";

    const descriptif = (ex.descriptif || "Exercice sans titre").trim();
    const auteur = formatAuteur(ex);
    const niveau = formatNiveau(ex.niveau);
    const infoTitle = "contributeur : " + auteur + " — niveau : " + niveau;
    const estRestreint = ex.acces_restreint == 1;

    const lienCourtCode = (ex.lien_court || "").trim();

    const lienCourtComplet = lienCourtCode
      ? baseUrlExo + "?exo=" + encodeURIComponent(lienCourtCode)
      : "";

    const lien = lienCourtComplet || "#";
    const exId = escapeHtml(String(ex.id ?? ""));

    let btnLienCourt = "";
    if (lienCourtComplet && estRestreint) {
      btnLienCourt = "<button type=\"button\" class=\"btn-lien-court-exercice btn-lien-court-exercice-restreint\" data-exercice-id=\"" + exId + "\" data-lien-court-code=\"" + escapeHtml(lienCourtCode) + "\" title=\"Accès réservé aux professeurs avec code utilisateur\" aria-label=\"lien court réservé aux professeurs\">🔗</button>";
    } else if (lienCourtComplet) {
      btnLienCourt = "<button type=\"button\" class=\"btn-lien-court-exercice\" data-exercice-id=\"" + exId + "\" data-lien-court=\"" + escapeHtml(lienCourtComplet) + "\" title=\"copier un lien court de cet exercice\" aria-label=\"copier un lien court de cet exercice\">🔗</button>";
    } else {
      btnLienCourt = "<span class=\"btn-lien-court-exercice btn-lien-court-exercice-disabled\" title=\"aucun lien court disponible pour cet exercice\" aria-hidden=\"true\">🔗</span>";
    }

    const iconeRestreint = estRestreint
      ? "<span class=\"icone-acces-restreint\" title=\"Accès réservé aux professeurs avec code utilisateur\" style=\"margin-right:4px; cursor:default; font-size:0.95em;\">🔒</span>"
      : "";

    let attrLien = "";
    if (estRestreint) {
      attrLien = "data-restreint=\"1\" data-lien-court-code=\"" + escapeHtml(lienCourtCode) + "\"";
    } else {
      attrLien = "target=\"_blank\" rel=\"noopener noreferrer\"";
    }

    let zoneLienCourt = "";
    if (lienCourtComplet) {
      zoneLienCourt = "<div class=\"zone-lien-court-exercice\" id=\"zone-lien-court-" + exId + "\" style=\"display:none;\"><div class=\"lien-court-exercice-texte\">" + escapeHtml(lienCourtComplet) + "</div></div>";
    }

    // ─── Bloc CORRIGÉ : " / 🔗 🔒 Corrigé " si une correction existe ───
    let blocCorrige = "";
    let zoneLienCorrige = "";
    const corr = correctionsParTitre[descriptif];
    if (corr) {
      const corrRestreint   = corr.acces_restreint == 1;
      const corrLienCode    = (corr.lien_court || "").trim();
      const corrLienComplet = corrLienCode
        ? baseUrlExo + "?exo=" + encodeURIComponent(corrLienCode)
        : "";
      const corrId = escapeHtml(String(corr.id ?? ""));

      if (corrLienComplet) {
        let btnCorrige;
        if (corrRestreint) {
          btnCorrige = "<button type=\"button\" class=\"btn-lien-court-exercice btn-corrige-exercice btn-lien-court-exercice-restreint\" data-exercice-id=\"" + corrId + "\" data-lien-court-code=\"" + escapeHtml(corrLienCode) + "\" title=\"Corrigé — accès réservé aux professeurs avec code utilisateur\" aria-label=\"corrigé réservé aux professeurs\">🔗</button>";
        } else {
          btnCorrige = "<button type=\"button\" class=\"btn-lien-court-exercice btn-corrige-exercice\" data-exercice-id=\"" + corrId + "\" data-lien-court=\"" + escapeHtml(corrLienComplet) + "\" title=\"copier le lien du corrigé\" aria-label=\"copier le lien du corrigé\">🔗</button>";
        }

        const iconeCorrRestreint = corrRestreint
          ? "<span class=\"icone-acces-restreint\" title=\"Corrigé — accès réservé aux professeurs avec code utilisateur\" style=\"margin-right:4px; cursor:default; font-size:0.95em;\">🔒</span>"
          : "";

        let attrCorr = "";
        if (corrRestreint) {
          attrCorr = "data-restreint=\"1\" data-lien-court-code=\"" + escapeHtml(corrLienCode) + "\"";
        } else {
          attrCorr = "target=\"_blank\" rel=\"noopener noreferrer\"";
        }

        blocCorrige = "<span class=\"separateur-corrige\" style=\"margin:0 4px; color:#888;\">/</span>"
          + btnCorrige
          + iconeCorrRestreint
          + "<a href=\"" + escapeHtml(corrLienComplet) + "\" title=\"Corrigé\" " + attrCorr + " class=\"titre-corrige-modal\">Corrigé</a>";

        zoneLienCorrige = "<div class=\"zone-lien-court-exercice\" id=\"zone-lien-court-" + corrId + "\" style=\"display:none;\"><div class=\"lien-court-exercice-texte\">" + escapeHtml(corrLienComplet) + "</div></div>";
      }
    }

    const nbPages = parseInt(ex.nb_pages, 10) || 1;
    const nbPagesHtml = "<span class=\"nb-pages-exercice\" style=\"font-size:0.85em; color:#888; margin-left:4px;\">(" + nbPages + ")</span>";

    html += "<li class=\"ligne-exercice-modal\">"
      + "<div class=\"ligne-exercice-haut\">"
      + btnLienCourt
      + iconeRestreint
      + "<a href=\"" + escapeHtml(lien) + "\" title=\"" + escapeHtml(infoTitle) + "\" " + attrLien + " class=\"titre-exercice-modal\">" + escapeHtml(descriptif) + "</a>"
      + nbPagesHtml
      + blocCorrige
      + "</div>"
      + zoneLienCourt
      + zoneLienCorrige
      + "</li>";
  return html;
}

// Exercices d'un menu. Les corrigés ne comptent pas : ils ne s'affichent
// jamais seuls, mais accrochés à leur exercice d'origine.
function exercicesDuMenu(menu, data) {
  return data.filter(ex =>
    menu.niveaux.includes(ex.niveau) && !estCorrection(ex.descriptif)
  );
}

// Liste paginée des exercices d'un seul menu déroulant.
function construireListeExercicesHtml(exos, cle, correctionsParTitre, baseUrlExo) {
  if (exos.length === 0) {
    return `<p class="niveau-vide">Aucun exercice dans cette partie.</p>`;
  }

  const totalPages = Math.max(1, Math.ceil(exos.length / exercicesParPage));

  let page = pagesExercicesParCle[cle] || 1;
  if (page > totalPages) page = totalPages;
  if (page < 1) page = 1;
  pagesExercicesParCle[cle] = page;

  const debut = (page - 1) * exercicesParPage;
  const exosPage = exos.slice(debut, debut + exercicesParPage);
  const cleAttr = escapeHtml(cle);

  let html = "";

  if (totalPages > 1) {
    html += `<div class="niveau-pagination-info">page ${page} / ${totalPages}</div>`;
  }

  html += `<ul class="liste-exercices-modal">`;

  for (const ex of exosPage) {
    html += construireLigneExerciceHtml(ex, correctionsParTitre, baseUrlExo);
  }

  html += `</ul>`;

  if (totalPages > 1) {
    html += `<div class="pagination-exercices">`;

    html += `<button type="button" class="btn-page-exercice" data-cle="${cleAttr}" data-page="${page - 1}" ${page === 1 ? "disabled" : ""}>Précédent</button>`;

    for (let p = 1; p <= totalPages; p++) {
      if (p === 1 || p === totalPages || (p >= page - 2 && p <= page + 2)) {
        html += `<button type="button" class="btn-page-exercice" data-cle="${cleAttr}" data-page="${p}" ${p === page ? "disabled" : ""}>${p}</button>`;
      } else if (p === page - 3 || p === page + 3) {
        html += `<span>...</span>`;
      }
    }

    html += `<button type="button" class="btn-page-exercice" data-cle="${cleAttr}" data-page="${page + 1}" ${page === totalPages ? "disabled" : ""}>Suivant</button>`;

    html += `</div>`;
  }

  return html;
}

// Un menu déroulant + le contenu qu'il déplie juste en dessous de lui :
// ses sous-menus s'il en a, sinon directement sa liste d'exercices.
function construireBlocMenuHtml(menu, data, correctionsParTitre, baseUrlExo, profondeur) {
  const aSousMenus = Array.isArray(menu.sousMenus) && menu.sousMenus.length > 0;
  const estDeplie  = clesNiveauxDepliees.includes(menu.cle);
  const exos       = exercicesDuMenu(menu, data);
  const cleAttr    = escapeHtml(menu.cle);

  const classes = "niveau-menu"
    + (profondeur > 0 ? " niveau-sous-menu-titre" : "")
    + (exos.length === 0 ? " est-vide" : "");

  let html = `<div class="niveau-bloc">`
    + `<button type="button" class="${classes}" data-deplier="${cleAttr}" aria-expanded="${estDeplie ? "true" : "false"}">`
    +   `<span class="niveau-fleche">${estDeplie ? "▾" : "▸"}</span>`
    +   `<span class="niveau-libelle">${escapeHtml(menu.libelle)}</span>`
    +   `<span class="niveau-compteur">(${exos.length})</span>`
    + `</button>`
    + `<div class="niveau-contenu" style="display:${estDeplie ? "block" : "none"};">`;

  if (aSousMenus) {
    for (const sous of menu.sousMenus) {
      html += construireBlocMenuHtml(sous, data, correctionsParTitre, baseUrlExo, profondeur + 1);
    }
  } else {
    html += construireListeExercicesHtml(exos, menu.cle, correctionsParTitre, baseUrlExo);
  }

  html += `</div></div>`;

  return html;
}

// La fenêtre de résultats n'affiche plus une liste plate d'exercices, mais
// les menus déroulants par niveau ; chacun déplie ses exercices sous lui.
function afficherArbreExercices() {
  const zone = document.getElementById("resultatsExercices");
  if (!zone) return;

  const data = getResultatsFiltres();
  const baseUrlExo = getBaseUrlExercices();

  // Index des corrections par descriptif d'origine, pour retrouver
  // rapidement la correction associée à chaque exercice normal.
  const correctionsParTitre = {};
  for (const ex of data) {
    if (estCorrection(ex.descriptif)) {
      const titreOrigine = descriptifSansSuffixe(ex.descriptif).trim();
      correctionsParTitre[titreOrigine] = ex;
    }
  }

  const total = data.filter(ex => !estCorrection(ex.descriptif)).length;

  const resume = total === 0
    ? "Aucun exercice ne correspond à la recherche."
    : total + " exercice(s) trouvé(s)";

  let html = `<div class="resume-exercices">${escapeHtml(resume)}</div>`;

  for (const menu of ARBRE_NIVEAUX) {
    html += construireBlocMenuHtml(menu, data, correctionsParTitre, baseUrlExo, 0);
  }

  zone.innerHTML = html;
  attacherEvenementsResultats(zone);
}

// Tout l'arbre est redessiné à chaque clic : l'état d'ouverture des menus et
// la page courante de chacun vivent dans clesNiveauxDepliees / pagesExercicesParCle.
function attacherEvenementsResultats(zone) {
  zone.querySelectorAll(".niveau-menu").forEach(btn => {
    btn.addEventListener("click", () => {
      const cle = btn.dataset.deplier || "";

      if (clesNiveauxDepliees.includes(cle)) {
        clesNiveauxDepliees = clesNiveauxDepliees.filter(c => c !== cle);
      } else {
        clesNiveauxDepliees.push(cle);
      }

      afficherArbreExercices();
    });
  });

  zone.querySelectorAll(".btn-page-exercice").forEach(btn => {
    btn.addEventListener("click", () => {
      const cle = btn.dataset.cle || "";
      pagesExercicesParCle[cle] = Number(btn.dataset.page || "1");
      afficherArbreExercices();
    });
  });

  zone.querySelectorAll(".btn-lien-court-exercice").forEach(btn => {
    if (btn.tagName !== "BUTTON") return;

    // Bouton lien court restreint (exercice OU corrigé) : demande le code utilisateur
    if (btn.classList.contains("btn-lien-court-exercice-restreint")) {
      btn.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const lienCourtCode = btn.dataset.lienCourtCode || "";
        const exerciceId = btn.dataset.exerciceId || "";
        if (!lienCourtCode) return;
        await ouvrirExerciceRestreint(lienCourtCode, true, exerciceId);
      });
      return;
    }

    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const lienCourt = btn.dataset.lienCourt || "";
      const exerciceId = btn.dataset.exerciceId || "";
      const zoneLien = document.getElementById("zone-lien-court-" + exerciceId);

      if (!lienCourt || !zoneLien) return;

      const etaitVisible = zoneLien.style.display !== "none";

      document.querySelectorAll(".zone-lien-court-exercice").forEach(el => {
        el.style.display = "none";
      });

      if (!etaitVisible) {
        zoneLien.style.display = "block";
      }

      try {
        await navigator.clipboard.writeText(lienCourt);

        const ancienContenu = btn.textContent;
        btn.textContent = "✓";

        setTimeout(() => {
          btn.textContent = ancienContenu;
        }, 1000);
      } catch (err) {
        console.warn("Impossible de copier automatiquement le lien court.", err);
      }
    });
  });
}

// =============================
// RECHERCHE EXERCICES
// =============================
async function ouvrirRechercheExercices() {
  const panelId = "panel-exercices";
  const panel = document.getElementById(panelId);
  if (!panel) return;

  showMenuPanel(panelId);

  panel.innerHTML = `
    <h3>Recherche d'exercices</h3>
    <p>Chargement...</p>
  `;

  try {
   

    const response = await fetch(
      "https://physalgo.fr/Dariush_Commun/get_exercices.php?source=" + encodeURIComponent(getDariushSource()),
      { method: "GET" }
    );

    if (!response.ok) {
      throw new Error("Erreur HTTP " + response.status);
    }

    exercicesData = await response.json();

    // Les menus repartent tous repliés à chaque ouverture du panneau.
    clesNiveauxDepliees = [];
    pagesExercicesParCle = {};

    panel.innerHTML = `
      <div class="proposer-form">
        <div class="form-row">
          <div class="form-field">
            <label for="chercheAuteur">Contributeur</label>
            <div class="champ-contributeur" id="champContributeur">
              <input
                type="text"
                id="chercheAuteur"
                placeholder="Début du nom"
                autocomplete="off"
              >
              <select id="filtreAuteur" class="select-contributeur"></select>
            </div>
          </div>

          <div class="form-field">
            <label for="chercheDescriptif">Descriptif</label>
            <input
              type="text"
              id="chercheDescriptif"
              placeholder="Mots-clés (ex : graphe profondeur)"
              autocomplete="off"
            >
          </div>
        </div>

        <div id="resultatsExercices" class="arbre-niveaux-exercices" style="margin-top:14px;"></div>
      </div>
    `;

    remplirSelect("filtreAuteur", construireOptionsAuteurs(exercicesData), "Tous les contributeurs");

    const filtreAuteur = document.getElementById("filtreAuteur");
    const chercheAuteur = document.getElementById("chercheAuteur");
    const chercheDescriptif = document.getElementById("chercheDescriptif");

    // Le select des contributeurs ne se montre qu'au focus, pour que le champ
    // tienne sur une seule ligne comme le champ Descriptif. On écoute sur le
    // conteneur (focusin/focusout) et pas sur l'input : sinon le select se
    // refermerait avant même qu'on ait pu cliquer dedans.
    const champContributeur = document.getElementById("champContributeur");

    champContributeur?.addEventListener("focusin", () => {
      champContributeur.classList.add("est-ouvert");
    });

    champContributeur?.addEventListener("focusout", (event) => {
      if (!champContributeur.contains(event.relatedTarget)) {
        champContributeur.classList.remove("est-ouvert");
      }
    });

    chercheAuteur?.addEventListener("input", () => {
      forcerMajuscules(chercheAuteur);
      rafraichirChaineExercices();
    });

    filtreAuteur?.addEventListener("change", () => {
      // Le contributeur choisi remonte dans le champ du dessus : c'est lui
      // qui affiche le filtre courant une fois le déroulant refermé.
      // "Tous les contributeurs" vaut "" et vide donc le champ.
      if (chercheAuteur) {
        chercheAuteur.value = filtreAuteur.value;
      }

      rafraichirChaineExercices();
    });

    chercheDescriptif?.addEventListener("input", () => {
      forcerMajuscules(chercheDescriptif);
      pagesExercicesParCle = {};
      afficherArbreExercices();
    });

    panel.onclick = async function (event) {
      const link = event.target.closest("a[href]");
      if (!link || !panel.contains(link)) return;

      const href = link.getAttribute("href") || "";
      if (!href) return;

      // Mémorise l'exercice ouvert pour que l'agent Aide retrouve son corrigé.
      // Couvre le clic normal (?exo=code dans le href) et le clic restreint
      // (data-lien-court-code). Non bloquant.
      try {
        const mExo = href.match(/[?&]exo=([^&]+)/);
        const codeExo = link.dataset.lienCourtCode
          || (mExo ? decodeURIComponent(mExo[1]) : "");
        window.__exerciceCourant = {
          descriptif: (link.textContent || "").trim(),
          lien_court: codeExo,
          source: (typeof getDariushSource === "function") ? getDariushSource() : "python"
        };
      } catch (e) { /* non bloquant */ }

      if (link.dataset.restreint === "1") {
        event.preventDefault();
        const lienCourtCode = link.dataset.lienCourtCode || "";
        if (lienCourtCode) {
          await ouvrirExerciceRestreint(lienCourtCode);
        }
        return;
      }

      const isExerciseLink =
        href.includes("Dariush_Python") ||
        href.includes("?code=") ||
        href.includes("&code=") ||
        href.includes("?sid=") ||
        href.includes("&sid=") ||
        href.includes("?exo=") ||
        href.includes("&exo=");

      if (!isExerciseLink) return;

      event.preventDefault();

      try {
        const ok = await decode_url(href);
        if (!ok) return;

        // Ouvrir un exercice = nouveau fichier : on repart avec une mémoire
        // Python propre (évite qu'un "from PIL.Image import *" ou toute autre
        // globale du fichier précédent ne pollue celui-ci).
        if (window.PagesMultiples && typeof window.PagesMultiples.resetPythonNotebookMemory === "function") {
          window.PagesMultiples.resetPythonNotebookMemory();
        }

        if (typeof window.resetLoadedPageUi === "function") {
          window.resetLoadedPageUi();
        }

        if (window.PythonAutosave && typeof window.PythonAutosave.saveNow === "function") {
          window.PythonAutosave.saveNow();
        }

        hideMenuPanels();
        window.scrollTo({ top: 0, behavior: "smooth" });
      } catch (err) {
        console.error("Erreur ouverture exercice :", err);
        alert("Impossible d'ouvrir cet exercice dans la page actuelle.");
      }
    };

    rafraichirChaineExercices();

  } catch (error) {
    panel.innerHTML = `
      <h3>Recherche d'exercices</h3>
      <p>Impossible de charger les exercices.</p>
    `;
    console.error("Erreur chargement exercices :", error);
  }
}


// =============================
// MOT DE PASSE POUR ÉLÈVES
// =============================

// =============================
// MOT DE PASSE POUR ÉLÈVES
// =============================

function resetMdpElevePanel() {
  const code   = document.getElementById("mdpEleveCodeProf");
  const valeur = document.getElementById("mdpEleveValeur");
  const msg    = document.getElementById("messageMdpEleve");

  if (code)   code.value = "";
  if (valeur) valeur.value = "";
  if (msg)    { msg.textContent = ""; msg.style.color = "#b00020"; }
}

async function genererMdpEleve() {
  const code   = document.getElementById("mdpEleveCodeProf")?.value.trim() || "";
  const valeur = document.getElementById("mdpEleveValeur")?.value.trim() || "";
  const msg    = document.getElementById("messageMdpEleve");

  if (!code) {
    if (msg) { msg.textContent = "Merci d'entrer votre code utilisateur."; msg.style.color = "#b00020"; }
    return;
  }
  if (valeur.length < 6) {
    if (msg) { msg.textContent = "Le mot de passe doit faire au moins 6 caractères."; msg.style.color = "#b00020"; }
    return;
  }

  try {
    const response = await fetch("https://physalgo.fr/Dariush_Commun/gerer_mot_de_passe_eleve.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code_utilisateur: code, mot_de_passe: valeur })
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
      if (msg) { msg.textContent = data.error || "Erreur lors de l'enregistrement."; msg.style.color = "#b00020"; }
      return;
    }

    if (msg) {
      msg.innerHTML = "Mot de passe « <strong>" + (data.mot_de_passe || valeur) +
        "</strong> » enregistré. Valable jusqu'au " + (data.expire_le || "") +
        ". Communiquez-le à vos élèves.";
      msg.style.color = "#2e7d32";
    }
  } catch (error) {
    if (msg) { msg.textContent = "Erreur réseau lors de l'enregistrement."; msg.style.color = "#b00020"; }
    console.error("Erreur génération mot de passe élève :", error);
  }
}


// =============================
// EXERCICE RESTREINT — MODAL
// =============================

async function ouvrirExerciceRestreint(lienCourtCode, modeLienCourt = false, exerciceId = "") {
  if (codeUtilisateurRestreintValide) {
    const ok = await tenterOuvertureRestreinte(lienCourtCode, codeUtilisateurRestreintValide, modeLienCourt, exerciceId);
    if (ok) return;
    codeUtilisateurRestreintValide = "";
  }
  afficherModalRestreint(lienCourtCode, modeLienCourt, exerciceId);
}

function afficherModalRestreint(lienCourtCode, modeLienCourt = false, exerciceId = "") {
  const modal      = document.getElementById("modalExerciceRestreint");
  const select     = document.getElementById("selectRoleRestreint");
  const champProf  = document.getElementById("champCodeProfRestreint");
  const champEleve = document.getElementById("champMdpEleveRestreint");
  const inputProf  = document.getElementById("inputCodeRestreint");
  const inputEleve = document.getElementById("inputMdpEleveRestreint");
  const message    = document.getElementById("messageCodeRestreint");
  const btnOk      = document.getElementById("btnValiderRestreint");
  const btnAnn     = document.getElementById("btnAnnulerRestreint");

  if (!modal) return;

  if (inputProf)  inputProf.value = "";
  if (inputEleve) inputEleve.value = "";
  if (message)    { message.textContent = ""; message.style.color = "#b00020"; }

  // Affichage initial : on suit la valeur courante du select (défaut = enseignant)
  function majAffichageRole() {
    const estEleve = select && select.value === "eleve";
    if (champProf)  champProf.style.display  = estEleve ? "none" : "block";
    if (champEleve) champEleve.style.display = estEleve ? "block" : "none";
    if (message)    { message.textContent = ""; }
  }

  modal.style.display = "flex";

  const newOk  = btnOk.cloneNode(true);
  const newAnn = btnAnn.cloneNode(true);
  btnOk.replaceWith(newOk);
  btnAnn.replaceWith(newAnn);

  if (select) {
    select.onchange = majAffichageRole;
  }
  majAffichageRole();

  newAnn.addEventListener("click", () => {
    modal.style.display = "none";
  });

  newOk.addEventListener("click", async () => {
    const estEleve = select && select.value === "eleve";
    const code = estEleve
      ? (inputEleve?.value.trim() || "")
      : (inputProf?.value.trim() || "");

    if (!code) {
      if (message) message.textContent = estEleve
        ? "Merci de saisir le mot de passe."
        : "Merci de saisir un code.";
      return;
    }

    const ok = await tenterOuvertureRestreinte(lienCourtCode, code, modeLienCourt, exerciceId, estEleve);
    if (ok) {
      if (!estEleve) codeUtilisateurRestreintValide = code;
      modal.style.display = "none";
    } else {
      if (message) {
        message.textContent = estEleve ? "Mot de passe non reconnu ou expiré." : "Code non reconnu.";
        message.style.color = "#b00020";
      }
    }
  });

  const inputActif = (select && select.value === "eleve") ? inputEleve : inputProf;
  inputActif?.addEventListener("keydown", function onKey(e) {
    if (e.key === "Enter") {
      newOk.click();
    }
  });
}
/*
function afficherModalRestreint(lienCourtCode, modeLienCourt = false, exerciceId = "") {
  const modal   = document.getElementById("modalExerciceRestreint");
  const input   = document.getElementById("inputCodeRestreint");
  const message = document.getElementById("messageCodeRestreint");
  const btnOk   = document.getElementById("btnValiderRestreint");
  const btnAnn  = document.getElementById("btnAnnulerRestreint");

  if (!modal) return;

  if (input) input.value = "";
  if (message) { message.textContent = ""; message.style.color = "#b00020"; }

  modal.style.display = "flex";

  const newOk  = btnOk.cloneNode(true);
  const newAnn = btnAnn.cloneNode(true);
  btnOk.replaceWith(newOk);
  btnAnn.replaceWith(newAnn);

  newAnn.addEventListener("click", () => {
    modal.style.display = "none";
  });

  newOk.addEventListener("click", async () => {
    const code = input?.value.trim() || "";
    if (!code) {
      if (message) message.textContent = "Merci de saisir un code.";
      return;
    }

    const ok = await tenterOuvertureRestreinte(lienCourtCode, code, modeLienCourt, exerciceId);
    if (ok) {
      codeUtilisateurRestreintValide = code;
      modal.style.display = "none";
    } else {
      if (message) {
        message.textContent = "Code non reconnu.";
        message.style.color = "#b00020";
      }
    }
  });

  input?.addEventListener("keydown", function onKey(e) {
    if (e.key === "Enter") {
      input.removeEventListener("keydown", onKey);
      newOk.click();
    }
  });
}
*/
async function tenterOuvertureRestreinte(lienCourtCode, code, modeLienCourt = false, exerciceId = "", estEleve = false) {
  try {
    const payload = estEleve
      ? { mot_de_passe_eleve: code, lien_court: lienCourtCode }
      : { code_utilisateur: code, lien_court: lienCourtCode };

    const response = await fetch("https://physalgo.fr/Dariush_Commun/get_lien_exercice_restreint.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) return false;

    // Mode lien court : afficher la zone lien court + copier dans le presse-papier
    if (modeLienCourt) {
      const urlCourte = "https://physalgo.fr/Dariush_Python/index.html?exo=" + encodeURIComponent(lienCourtCode);

      // Afficher la zone lien court sous l'exercice
      document.querySelectorAll(".zone-lien-court-exercice").forEach(el => {
        el.style.display = "none";
      });
      const zoneLien = document.getElementById("zone-lien-court-" + exerciceId);
      if (zoneLien) {
        zoneLien.style.display = "block";
      }

      // Copier dans le presse-papier
      try {
        await navigator.clipboard.writeText(urlCourte);
        const btn = document.querySelector(
          ".btn-lien-court-exercice-restreint[data-exercice-id=\"" + exerciceId + "\"]"
        );
        if (btn) {
          const ancien = btn.textContent;
          btn.textContent = "✓";
          setTimeout(() => { btn.textContent = ancien; }, 1000);
        }
      } catch (err) {
        console.warn("Impossible de copier le lien court.", err);
      }
      return true;
    }

    const ok = await decode_url(data.lien);
    if (!ok) return false;

    // Ouvrir un exercice = nouveau fichier : mémoire Python propre (sinon les
    // globales du fichier précédent, ex. "from PIL.Image import *", subsistent).
    if (window.PagesMultiples && typeof window.PagesMultiples.resetPythonNotebookMemory === "function") {
      window.PagesMultiples.resetPythonNotebookMemory();
    }

    if (typeof window.resetLoadedPageUi === "function") {
      window.resetLoadedPageUi();
    }
    if (window.PythonAutosave?.saveNow) {
      window.PythonAutosave.saveNow();
    }

    hideMenuPanels();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return true;

  } catch (err) {
    console.error("Erreur exercice restreint :", err);
    return false;
  }
}

/*
async function tenterOuvertureRestreinte(lienCourtCode, code, modeLienCourt = false, exerciceId = "") {
  try {
    const response = await fetch("https://physalgo.fr/Dariush_Commun/get_lien_exercice_restreint.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code_utilisateur: code,
        lien_court: lienCourtCode
      })
    });

    const data = await response.json();
    if (!response.ok) return false;

    // Mode lien court : afficher la zone lien court + copier dans le presse-papier
    if (modeLienCourt) {
      const urlCourte = "https://physalgo.fr/Dariush_Python/index.html?exo=" + encodeURIComponent(lienCourtCode);

      // Afficher la zone lien court sous l'exercice
      document.querySelectorAll(".zone-lien-court-exercice").forEach(el => {
        el.style.display = "none";
      });
      const zoneLien = document.getElementById("zone-lien-court-" + exerciceId);
      if (zoneLien) {
        zoneLien.style.display = "block";
      }

      // Copier dans le presse-papier
      try {
        await navigator.clipboard.writeText(urlCourte);
        const btn = document.querySelector(
          ".btn-lien-court-exercice-restreint[data-exercice-id=\"" + exerciceId + "\"]"
        );
        if (btn) {
          const ancien = btn.textContent;
          btn.textContent = "✓";
          setTimeout(() => { btn.textContent = ancien; }, 1000);
        }
      } catch (err) {
        console.warn("Impossible de copier le lien court.", err);
      }
      return true;
    }

    const ok = await decode_url(data.lien);
    if (!ok) return false;

    if (typeof window.resetLoadedPageUi === "function") {
      window.resetLoadedPageUi();
    }
    if (window.PythonAutosave?.saveNow) {
      window.PythonAutosave.saveNow();
    }

    hideMenuPanels();
    window.scrollTo({ top: 0, behavior: "smooth" });
    return true;

  } catch (err) {
    console.error("Erreur exercice restreint :", err);
    return false;
  }
}
*/
// =============================
// ARBRE DE SELECTION D'UN EXERCICE
// =============================

/* Les panneaux Supprimer, Modifier et Corriger presentent la liste des
   exercices du prof avec les memes menus par niveau que la fenetre de
   recherche.

   Le <select> reste dans le DOM, masque, et continue de porter la
   valeur choisie : tout le code d'enregistrement lit select.value.
   L'arbre ne sert qu'a choisir. */

// Un etat par arbre, indexe par l'id de son conteneur.
const arbresSelectionExercice = {};

function initialiserArbreSelectionExercice(idArbre, idSelect, exercices, options = {}) {
  arbresSelectionExercice[idArbre] = {
    idSelect,
    exercices: Array.isArray(exercices) ? exercices : [],
    clesDepliees: [],
    marquerCorrections: options.marquerCorrections === true
  };

  afficherArbreSelectionExercice(idArbre);
}

function reinitialiserArbreSelectionExercice(idArbre) {
  delete arbresSelectionExercice[idArbre];

  const zone = document.getElementById(idArbre);
  if (zone) zone.innerHTML = "";
}

// Contrairement a la fenetre de recherche, les corrections comptent ici :
// on peut vouloir en supprimer une.
function exercicesDuMenuSelection(menu, etat) {
  return etat.exercices.filter(ex => menu.niveaux.includes(ex.niveau));
}

// Niveaux presents chez le prof mais absents de ARBRE_NIVEAUX (valeur ancienne
// ou inattendue) : ils finissent dans un menu "Autre niveau" pour rester
// accessibles, sinon un exercice deviendrait impossible a modifier ou supprimer.
function menuAutresNiveaux(etat) {
  const connus = new Set();
  for (const menu of ARBRE_NIVEAUX) {
    for (const niv of menu.niveaux) connus.add(niv);
  }

  const inconnus = [];
  for (const ex of etat.exercices) {
    if (!connus.has(ex.niveau) && !inconnus.includes(ex.niveau)) {
      inconnus.push(ex.niveau);
    }
  }

  if (inconnus.length === 0) return null;

  return { cle: "autres", libelle: "Autre niveau", niveaux: inconnus };
}

function libelleExerciceSelection(ex, etat) {
  if (etat.marquerCorrections && estCorrection(ex.descriptif)) {
    return (descriptifSansSuffixe(ex.descriptif) || "Exercice sans titre") + " — Corrigé";
  }
  return ex.descriptif || "Exercice sans titre";
}

function construireBlocMenuSelectionHtml(menu, etat, profondeur) {
  const aSousMenus = Array.isArray(menu.sousMenus) && menu.sousMenus.length > 0;
  const estDeplie  = etat.clesDepliees.includes(menu.cle);
  const exos       = exercicesDuMenuSelection(menu, etat);
  const cleAttr    = escapeHtml(menu.cle);

  const classes = "niveau-menu"
    + (profondeur > 0 ? " niveau-sous-menu-titre" : "")
    + (exos.length === 0 ? " est-vide" : "");

  let html = `<div class="niveau-bloc">`
    + `<button type="button" class="${classes}" data-deplier="${cleAttr}" aria-expanded="${estDeplie ? "true" : "false"}">`
    +   `<span class="niveau-fleche">${estDeplie ? "▾" : "▸"}</span>`
    +   `<span class="niveau-libelle">${escapeHtml(menu.libelle)}</span>`
    +   `<span class="niveau-compteur">(${exos.length})</span>`
    + `</button>`
    + `<div class="niveau-contenu" style="display:${estDeplie ? "block" : "none"};">`;

  if (aSousMenus) {
    for (const sous of menu.sousMenus) {
      html += construireBlocMenuSelectionHtml(sous, etat, profondeur + 1);
    }
  } else if (exos.length === 0) {
    html += `<p class="niveau-vide">Aucun exercice dans cette partie.</p>`;
  } else {
    html += `<ul class="liste-choix-exercices">`;

    for (const ex of exos) {
      const id = String(ex.id ?? "");
      const estChoisi = id !== "" && id === String(etat.selection ?? "");

      html += `<li>`
            + `<button type="button" class="choix-exercice${estChoisi ? " est-choisi" : ""}" data-exercice-id="${escapeHtml(id)}">`
            +   escapeHtml(libelleExerciceSelection(ex, etat))
            + `</button>`
            + `</li>`;
    }

    html += `</ul>`;
  }

  html += `</div></div>`;

  return html;
}

function afficherArbreSelectionExercice(idArbre) {
  const zone = document.getElementById(idArbre);
  const etat = arbresSelectionExercice[idArbre];
  if (!zone || !etat) return;

  // Le <select> masque reste la source de verite de la selection.
  const select = document.getElementById(etat.idSelect);
  etat.selection = select?.value || "";

  if (etat.exercices.length === 0) {
    zone.innerHTML = `<p class="niveau-vide">Aucun exercice n'est associé à ce compte.</p>`;
    return;
  }

  let html = "";

  for (const menu of ARBRE_NIVEAUX) {
    html += construireBlocMenuSelectionHtml(menu, etat, 0);
  }

  const autres = menuAutresNiveaux(etat);
  if (autres) {
    html += construireBlocMenuSelectionHtml(autres, etat, 0);
  }

  zone.innerHTML = html;

  attacherEvenementsArbreSelection(idArbre, zone);
}

function attacherEvenementsArbreSelection(idArbre, zone) {
  const etat = arbresSelectionExercice[idArbre];
  if (!etat) return;

  zone.querySelectorAll(".niveau-menu").forEach(btn => {
    btn.addEventListener("click", () => {
      const cle = btn.dataset.deplier || "";

      if (etat.clesDepliees.includes(cle)) {
        etat.clesDepliees = etat.clesDepliees.filter(c => c !== cle);
      } else {
        etat.clesDepliees.push(cle);
      }

      afficherArbreSelectionExercice(idArbre);
    });
  });

  zone.querySelectorAll(".choix-exercice").forEach(btn => {
    btn.addEventListener("click", () => {
      const select = document.getElementById(etat.idSelect);
      if (!select) return;

      select.value = btn.dataset.exerciceId || "";

      // On declenche le onchange du <select> pour que les resumes et les
      // champs du formulaire se mettent a jour.
      if (typeof select.onchange === "function") select.onchange();

      afficherArbreSelectionExercice(idArbre);
    });
  });
}

// =============================
// SUPPRIMER
// =============================

function resetSupprimerPanel() {
  codeUtilisateurSuppressionValide = "";
  exercicesUtilisateurSuppression = [];

  const msgVerif = document.getElementById("messageVerificationSuppression");
  const msgSupp = document.getElementById("messageSuppressionExercice");
  const resume = document.getElementById("resumeExerciceSuppression");
  const select = document.getElementById("selectExerciceSuppression");
  const etapeCode = document.getElementById("supprimerEtapeCode");
  const etapeFormulaire = document.getElementById("supprimerEtapeFormulaire");

  if (msgVerif) msgVerif.textContent = "";
  if (msgSupp) msgSupp.textContent = "";
  if (resume) resume.textContent = "";
  if (select) select.innerHTML = `<option value="">Aucun exercice chargé</option>`;
  if (etapeCode) etapeCode.style.display = "block";
  if (etapeFormulaire) etapeFormulaire.style.display = "none";

  reinitialiserArbreSelectionExercice("arbreExerciceSuppression");
}

async function verifierCodeSuppression() {
  const code = document.getElementById("verificationCodeSuppression")?.value.trim() || "";
  const message = document.getElementById("messageVerificationSuppression");

  if (!code) {
    if (message) { message.textContent = "Merci d'entrer un code utilisateur."; message.style.color = "#b00020"; }
    return;
  }

  try {
    const response = await fetch("https://physalgo.fr/Dariush_Commun/verifier_code_utilisateur.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code_utilisateur: code })
    });

    const data = await response.json();

    if (!response.ok || !data.valide) {
      if (message) { message.textContent = data.error || "Code utilisateur non reconnu."; message.style.color = "#b00020"; }
      return;
    }

    codeUtilisateurSuppressionValide = code;
    if (message) { message.textContent = "Code utilisateur reconnu."; message.style.color = "#2e7d32"; }

    document.getElementById("supprimerEtapeCode").style.display = "none";
    document.getElementById("supprimerEtapeFormulaire").style.display = "block";

    await chargerExercicesUtilisateurPourSuppression();
  } catch (error) {
    if (message) { message.textContent = "Erreur lors de la vérification du code utilisateur."; message.style.color = "#b00020"; }
    console.error("Erreur vérification code suppression :", error);
  }
}

async function chargerExercicesUtilisateurPourSuppression() {
  const select = document.getElementById("selectExerciceSuppression");
  const resume = document.getElementById("resumeExerciceSuppression");
  const message = document.getElementById("messageSuppressionExercice");

  if (message) message.textContent = "";
  if (resume) resume.textContent = "";
  if (select) select.innerHTML = `<option value="">Chargement...</option>`;

  try {
    const response = await fetch("https://physalgo.fr/Dariush_Commun/get_mes_exercices.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code_utilisateur: codeUtilisateurSuppressionValide, source: getDariushSource() })
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Impossible de charger vos exercices.");
    }

    exercicesUtilisateurSuppression = Array.isArray(data.exercices) ? data.exercices : [];

    if (!select) return;

    if (exercicesUtilisateurSuppression.length === 0) {
      select.innerHTML = `<option value="">Aucun exercice trouvé</option>`;
      if (resume) resume.textContent = "Aucun exercice n'est associé à ce compte.";
      initialiserArbreSelectionExercice("arbreExerciceSuppression", "selectExerciceSuppression", []);
      return;
    }

    let html = `<option value="">Choisissez un exercice</option>`;
    for (const ex of exercicesUtilisateurSuppression) {
      // Affichage propre : les corrections sont libellées "… — Corrigé"
      let libelle;
      if (estCorrection(ex.descriptif)) {
        libelle = `[${escapeHtml(ex.niveau || "")}] ${escapeHtml(descriptifSansSuffixe(ex.descriptif) || "Exercice sans titre")} — Corrigé`;
      } else {
        libelle = `[${escapeHtml(ex.niveau || "")}] ${escapeHtml(ex.descriptif || "Exercice sans titre")}`;
      }
      html += `<option value="${ex.id}">${libelle}</option>`;
    }
    select.innerHTML = html;
    select.onchange = afficherResumeExerciceSuppression;

    // Les corrections sont supprimables : on les garde dans l'arbre, libellees.
    initialiserArbreSelectionExercice(
      "arbreExerciceSuppression",
      "selectExerciceSuppression",
      exercicesUtilisateurSuppression,
      { marquerCorrections: true }
    );

  } catch (error) {
    if (select) select.innerHTML = `<option value="">Erreur de chargement</option>`;
    if (message) { message.textContent = error.message || "Impossible de charger vos exercices."; message.style.color = "#b00020"; }
    console.error("Erreur chargement exercices utilisateur :", error);
  }
}

function afficherResumeExerciceSuppression() {
  const select = document.getElementById("selectExerciceSuppression");
  const resume = document.getElementById("resumeExerciceSuppression");
  if (!select || !resume) return;

  const id = Number(select.value);
  if (!id) { resume.textContent = ""; return; }

  const exercice = exercicesUtilisateurSuppression.find(ex => Number(ex.id) === id);
  if (!exercice) { resume.textContent = ""; return; }

  //resume.textContent = `Niveau : ${exercice.niveau} — Descriptif : ${exercice.descriptif}`;
  resume.textContent = "";
}

async function supprimerExerciceUtilisateur() {
  const select = document.getElementById("selectExerciceSuppression");
  const message = document.getElementById("messageSuppressionExercice");

  const exerciceId = select?.value || "";

  if (!codeUtilisateurSuppressionValide) {
    if (message) { message.textContent = "Code utilisateur non validé."; message.style.color = "#b00020"; }
    return;
  }

  if (!exerciceId) {
    if (message) { message.textContent = "Merci de sélectionner un exercice."; message.style.color = "#b00020"; }
    return;
  }

  const confirmation = window.confirm("Voulez-vous vraiment supprimer cet exercice ?");
  if (!confirmation) return;

  try {
    const response = await fetch("https://physalgo.fr/Dariush_Commun/supprimer_exercice.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code_utilisateur: codeUtilisateurSuppressionValide,
        exercice_id: exerciceId,
        source: getDariushSource()
      })
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(data.error || "Suppression impossible.");
    }

    if (message) { message.textContent = "Exercice supprimé avec succès."; message.style.color = "#2e7d32"; }
    setTimeout(() => showMenuPanel('panel-enseignant'), 1500);

  } catch (error) {
    if (message) { message.textContent = error.message || "Erreur lors de la suppression."; message.style.color = "#b00020"; }
    console.error("Erreur suppression exercice :", error);
  }
}

// =============================
// MODIFIER UN EXERCICE
// =============================

function resetModifierPanel() {
  codeUtilisateurModificationValide = "";
  exercicesUtilisateurModification = [];

  const msgVerif    = document.getElementById("messageVerificationModification");
  const msgModif    = document.getElementById("messageModificationExercice");
  const resume      = document.getElementById("resumeExerciceModification");
  const select      = document.getElementById("selectExerciceModification");
  const titre       = document.getElementById("titreExerciceModification");
  const niveauSelect = document.getElementById("niveauExerciceModification");
  const checkbox    = document.getElementById("accesRestreintModification");
  const etapeCode   = document.getElementById("modifierEtapeCode");
  const etapeForm   = document.getElementById("modifierEtapeFormulaire");

  if (msgVerif)     msgVerif.textContent = "";
  if (msgModif)     msgModif.textContent = "";
  if (resume)       resume.textContent = "";
  if (titre)        titre.value = "";
  if (niveauSelect) niveauSelect.value = "premiere";
  if (checkbox)     checkbox.checked = false;
  if (select)       select.innerHTML = `<option value="">Aucun exercice chargé</option>`;
  if (etapeCode)    etapeCode.style.display = "block";
  if (etapeForm)    etapeForm.style.display = "none";

  // Le panneau de correction partage le même code utilisateur : on le remet
  // à zéro en même temps.
  const selectCorr   = document.getElementById("selectExerciceCorrection");
  const resumeCorr   = document.getElementById("resumeExerciceCorrection");
  const msgCorr      = document.getElementById("messageCorrectionExercice");
  const checkboxCorr = document.getElementById("accesRestreintCorrection");

  if (selectCorr)   selectCorr.innerHTML = `<option value="">Aucun exercice chargé</option>`;
  if (resumeCorr)   resumeCorr.textContent = "";
  if (msgCorr)      msgCorr.textContent = "";
  // Un corrigé est réservé par défaut : à décocher pour le rendre public.
  if (checkboxCorr) checkboxCorr.checked = true;

  reinitialiserArbreSelectionExercice("arbreExerciceModification");
  reinitialiserArbreSelectionExercice("arbreExerciceCorrection");
}

// mode = "modifier" (formulaire de modification) ou "corriger" (panneau de
// correction). Le code utilisateur est le même dans les deux cas.
async function verifierCodeModification(mode = "modifier") {
  const code    = document.getElementById("verificationCodeModification")?.value.trim() || "";
  const message = document.getElementById("messageVerificationModification");

  if (!code) {
    if (message) { message.textContent = "Merci d'entrer un code utilisateur."; message.style.color = "#b00020"; }
    return;
  }

  try {
    const response = await fetch("https://physalgo.fr/Dariush_Commun/verifier_code_utilisateur.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code_utilisateur: code })
    });

    const data = await response.json();

    if (!response.ok || !data.valide) {
      if (message) { message.textContent = data.error || "Code utilisateur non reconnu."; message.style.color = "#b00020"; }
      return;
    }

    codeUtilisateurModificationValide = code;
    if (message) { message.textContent = "Code utilisateur reconnu."; message.style.color = "#2e7d32"; }

    if (mode === "corriger") {
      // La correction a son propre panneau, qui porte déjà son titre.
      showMenuPanel("panel-corriger");
    } else {
      document.getElementById("modifierEtapeCode").style.display = "none";
      document.getElementById("modifierEtapeFormulaire").style.display = "block";

      // Le panneau s'intitule "Modifier ou corriger un exercice" à l'étape du
      // code : une fois le choix fait, le titre se précise.
      const { title } = getMenuModalElements();
      if (title) title.textContent = "Modifier un exercice";
    }

    await chargerExercicesUtilisateurPourModification();

  } catch (error) {
    if (message) { message.textContent = "Erreur lors de la vérification."; message.style.color = "#b00020"; }
    console.error("Erreur vérification code modification :", error);
  }
}

async function chargerExercicesUtilisateurPourModification() {
  const select  = document.getElementById("selectExerciceModification");
  const resume  = document.getElementById("resumeExerciceModification");
  const message = document.getElementById("messageModificationExercice");

  if (message) message.textContent = "";
  if (resume)  resume.textContent = "";
  if (select)  select.innerHTML = `<option value="">Chargement...</option>`;

  try {
    const response = await fetch("https://physalgo.fr/Dariush_Commun/get_mes_exercices.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code_utilisateur: codeUtilisateurModificationValide, source: getDariushSource() })
    });

    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Impossible de charger vos exercices.");

    const tousExercices = Array.isArray(data.exercices) ? data.exercices : [];
    // On masque les corrections : on ne modifie/sélectionne que des exercices normaux.
    exercicesUtilisateurModification = tousExercices.filter(ex => !estCorrection(ex.descriptif));

    // Le même chargement sert aux deux panneaux (modifier et corriger).
    const selectCorr = document.getElementById("selectExerciceCorrection");

    if (exercicesUtilisateurModification.length === 0) {
      const vide = `<option value="">Aucun exercice trouvé</option>`;
      if (select)     select.innerHTML = vide;
      if (selectCorr) selectCorr.innerHTML = vide;
      initialiserArbreSelectionExercice("arbreExerciceModification", "selectExerciceModification", []);
      initialiserArbreSelectionExercice("arbreExerciceCorrection", "selectExerciceCorrection", []);
      return;
    }

    // Premiere option vide : avec l'arbre, rien n'est choisi tant que le prof
    // n'a pas cliqué un exercice.
    let html = `<option value="">Choisissez un exercice</option>`;
    for (const ex of exercicesUtilisateurModification) {
      html += `<option value="${ex.id}">[${escapeHtml(formatNiveau(ex.niveau))}] ${escapeHtml(ex.descriptif || "Exercice sans titre")}</option>`;
    }

    if (select) {
      select.innerHTML = html;
      select.onchange = afficherResumeExerciceModification;
      afficherResumeExerciceModification();

      initialiserArbreSelectionExercice(
        "arbreExerciceModification",
        "selectExerciceModification",
        exercicesUtilisateurModification
      );
    }

    if (selectCorr) {
      selectCorr.innerHTML = html;
      selectCorr.onchange = afficherResumeExerciceCorrection;
      afficherResumeExerciceCorrection();

      initialiserArbreSelectionExercice(
        "arbreExerciceCorrection",
        "selectExerciceCorrection",
        exercicesUtilisateurModification
      );
    }

  } catch (error) {
    const erreur = `<option value="">Erreur de chargement</option>`;
    const selectCorr = document.getElementById("selectExerciceCorrection");
    if (select)     select.innerHTML = erreur;
    if (selectCorr) selectCorr.innerHTML = erreur;
    if (message) { message.textContent = error.message; message.style.color = "#b00020"; }
    console.error("Erreur chargement exercices pour modification :", error);
  }
}

// Résumé du panneau de correction : rappelle ce que la page active va devenir.
function afficherResumeExerciceCorrection() {
  const select   = document.getElementById("selectExerciceCorrection");
  const resume   = document.getElementById("resumeExerciceCorrection");
  const checkbox = document.getElementById("accesRestreintCorrection");
  if (!select) return;

  // Un corrigé est réservé par défaut, quel que soit l'exercice choisi.
  if (checkbox) checkbox.checked = true;

  const id = Number(select.value);
  const exercice = exercicesUtilisateurModification.find(ex => Number(ex.id) === id);

  if (!resume) return;

  if (!exercice) {
    resume.textContent = "";
    return;
  }

  resume.textContent = "La page active deviendra le corrigé de « "
    + (exercice.descriptif || "Exercice sans titre")
    + " » (niveau " + formatNiveau(exercice.niveau) + ").";
}

function afficherResumeExerciceModification() {
  const select       = document.getElementById("selectExerciceModification");
  const resume       = document.getElementById("resumeExerciceModification");
  const titre        = document.getElementById("titreExerciceModification");
  const niveauSelect = document.getElementById("niveauExerciceModification");
  const checkbox     = document.getElementById("accesRestreintModification");
  if (!select) return;

  const id = Number(select.value);
  if (!id) {
    if (resume)       resume.textContent = "";
    if (titre)        titre.value = "";
    if (niveauSelect) niveauSelect.value = "premiere";
    if (checkbox)     checkbox.checked = false;
    return;
  }

  const exercice = exercicesUtilisateurModification.find(ex => Number(ex.id) === id);
  if (!exercice) {
    if (resume) resume.textContent = "";
    return;
  }

  if (titre)        titre.value = exercice.descriptif || "";
  if (niveauSelect) niveauSelect.value = exercice.niveau || "premiere";
  if (checkbox)     checkbox.checked = !!parseInt(exercice.acces_restreint || 0);
  if (resume)       resume.textContent = `Niveau : ${exercice.niveau} — Descriptif actuel : ${exercice.descriptif}`;
}

/* Transforme le markdown d'une page de corrigé :
   [AIDE:qx] -> [REP:qx], puis insère [FINREP:qx] selon la règle cas 1 / cas 2.
   Reçoit le markdown JOINT d'une page (cellules séparées par MD_SEP). */
function transformCorrigeMarkdown(commentValue) {
  const SEP = window.MD_SEP || "\n\u0000===DARIUSH-MD-SEP===\u0000\n";
  const cells = String(commentValue ?? "").split(SEP);

  // 1) [AIDE:qx] -> [REP:qx] dans toutes les cellules
  for (let i = 0; i < cells.length; i++) {
    cells[i] = cells[i].replace(/\[AIDE:([A-Za-z0-9_\-]+)\]/g, "[REP:$1]");
  }

  // position du prochain marqueur [REP]/[AIDE] dans str à partir de 'from' (ou -1)
  function nextMarkerPos(str, from) {
    const sub = str.slice(from);
    const idx = sub.search(/\[(REP|AIDE):[A-Za-z0-9_\-]+\]/);
    return idx === -1 ? -1 : from + idx;
  }

  const inserts = []; // { cell, pos, text }
  const dejaFait = new Set();

  for (let c = 0; c < cells.length; c++) {
    const repRe = /\[REP:([A-Za-z0-9_\-]+)\]/g;
    let m;
    while ((m = repRe.exec(cells[c])) !== null) {
      const qx = m[1];
      const finTag = "[FINREP:" + qx + "]";

      // idempotence : si un [FINREP:qx] existe déjà (re-sauvegarde, ou posé à la
      // main), on ne touche pas. Le prof garde le contrôle.
      if (dejaFait.has(qx) || commentValue.indexOf(finTag) !== -1) continue;
      dejaFait.add(qx);

      const after = m.index + m[0].length;

      // texte après le marqueur, dans la même cellule, avant le prochain marqueur ?
      let bornInCell = nextMarkerPos(cells[c], after);
      if (bornInCell === -1) bornInCell = cells[c].length;
      const segment = cells[c].slice(after, bornInCell);

      if (segment.replace(/[\s\u0000]/g, "") !== "") {
        // CAS 1 : du texte suit dans la même cellule
        //         -> [FINREP] juste avant le marqueur suivant, sinon fin de cellule
        inserts.push({ cell: c, pos: bornInCell, text: finTag });
      } else if (c + 1 < cells.length) {
        // CAS 2 : rien dans cette cellule -> cellule suivante,
        //         le plus loin possible mais avant tout nouveau [AIDE]/[REP]
        let born = nextMarkerPos(cells[c + 1], 0);
        if (born === -1) born = cells[c + 1].length;
        inserts.push({ cell: c + 1, pos: born, text: finTag });
      } else {
        // pas de cellule suivante (ex. complétion de code) -> fin de cellule courante
        inserts.push({ cell: c, pos: cells[c].length, text: finTag });
      }
    }
  }

  // application : par cellule, de la position la plus grande à la plus petite
  inserts.sort((a, b) => (b.cell - a.cell) || (b.pos - a.pos));
  for (const ins of inserts) {
    const cell = cells[ins.cell];
    cells[ins.cell] = cell.slice(0, ins.pos) + " " + ins.text + cell.slice(ins.pos);
  }

  return cells.join(SEP);
}



async function modifierExerciceUtilisateur() {
  const select       = document.getElementById("selectExerciceModification");
  const titre        = document.getElementById("titreExerciceModification");
  const niveauSelect = document.getElementById("niveauExerciceModification");
  const checkbox     = document.getElementById("accesRestreintModification");
  const message      = document.getElementById("messageModificationExercice");

  const exerciceId     = select?.value || "";
  const nouveauTitre   = titre?.value.trim() || "";
  const nouveauNiveau  = niveauSelect?.value || "premiere";
  const accesRestreint = checkbox?.checked || false;

  if (!codeUtilisateurModificationValide) {
    if (message) { message.textContent = "Code utilisateur non validé."; message.style.color = "#b00020"; }
    return;
  }
  if (!exerciceId) {
    if (message) { message.textContent = "Merci de sélectionner un exercice."; message.style.color = "#b00020"; }
    return;
  }
  if (!nouveauTitre) {
    if (message) { message.textContent = "Le titre ne peut pas être vide."; message.style.color = "#b00020"; }
    return;
  }

  // Confirmation avant toute opération async
  const confirmation = window.confirm(
    `Voulez-vous vraiment remplacer le contenu de "${nouveauTitre}" par la page active ?`
  );
  if (!confirmation) return;

  // Générer le lien long depuis la page active
  let lienLong = "";
  try {
    if (window.PagesMultiples?.saveActivePageFromEditor) {
      window.PagesMultiples.saveActivePageFromEditor();
    }
   
    lienLong = await window.buildLink({ askDate: false });
  } catch (err) {
    if (message) { message.textContent = "Impossible de générer le lien depuis la page active."; message.style.color = "#b00020"; }
    console.error("Erreur buildLink :", err);
    return;
  }

  try {
    const response = await fetch("https://physalgo.fr/Dariush_Commun/modifier_exercice.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code_utilisateur: codeUtilisateurModificationValide,
        exercice_id:      exerciceId,
        lien_long:        lienLong,
        descriptif:       nouveauTitre,
        niveau:           nouveauNiveau,
        acces_restreint:  accesRestreint,
        correction:       false,
        source:           getDariushSource()
      })
    });

    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Modification impossible.");

    if (message) { message.textContent = data.message || "Opération réussie."; message.style.color = "#2e7d32"; }
    setTimeout(() => showMenuPanel('panel-enseignant'), 1500);

  } catch (error) {
    if (message) { message.textContent = error.message || "Erreur lors de la modification."; message.style.color = "#b00020"; }
    console.error("Erreur modification exercice :", error);
  }
}

// =============================
// PROPOSER UNE CORRECTION
// =============================

// La page active devient le corrigé de l'exercice choisi. L'exercice lui-même
// n'est pas touché : c'est modifier_exercice.php, en mode correction, qui crée
// ou remplace un exercice séparé portant le suffixe de correction.
async function corrigerExerciceUtilisateur() {
  const select   = document.getElementById("selectExerciceCorrection");
  const checkbox = document.getElementById("accesRestreintCorrection");
  const message  = document.getElementById("messageCorrectionExercice");

  const exerciceId     = select?.value || "";
  const accesRestreint = checkbox?.checked || false;

  if (!codeUtilisateurModificationValide) {
    if (message) { message.textContent = "Code utilisateur non validé."; message.style.color = "#b00020"; }
    return;
  }
  if (!exerciceId) {
    if (message) { message.textContent = "Merci de sélectionner l'exercice à corriger."; message.style.color = "#b00020"; }
    return;
  }

  const exercice = exercicesUtilisateurModification.find(ex => Number(ex.id) === Number(exerciceId));
  if (!exercice) {
    if (message) { message.textContent = "Exercice introuvable."; message.style.color = "#b00020"; }
    return;
  }

  const titreOrigine = exercice.descriptif || "";

  const confirmation = window.confirm(
    `Voulez-vous créer ou remplacer le corrigé de "${titreOrigine}" avec la page active ? (l'exercice lui-même ne sera pas modifié)`
  );
  if (!confirmation) return;

  // Générer le lien long depuis la page active, avec la transformation
  // propre aux corrigés ([AIDE:qx] -> [REP:qx] + [FINREP:qx]).
  let lienLong = "";
  try {
    if (window.PagesMultiples?.saveActivePageFromEditor) {
      window.PagesMultiples.saveActivePageFromEditor();
    }

    lienLong = await window.buildLink({
      askDate: false,
      transformMarkdown: transformCorrigeMarkdown
    });
  } catch (err) {
    if (message) { message.textContent = "Impossible de générer le lien depuis la page active."; message.style.color = "#b00020"; }
    console.error("Erreur buildLink :", err);
    return;
  }

  try {
    const response = await fetch("https://physalgo.fr/Dariush_Commun/modifier_exercice.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code_utilisateur: codeUtilisateurModificationValide,
        exercice_id:      exerciceId,
        lien_long:        lienLong,
        // Le serveur reconstruit lui-même le titre et le niveau du corrigé à
        // partir de l'exercice d'origine ; on les renvoie quand même car
        // modifier_exercice.php refuse un descriptif vide.
        descriptif:       titreOrigine,
        niveau:           exercice.niveau || "premiere",
        acces_restreint:  accesRestreint,
        correction:       true,
        source:           getDariushSource()
      })
    });

    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Correction impossible.");

    if (message) { message.textContent = data.message || "Correction enregistrée."; message.style.color = "#2e7d32"; }
    setTimeout(() => showMenuPanel('panel-enseignant'), 1500);

  } catch (error) {
    if (message) { message.textContent = error.message || "Erreur lors de l'enregistrement de la correction."; message.style.color = "#b00020"; }
    console.error("Erreur correction exercice :", error);
  }
}

// =============================
// EXPOSITION GLOBALE
// =============================

window.ouvrirRechercheExercices = ouvrirRechercheExercices;
window.verifierCodeSuppression = verifierCodeSuppression;
window.supprimerExerciceUtilisateur = supprimerExerciceUtilisateur;
window.resetSupprimerPanel = resetSupprimerPanel;
window.verifierCodeModification = verifierCodeModification;
window.modifierExerciceUtilisateur = modifierExerciceUtilisateur;
window.corrigerExerciceUtilisateur = corrigerExerciceUtilisateur;
window.resetModifierPanel = resetModifierPanel;

// =============================
// INITIALISATION
// =============================

document.addEventListener("DOMContentLoaded", () => {
  const dropdown = document.getElementById("dropdownExercices");
  const btn = document.getElementById("btnExercices");

  if (dropdown && btn) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.classList.toggle("open");
    });

    document.addEventListener("click", () => {
      closeDropdown();
    });
  }
});

document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.getElementById("topBarToggle");
  const menu = document.getElementById("topBarMenu");

  if (!toggle || !menu) return;

  toggle.addEventListener("click", () => {
    const isOpen = menu.classList.toggle("open");
    toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 820) {
      menu.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");
    }
  });
});

/* ══════════════════════════════════════════════════════════════
   BASCULE ENTRE DARIUSH PYTHON ET DARIUSH LINUX
   Appelée par le <select id="dariushAppSelect"> dans la top-bar.
   Vérifie s'il y a du travail en cours, demande confirmation,
   coupe proprement les connexions, efface la sauvegarde, puis redirige.
   ═══════════════════════════════════════════════════════════════ */
window.changerDariushApp = function (selectElement) {
  const url = selectElement && selectElement.value;
  if (!url) return;

  const isLinux = window.location.pathname.includes("Dariush_Linux");

  // Accès aux fonctions de pagesmultiples.js (exposées via window.PagesMultiples)
  const PM = window.PagesMultiples || {};

  // ----- Détection : y a-t-il du travail à perdre ? -----
  let travailEnCours = false;

  // Forcer la sauvegarde de la page active avant lecture
  try {
    if (typeof PM.saveActivePageFromEditor === "function") {
      PM.saveActivePageFromEditor();
    }
  } catch (e) { /* silencieux */ }

  // (a) Au moins une page contient du markdown OU du code (Python)
  try {
    if (typeof PM.getAllPages === "function") {
      const pages = PM.getAllPages() || [];
      // Code par défaut du textarea #codeEditor dans index.html (2 lignes)
      const codeDefaut = '# Exemple de code Python\nprint("Bonjour je suis Dariush Python ! Ecris ton code python")';
      for (const p of pages) {
        const md   = String((p && p.comment) || "").trim();
        const code = String((p && p.code)    || "").trim();
        // Côté Linux le "code" est figé sur "Le terminal du notebook" → on l'ignore
        const codeSignificatif = isLinux
          ? false
          : (code !== "" && code !== codeDefaut);
        if (md !== "" || codeSignificatif) {
          travailEnCours = true;
          break;
        }
      }
    }
  } catch (e) { /* silencieux */ }

  // (b) Côté Linux : terminal connecté
  if (!travailEnCours && isLinux) {
    if (window.__linuxConnected === true || window.__linuxReady === true) {
      travailEnCours = true;
    }
  }

  // ----- Confirmation si travail en cours -----
  if (travailEnCours) {
    const ok = window.confirm(
      "Attention en changeant d'application, vous allez perdre votre travail !"
    );
    if (!ok) {
      // Remettre le select sur l'app courante (option avec data-current="1")
      const optActuelle = selectElement.querySelector('option[data-current="1"]');
      if (optActuelle) {
        selectElement.selectedIndex = optActuelle.index;
      }
      return;
    }
  }

  // ----- Nettoyage robuste : neutraliser TOTALEMENT la sauvegarde -----
  try {
    // 1) Vider l'état en mémoire JS pour que toute tentative de save écrive du vide
    if (typeof PM.setAllPages === "function") {
      try { PM.setAllPages([{ code: "", topLine: 1, comment: "", images: {} }], 0); } catch (_) {}
    }
    // Vider aussi le markdown textarea s'il est encore visible
    const exTextarea = document.getElementById("exerciseText");
    if (exTextarea) exTextarea.value = "";

    // 2) Effacer toutes les clés localStorage utilisées par sauvegarde.js
    localStorage.removeItem("dariush_python_autosave_v2");
    localStorage.removeItem("dariush_python_autosave_v1");
    localStorage.removeItem("dariush_notebook_global_css_v1");

    // 3) Verrouiller setItem pour ces clés (au cas où pagehide tirerait encore)
    const origSetItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = function (key, value) {
      if (
        key === "dariush_python_autosave_v2" ||
        key === "dariush_python_autosave_v1" ||
        key === "dariush_notebook_global_css_v1"
      ) {
        return;
      }
      return origSetItem(key, value);
    };

    // 4) Ré-effacer dans un setTimeout(0) pour attraper toute écriture qui passerait
    //    avant que le navigateur ne décharge la page
    setTimeout(() => {
      try {
        localStorage.removeItem("dariush_python_autosave_v2");
        localStorage.removeItem("dariush_python_autosave_v1");
      } catch (_) {}
    }, 0);
  } catch (e) { /* silencieux */ }

  // ----- Couper proprement les connexions actives -----
  try {
    if (typeof window.leaveGroup === "function") {
      try { window.leaveGroup(); } catch (_) {}
    }
    if (typeof window.leaveAide === "function") {
      try { window.leaveAide(); } catch (_) {}
    }
    if (isLinux) {
      try {
        if (window.__linuxSocket && typeof window.__linuxSocket.emit === "function") {
          window.__linuxSocket.emit("linux_exit");
        }
        if (window.__linuxSocket && typeof window.__linuxSocket.disconnect === "function") {
          window.__linuxSocket.disconnect();
        }
      } catch (_) {}
    }
  } catch (e) { /* silencieux */ }
  // ----- Mettre à jour le sous-titre immédiatement (cosmétique) -----
  try {
    const sub = document.querySelector(".top-bar-left .subtitle-inline");
    if (sub) {
      sub.textContent = url.includes("Dariush_Linux")
        ? "— explorer, créer, partager"
        : url.includes("Dariush_SQL")
        ? "— créer, interroger, partager"
        : "— coder, tester, partager";
    }
  } catch (e) { /* silencieux */ }

 

  // ----- Redirection -----
  window.location.href = url;
};

const VIDEO_AIDE_BASE_URL = window.MODE_PORTABLE 
  ? "https://physalgo.fr/Dariush_Commun/videos/" 
  : "../Dariush_Commun/videos/";

function ouvrirVideoAide(fichier, titre) {
  const overlay = document.getElementById("videoAideOverlay");
  const player  = document.getElementById("videoAidePlayer");
  const titreEl = document.getElementById("videoAideTitre");
  if (!overlay || !player) return;
  titreEl.textContent = titre;
  player.src = VIDEO_AIDE_BASE_URL + fichier;
  player.load();
  overlay.style.display = "flex";
}

function fermerVideoAide(event) {
  // Ferme seulement si clic sur le fond noir (pas sur la fenêtre intérieure)
  if (event && event.target !== document.getElementById("videoAideOverlay")) return;
  const overlay = document.getElementById("videoAideOverlay");
  const player  = document.getElementById("videoAidePlayer");
  if (!overlay || !player) return;
  player.pause();
  player.src = "";
  overlay.style.display = "none";
}