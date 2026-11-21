/*
pagesmultiples.js
Mode "pages liées" / type notebook :
- les variables globales
- les fonctions
- les imports
restent en mémoire d'une exécution à l'autre


*/

/*
pagesmultiples.js
- exécution persistante type notebook
- pagination simple de l'éditeur
- création/suppression/navigation entre pages
*/

(function () {
  "use strict";

  const pagesState = {
    pages: [],
    activeIndex: 0,
    editorReady: false,
    ignoreEditorChanges: false,
    controlsBuilt: false,
    pageIndicatorEl: null,
    prevBtnEl: null,
    nextBtnEl: null,
    addBtnEl: null,
    removeBtnEl: null
  };

  function splitStarImportsLocal(code) {
    const lines = String(code || "").split("\n");
    const starImports = [];
    const mainLines = [];

    for (const line of lines) {
      if (/^\s*from\s+[A-Za-z0-9_\.]+\s+import\s+\*/.test(line)) {
        starImports.push(line);
      } else {
        mainLines.push(line);
      }
    }

    return {
      starImports: starImports.join("\n"),
      mainCode: mainLines.join("\n")
    };
  }


async function executePersistentCode() {
  throw new Error(
    "executePersistentCode n'est plus utilisé : l'exécution Python passe maintenant par le worker."
  );
}

  function clearEditorButKeepPythonMemory() {
    if (!window.pythonEditor) return;

    if (confirm("Effacer seulement le code affiché et garder la mémoire Python ?")) {
      window.pythonEditor.setValue("");

      const linkInput = document.getElementById("generatedLink");
      if (linkInput) {
        linkInput.value = "";
        linkInput.style.display = "none";
      }
    }
  }

async function resetPythonNotebookMemory() {
  if (typeof window.resetWorkerPythonState === "function") {
    await window.resetWorkerPythonState();
    return;
  }

  console.warn("resetWorkerPythonState indisponible.");
}

  function getEditor() {
    return window.pythonEditor || null;
  }

  

  function getCurrentPage() {
    if (!pagesState.pages.length) return null;
    return pagesState.pages[pagesState.activeIndex] || null;
  }

  function getExerciseTextSafe() {
  if (typeof window.getExerciseText === "function") {
    return window.getExerciseText();
  }

  const el = document.getElementById("exerciseText");
  if (!el) return "";

  return String(el.value ?? "").replace(/\r\n/g, "\n").trim();
}
  
  /*function getExerciseTextSafe() {
  if (typeof window.getExerciseText === "function") {
    return window.getExerciseText();
  }

   if (!el) return "";

  return String(el.value ?? "").replace(/\r\n/g, "\n").trim();

   const txt = String(text ?? "").replace(/\r\n/g, "\n").trim();
  el.value = txt;
  autoResizeTextarea(el);
    
    
    
}*/

function setExerciseTextSafe(text) {
  if (typeof window.setExerciseText === "function") {
    window.setExerciseText(text);
    return;
  }

  const el = document.getElementById("exerciseText");
  if (!el) return;

   const txt = String(text ?? "").replace(/\r\n/g, "\n").trim();
  el.value = txt;
  autoResizeTextarea(el);
}
  
  
  
  function getFirstVisibleLineForEditor(editor) {
  if (!editor) return 1;
  const info = editor.getScrollInfo();
  const firstLine0 = editor.lineAtHeight(info.top, "local");
  return firstLine0 + 1;
}

function scrollEditorToTopLine(editor, line1) {
  if (!editor) return;

  let line0 = (parseInt(line1, 10) || 1) - 1;
  if (line0 < 0) line0 = 0;

  const last = editor.lastLine();
  if (line0 > last) line0 = last;

  const y = editor.heightAtLine(line0, "local");

  requestAnimationFrame(() => {
    editor.scrollTo(null, y);
    editor.setCursor({ line: line0, ch: 0 });
    editor.refresh();
  });
}
  
  
  
  
 function saveActivePageFromEditor() {
  // Pendant le chargement d'une page, le conteneur de blocs n'est pas encore
  // synchronisé : toute sauvegarde déclenchée par une cascade (rendu d'images,
  // getAllPages, autosave...) lirait un conteneur périmé et aplatirait markdowns.
  // On bloque donc toute sauvegarde tant que le chargement est en cours.
  if (pagesState.ignoreEditorChanges) return;

  const editor = getEditor();
  const page = getCurrentPage();
  if (!editor || !page) return;

  page.code = editor.getValue();
 // page.topLine = getFirstVisibleLineForEditor(editor);
 //mauvaise idee de memoriser le scroll, trop de bazard dans les fichiers multiples
  page.topLine = 1;

  // Système multi-blocs : si des blocs existent dans le conteneur, on lit
  // chacun séparément (jamais de séparateur mêlé au texte).
  // Sinon, fallback sur l'ancien textarea unique.
  let markdowns = null;
  if (
    window.MarkdownEditor &&
    typeof window.MarkdownEditor.getBlocksMarkdowns === "function"
  ) {
    markdowns = window.MarkdownEditor.getBlocksMarkdowns();
  }

  
 if (Array.isArray(markdowns) && markdowns.length) {
    page.markdowns = markdowns;
    page.comment = (typeof joinMarkdowns === "function")
      ? joinMarkdowns(markdowns)
      : markdowns.join("\n\n");
  } else {
    const comment = getExerciseTextSafe();
    page.comment = comment;
    page.markdowns = [comment];
  }
}
const pageOutputs = new WeakMap(); // objet page -> texte de la derniere execution (session, en memoire)
function loadPageIntoEditor(index, options = {}) {
  const editor = getEditor();
  if (!editor) return;
  if (index < 0 || index >= pagesState.pages.length) return;

  const shouldSaveCurrent = options.saveCurrent !== false;
  const keepScroll = options.keepScroll === true;
  // Changement de structure (notebook par cellules) : la vue reste où elle
  // est et le focus est donné par l'appelant (nouveau markdown, nouveau code).
  const garderVue = options.structure === true;

  if (shouldSaveCurrent) {
    saveActivePageFromEditor();
  }

  // Memorise la fenetre d'execution TEXTE de la page que l'on quitte (lecture
  // AVANT tout nettoyage). Ignoree si keepScroll : c'est le debogueur qui pilote.
  if (shouldSaveCurrent && !keepScroll && typeof window.getCurrentOutputText === "function") {
    const ancienne = pagesState.pages[pagesState.activeIndex];
    if (ancienne) pageOutputs.set(ancienne, window.getCurrentOutputText());
  }

  pagesState.activeIndex = index;
  const page = pagesState.pages[index];

  pagesState.ignoreEditorChanges = true;
  editor.setValue(page.code || "");
  setExerciseTextSafe(page.comment || "");

  // Système multi-blocs : si activé, on génère les blocs depuis page.markdowns.
  if (
    window.MARKDOWNS_MULTIPLES_ACTIFS &&
    window.MarkdownEditor &&
    typeof window.MarkdownEditor.renderMarkdownBlocks === "function"
  ) {
    const mds = (Array.isArray(page.markdowns) && page.markdowns.length)
      ? page.markdowns
      : [String(page.comment || "")];
    window.MarkdownEditor.renderMarkdownBlocks(mds);
  }

  if (typeof window.clearEditorHistory === "function") {
    window.clearEditorHistory();
  }

  pagesState.ignoreEditorChanges = false;

  if (typeof window.resetLoadedPageUi === "function") {
    window.resetLoadedPageUi();
  }

  // IMPORTANT : on restaure la fenetre d'execution APRES resetLoadedPageUi(),
  // car celui-ci fait setOutput("") et effacerait sinon notre restauration.
  // Ignoree en mode debogueur (keepScroll).
  if (!keepScroll && typeof window.setCurrentOutputText === "function") {
    window.setCurrentOutputText(pageOutputs.get(page) || "");
  }

  requestAnimationFrame(() => {
    // Notebook continu en service (scrollContinu.js) : le scroll et le focus
    // sont pilotés par le ruban, on ne les force pas ici (sinon l'écran
    // sauterait en haut). Hors service (travail en groupe, aide, ou drapeau
    // SCROLL_CONTINU_ACTIF absent) : comportement d'origine.
    const rubanActif = window.__rubanEngage === true;

    if (!rubanActif && !garderVue) editor.focus();
    editor.refresh();

    if (!keepScroll && !rubanActif && !garderVue) {
      scrollEditorToTopLine(editor, 1);
      setTimeout(() => {
        const zonePython = document.getElementById("zonePython");
        if (zonePython) zonePython.scrollTop = 0;
        const mainSplit = document.getElementById("mainSplit");
        if (mainSplit) mainSplit.scrollTop = 0;
      }, 200);
    }

    const textarea = document.getElementById("exerciseText");
    if (textarea && typeof autoResizeTextarea === "function") {
      autoResizeTextarea(textarea);
    }

    updatePaginationUi();
  });
}

  function updatePaginationUi() {
    const total = pagesState.pages.length || 1;
    const current = pagesState.activeIndex + 1;

    if (pagesState.pageIndicatorEl) {
      pagesState.pageIndicatorEl.textContent = `${current}/${total}`;
    }

    if (pagesState.prevBtnEl) {
      pagesState.prevBtnEl.disabled = current <= 1;
      pagesState.prevBtnEl.style.opacity = current <= 1 ? "0.5" : "1";
    }

    if (pagesState.nextBtnEl) {
      pagesState.nextBtnEl.disabled = current >= total;
      pagesState.nextBtnEl.style.opacity = current >= total ? "0.5" : "1";
    }

    // Infobulles : on rappelle ce qu'est une page et laquelle est concernée.
    // Linux (CELLULES_MARKDOWN_ACTIF) : pas de zone de code, le terminal
    // est le même pour toutes les pages.
    const sansCode = window.CELLULES_MARKDOWN_ACTIF === true;
    const definition = sansCode
      ? "(une page = un ou plusieurs markdowns)"
      : "(une page = un ou plusieurs markdowns + une zone de code)";
    if (pagesState.addBtnEl) {
      pagesState.addBtnEl.title =
        `Ajouter une page vide juste après la page ${current}/${total}\n` + definition;
    }

    if (pagesState.removeBtnEl) {
      pagesState.removeBtnEl.disabled = total <= 1;
      pagesState.removeBtnEl.style.opacity = total <= 1 ? "0.5" : "1";
      pagesState.removeBtnEl.title = total <= 1
        ? "Impossible de supprimer : il ne reste qu'une seule page\n" + definition
        : `Supprimer la page ${current}/${total}\n` +
          (sansCode ? "(tous ses markdowns)" : "(tous ses markdowns et sa zone de code)");
    }

    // Bouton "Tous" : visible uniquement s'il y a au moins 2 pages.
    const runAllBtn = document.getElementById("runAllButton");
    if (runAllBtn) {
      runAllBtn.style.display = total >= 2 ? "" : "none";
    }

    // Notebook par cellules (cellules.js) : état des boutons de structure.
    if (window.NotebookCellules && typeof window.NotebookCellules.majEtatsVifs === "function") {
      window.NotebookCellules.majEtatsVifs();
    }
  }

  function goToPreviousPage() {
    if (pagesState.activeIndex <= 0) return;
    loadPageIntoEditor(pagesState.activeIndex - 1);
  }

  function goToNextPage() {
    if (pagesState.activeIndex >= pagesState.pages.length - 1) return;
    loadPageIntoEditor(pagesState.activeIndex + 1);
  }

 function addPage() {
  saveActivePageFromEditor();
   
   const newPage = {
  code: "",
  topLine: 1,
  comment: "",
  markdowns: [""],
  images: {}
};

  

  const insertIndex = pagesState.activeIndex + 1;
  pagesState.pages.splice(insertIndex, 0, newPage);
  loadPageIntoEditor(insertIndex, { saveCurrent: false });
}
function removeCurrentPage() {
  if (pagesState.pages.length <= 1) return;

  const ok = confirm(
    `Supprimer la page ${pagesState.activeIndex + 1}/${pagesState.pages.length} ?\n\n` +
    (window.CELLULES_MARKDOWN_ACTIF === true
      ? "Tous ses markdowns seront effacés."
      : "Tous ses markdowns et sa zone de code seront effacés.")
  );

  if (!ok) return;

  const currentIndex = pagesState.activeIndex;

  // on sauvegarde une dernière fois la page active avant suppression
  saveActivePageFromEditor();

  // on supprime réellement la page active
  pagesState.pages.splice(currentIndex, 1);

  let newIndex = currentIndex;
  if (newIndex >= pagesState.pages.length) {
    newIndex = pagesState.pages.length - 1;
  }

  loadPageIntoEditor(newIndex, { saveCurrent: false });
}
// ─────────────────────────────────────────────
  // API MARKDOWNS MULTIPLES — manipulation des blocs de la page active.
  // Le modèle page.markdowns est la source de vérité ; après modification,
  // on régénère l'affichage via MarkdownEditor.renderMarkdownBlocks.
  // ─────────────────────────────────────────────

  // Régénère l'affichage des blocs depuis page.markdowns, et redonne
  // éventuellement le focus en édition au bloc d'index focusIndex.
  function refreshMarkdownBlocksUi(focusIndex) {
    const page = getCurrentPage();
    if (!page) return;
    if (
      !window.MARKDOWNS_MULTIPLES_ACTIFS ||
      !window.MarkdownEditor ||
      typeof window.MarkdownEditor.renderMarkdownBlocks !== "function"
    ) {
      return;
    }

    const mds = (Array.isArray(page.markdowns) && page.markdowns.length)
      ? page.markdowns
      : [""];
    window.MarkdownEditor.renderMarkdownBlocks(mds);

    // Focus en édition sur le bloc demandé (ex : le bloc nouvellement créé).
    if (
      typeof focusIndex === "number" &&
      typeof window.MarkdownEditor.focusBlockEditor === "function"
    ) {
      window.MarkdownEditor.focusBlockEditor(focusIndex);
    }
  }

  // Insère un markdown vide juste APRÈS la position 'index' dans la page active.
  function insertMarkdownAfter(index) {
    if (cellulesActives()) {
      insererCelluleApres(pagesState.activeIndex, index, "markdown");
      return;
    }
    const page = getCurrentPage();
    if (!page) return;

    // 1. Sauver l'état actuel des blocs (ne rien perdre de ce qui est tapé).
    saveActivePageFromEditor();

    // 2. S'assurer que markdowns existe et est cohérent.
    if (!Array.isArray(page.markdowns) || !page.markdowns.length) {
      page.markdowns = [String(page.comment || "")];
    }

    // 3. Insérer un bloc vide après l'index donné (borné proprement).
    let pos = parseInt(index, 10);
    if (!Number.isFinite(pos) || pos < 0) pos = page.markdowns.length - 1;
    if (pos > page.markdowns.length - 1) pos = page.markdowns.length - 1;

    page.markdowns.splice(pos + 1, 0, "");

    // 4. Resynchroniser comment et régénérer l'affichage, focus au nouveau bloc.
    page.comment = (typeof joinMarkdowns === "function")
      ? joinMarkdowns(page.markdowns)
      : page.markdowns.join("\n\n");

    refreshMarkdownBlocksUi(pos + 1);
  }
  // Insère un markdown vide à la position 'pos' de la page active (0 = au-
  // dessus du premier). Sert au "+" du haut de page de Dariush Linux.
  function insertMarkdownAt(pos) {
    const page = getCurrentPage();
    if (!page) return;

    saveActivePageFromEditor();

    if (!Array.isArray(page.markdowns) || !page.markdowns.length) {
      page.markdowns = [String(page.comment || "")];
    }

    let p = parseInt(pos, 10);
    if (!Number.isFinite(p) || p < 0) p = 0;
    if (p > page.markdowns.length) p = page.markdowns.length;

    page.markdowns.splice(p, 0, "");
    page.comment = (typeof joinMarkdowns === "function")
      ? joinMarkdowns(page.markdowns)
      : page.markdowns.join("\n\n");

    refreshMarkdownBlocksUi(p);
  }

  // Supprime le markdown à la position 'index' dans la page active.
  // Refuse de supprimer s'il ne reste qu'un seul bloc (invariant : au moins 1).
  function removeMarkdownAt(index) {
    if (cellulesActives()) {
      couperMarkdown(pagesState.activeIndex, index);
      return;
    }
    const page = getCurrentPage();
    if (!page) return;

    // 1. Sauver l'état actuel des blocs.
    saveActivePageFromEditor();

    // 2. Cohérence du tableau.
    if (!Array.isArray(page.markdowns) || !page.markdowns.length) {
      page.markdowns = [String(page.comment || "")];
    }

    // 3. Invariant : on ne descend jamais en dessous de 1 bloc.
    if (page.markdowns.length <= 1) return;

    // 4. Supprimer le bloc à l'index donné (borné).
    let pos = parseInt(index, 10);
    if (!Number.isFinite(pos) || pos < 0) return;
    if (pos > page.markdowns.length - 1) return;

    page.markdowns.splice(pos, 1);

    // 5. Resynchroniser comment et régénérer l'affichage.
    page.comment = (typeof joinMarkdowns === "function")
      ? joinMarkdowns(page.markdowns)
      : page.markdowns.join("\n\n");

    // Focus sur le bloc qui prend la place (ou le précédent si on a supprimé le dernier).
    const focusIdx = Math.min(pos, page.markdowns.length - 1);
    refreshMarkdownBlocksUi(focusIdx);
  }

// Déplace le markdown d'index 'index' vers le HAUT (permute avec le précédent).
  // Ne fait rien si c'est déjà le premier.
  function moveMarkdownUp(index) {
    if (cellulesActives()) {
      deplacerMarkdown(pagesState.activeIndex, index, -1);
      return;
    }
    const page = getCurrentPage();
    if (!page) return;

    saveActivePageFromEditor();

    if (!Array.isArray(page.markdowns) || !page.markdowns.length) {
      page.markdowns = [String(page.comment || "")];
    }

    let pos = parseInt(index, 10);
    if (!Number.isFinite(pos) || pos <= 0) return; // déjà en haut
    if (pos > page.markdowns.length - 1) return;

    // Permutation avec le bloc précédent.
    const tmp = page.markdowns[pos - 1];
    page.markdowns[pos - 1] = page.markdowns[pos];
    page.markdowns[pos] = tmp;

    page.comment = (typeof joinMarkdowns === "function")
      ? joinMarkdowns(page.markdowns)
      : page.markdowns.join("\n\n");

    // Déplacement : on régénère SANS donner le focus (le bloc reste en aperçu,
    // c.-à-d. validé), contrairement à l'ajout où le focus est souhaité.
    refreshMarkdownBlocksUi();
  }
// Déplace le markdown d'index 'index' vers le BAS (permute avec le suivant).
  // Ne fait rien si c'est déjà le dernier.
  function moveMarkdownDown(index) {
    if (cellulesActives()) {
      deplacerMarkdown(pagesState.activeIndex, index, +1);
      return;
    }
    const page = getCurrentPage();
    if (!page) return;

    saveActivePageFromEditor();

    if (!Array.isArray(page.markdowns) || !page.markdowns.length) {
      page.markdowns = [String(page.comment || "")];
    }

    let pos = parseInt(index, 10);
    if (!Number.isFinite(pos) || pos < 0) return;
    if (pos >= page.markdowns.length - 1) return; // déjà en bas

    // Permutation avec le bloc suivant.
    const tmp = page.markdowns[pos + 1];
    page.markdowns[pos + 1] = page.markdowns[pos];
    page.markdowns[pos] = tmp;

    page.comment = (typeof joinMarkdowns === "function")
      ? joinMarkdowns(page.markdowns)
      : page.markdowns.join("\n\n");

    // Déplacement : on régénère SANS donner le focus (le bloc reste en aperçu,
    // c.-à-d. validé), contrairement à l'ajout où le focus est souhaité.
    refreshMarkdownBlocksUi();
  }

  // ─────────────────────────────────────────────
  // NOTEBOOK PAR CELLULES (drapeau window.NOTEBOOK_CELLULES_ACTIF : Python
  // et SQL ; l'interface est dans cellules.js).
  // Les pages restent le modèle interne : une page = un ou plusieurs
  // markdowns puis UNE zone de code. À plat, le document se lit
  //   md, md, code | md, code | md, md, md, code ...
  // Règles toujours respectées :
  //   - deux zones de code ne se suivent jamais ;
  //   - le document commence par un markdown et finit par une zone de code.
  // Les objets page sont conservés autant que possible : la sortie mémorisée
  // (pageOutputs) reste attachée à sa zone de code quand des markdowns
  // changent de page. Les images collées suivent leur markdown.
  // ─────────────────────────────────────────────
  function cellulesActives() {
    return window.NOTEBOOK_CELLULES_ACTIF === true;
  }

  function mdsDe(page) {
    if (!Array.isArray(page.markdowns) || !page.markdowns.length) {
      page.markdowns = [String(page.comment || "")];
    }
    return page.markdowns;
  }

  function resynchroniser(page) {
    page.comment = (typeof joinMarkdowns === "function")
      ? joinMarkdowns(page.markdowns)
      : page.markdowns.join("\n\n");
  }

  function pageVide() {
    return { code: "", topLine: 1, comment: "", markdowns: [""], images: {} };
  }

  // ── Règles (lecture seule) : { ok, raison } ──────────────────────────────
  // La raison sert d'infobulle au bouton grisé.
  const DEUX_CODES = "deux zones de code se suivraient";

  function verdict(ok, raison) {
    return { ok: !!ok, raison: ok ? "" : String(raison || "") };
  }

  function raisonSeulMarkdown(p) {
    return p === 0
      ? "Impossible : c'est le seul markdown au-dessus de la première zone de code (le document commence toujours par un markdown)"
      : `Impossible : c'est le seul markdown au-dessus de sa zone de code (${DEUX_CODES})`;
  }

  function peutDeplacerMarkdown(p, j, sens) {
    const pages = pagesState.pages;
    const page = pages[p];
    if (!page) return verdict(false, "");
    const n = mdsDe(page).length;
    if (sens < 0) {
      if (j > 0) return verdict(true);
      if (p === 0) return verdict(false, "Déjà en haut du document");
      if (n <= 1) return verdict(false, raisonSeulMarkdown(p));
      return verdict(true);
    }
    if (j < n - 1) return verdict(true);
    if (p === pages.length - 1) {
      return verdict(false, "Impossible : un markdown ne peut pas passer sous la dernière zone de code");
    }
    if (n <= 1) return verdict(false, raisonSeulMarkdown(p));
    return verdict(true);
  }

  function peutCouperMarkdown(p) {
    const page = pagesState.pages[p];
    if (!page) return verdict(false, "");
    if (mdsDe(page).length <= 1) return verdict(false, raisonSeulMarkdown(p));
    return verdict(true);
  }

  function peutDeplacerCode(p, sens) {
    const pages = pagesState.pages;
    const page = pages[p];
    if (!page) return verdict(false, "");
    const derniere = p === pages.length - 1;
    if (sens < 0) {
      if (mdsDe(page).length <= 1) {
        return verdict(false, p === 0
          ? "Impossible : le document commence toujours par un markdown"
          : `Impossible : ${DEUX_CODES}`);
      }
      if (derniere) {
        return verdict(false, "Impossible : un markdown se retrouverait sous la dernière zone de code");
      }
      return verdict(true);
    }
    if (derniere) return verdict(false, "C'est déjà la dernière zone de code");
    if (mdsDe(pages[p + 1]).length <= 1) return verdict(false, `Impossible : ${DEUX_CODES}`);
    return verdict(true);
  }

  // apres : index du markdown sous lequel on insère, "code" (sous la zone
  // de code) ou "debut" (tout en haut du document, page 0).
  // Toujours possible : insererCelluleApres ajoute un markdown vide là où la
  // règle "jamais deux zones de code de suite" l'exige.
  function peutInsererCode(p, apres) {
    const page = pagesState.pages[p];
    if (!page) return verdict(false, "");
    if (apres === "debut" || apres === "code") return verdict(true);
    const j = parseInt(apres, 10);
    if (Number.isFinite(j) && j >= 0 && j < mdsDe(page).length) return verdict(true);
    return verdict(false, "");
  }

  // mode : "page" (markdowns + code) ou "code" (la zone de code seule).
  function peutCouperCode(p, mode) {
    const pages = pagesState.pages;
    if (!pages[p]) return verdict(false, "");
    if (pages.length <= 1) return verdict(false, "Impossible : c'est la seule zone de code du document");
    if (mode === "code" && p === pages.length - 1) {
      return verdict(false, "Impossible pour la dernière zone de code : ses markdowns n'auraient plus de zone de code en dessous");
    }
    return verdict(true);
  }

  // ── Images collées : elles suivent leur markdown d'une page à l'autre ────
  // Même reconnaissance des balises que gestionimages.js.
  function normaliserNomImage(nom) {
    const brut = String(nom || "").trim();
    return brut ? brut.replace(/[\\/:*?"<>|]/g, "_") : "image.jpg";
  }

  function imagesCitees(texte) {
    const noms = new Set();
    const re = /!\[[^\]]*\]\(\s*attachment:([^)]+?)\s*\)/g;
    const source = String(texte || "");
    let m;
    while ((m = re.exec(source)) !== null) {
      const nom = String(m[1] || "").trim();
      if (nom) noms.add(normaliserNomImage(nom));
    }
    return noms;
  }

  function nomImageLibre(images, nom) {
    const point = nom.lastIndexOf(".");
    const base = point > 0 ? nom.slice(0, point) : nom;
    const ext = point > 0 ? nom.slice(point) : "";
    let i = 2;
    let candidat = `${base}_${i}${ext}`;
    while (Object.prototype.hasOwnProperty.call(images, candidat)) {
      i++;
      candidat = `${base}_${i}${ext}`;
    }
    return candidat;
  }

  function renommerReference(texte, ancien, nouveau) {
    const echappe = ancien.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("(!\\[[^\\]]*\\]\\(\\s*attachment:)" + echappe + "(\\s*\\))", "g");
    return texte.replace(re, "$1" + nouveau + "$2");
  }

  // Copie dans dest les images de source citées par les textes qui partent ;
  // un nom déjà pris par une autre image est changé (et la balise avec).
  // Renvoie les textes, balises à jour.
  function emporterImages(source, dest, textes) {
    const depuis = (source.images && typeof source.images === "object") ? source.images : {};
    if (!dest.images || typeof dest.images !== "object") dest.images = {};
    return textes.map((t) => {
      let texte = String(t ?? "");
      imagesCitees(texte).forEach((nom) => {
        const data = depuis[nom];
        if (!data) return;
        let final = nom;
        if (dest.images[final] && dest.images[final] !== data) {
          final = nomImageLibre(dest.images, nom);
          texte = renommerReference(texte, nom, final);
        }
        dest.images[final] = data;
      });
      return texte;
    });
  }

  // Retire de la page de départ les images parties, si plus aucun de ses
  // markdowns ne les cite (même règle que pruneUnusedImages à l'export).
  function oublierImagesParties(page, noms) {
    if (!page.images || typeof page.images !== "object") return;
    const encore = imagesCitees(mdsDe(page).join("\n"));
    noms.forEach((nom) => {
      if (!encore.has(nom)) delete page.images[nom];
    });
  }

  function nomsCitesDans(textes) {
    const noms = new Set();
    textes.forEach((t) => imagesCitees(t).forEach((n) => noms.add(n)));
    return noms;
  }

  // ── Début / fin de toute modification de structure ───────────────────────
  // Début : on fige ce qui est à l'écran (texte, code, sortie de la page
  // active). Fin : page voulue rendue active, affichage, ruban, sauvegarde.
  function debutStructure() {
    saveActivePageFromEditor();
    if (window.ScrollContinu && typeof window.ScrollContinu.avantStructure === "function") {
      window.ScrollContinu.avantStructure();
    }
    const active = getCurrentPage();
    if (active && typeof window.getCurrentOutputText === "function") {
      pageOutputs.set(active, window.getCurrentOutputText());
    }
    return { active, mdsAvant: active ? JSON.stringify(mdsDe(active)) : "" };
  }

  function finStructure(avant, pageVoulue, options = {}) {
    const pages = pagesState.pages;
    let idx = pages.indexOf(pageVoulue);
    if (idx < 0) idx = Math.max(0, Math.min(pagesState.activeIndex, pages.length - 1));

    if (pages[idx] === avant.active) {
      // Même page active (son numéro a pu changer) : on ne régénère ses
      // markdowns que s'ils ont changé (sinon images et saisie restent).
      pagesState.activeIndex = idx;
      const changes = JSON.stringify(mdsDe(pages[idx])) !== avant.mdsAvant;
      if (changes || typeof options.focusMd === "number") {
        refreshMarkdownBlocksUi();
      }
      updatePaginationUi();
    } else {
      loadPageIntoEditor(idx, { saveCurrent: false, structure: true });
    }

    // Le ruban se recompose AVANT de donner le focus (sinon il serait perdu).
    if (window.ScrollContinu && typeof window.ScrollContinu.apresStructure === "function") {
      window.ScrollContinu.apresStructure();
    }

    if (
      typeof options.focusMd === "number" &&
      window.MarkdownEditor &&
      typeof window.MarkdownEditor.focusBlockEditor === "function"
    ) {
      window.MarkdownEditor.focusBlockEditor(options.focusMd);
    }

    if (options.focusCode) {
      requestAnimationFrame(() => {
        const editor = getEditor();
        if (editor) editor.focus();
      });
    }

    // Aucune frappe dans l'éditeur n'a eu lieu : l'enregistrement
    // automatique ne verrait pas le changement.
    setTimeout(() => {
      if (window.PythonAutosave && typeof window.PythonAutosave.saveNow === "function") {
        window.PythonAutosave.saveNow();
      }
    }, 0);
  }

  // ── Opérations ───────────────────────────────────────────────────────────
  // p : index de la page ; j : index du markdown dans la page.

  // "+" sous une cellule. apres : index du markdown, "code", ou "debut"
  // (tout en haut du document). type : "markdown" ou "code".
  // Une zone de code s'insère partout ; un markdown vide est ajouté, sans
  // message, là où il en faut un :
  //   - rien au-dessus (haut du document, juste sous une zone de code) :
  //     markdown vide au-dessus de la nouvelle zone de code ;
  //   - une zone de code juste en dessous : markdown vide entre les deux.
  function insererCelluleApres(p, apres, type) {
    if (!cellulesActives()) return false;
    const pages = pagesState.pages;
    if (!pages[p]) return false;

    if (apres === "debut") {
      if (p !== 0) return false;
      const avant = debutStructure();
      if (type === "code") {
        // Nouvelle première page : markdown vide + la zone de code.
        const nouvelle = pageVide();
        pages.unshift(nouvelle);
        finStructure(avant, nouvelle, { focusCode: true });
        return true;
      }
      const premiere = pages[0];
      mdsDe(premiere).unshift("");
      resynchroniser(premiere);
      finStructure(avant, premiere, { focusMd: 0 });
      return true;
    }

    if (apres === "code") {
      if (type === "code") {
        // Juste sous une zone de code : nouvelle page (markdown vide + la
        // zone de code) ; la page suivante commence déjà par un markdown.
        const avant = debutStructure();
        const nouvelle = pageVide();
        pages.splice(p + 1, 0, nouvelle);
        finStructure(avant, nouvelle, { focusCode: true });
        return true;
      }
      const avant = debutStructure();
      if (p === pages.length - 1) {
        // Sous la dernière zone de code : une page entière (markdown + code).
        const nouvelle = pageVide();
        pages.push(nouvelle);
        finStructure(avant, nouvelle, { focusMd: 0 });
      } else {
        const suivante = pages[p + 1];
        mdsDe(suivante).unshift("");
        resynchroniser(suivante);
        finStructure(avant, suivante, { focusMd: 0 });
      }
      return true;
    }

    const j = parseInt(apres, 10);
    if (!Number.isFinite(j) || j < 0 || j > mdsDe(pages[p]).length - 1) return false;

    if (type === "code") {
      if (!peutInsererCode(p, j).ok) return false;
      const avant = debutStructure();
      const page = pages[p];
      const mds = mdsDe(page);
      // La page est coupée en deux : les markdowns jusqu'à j et le nouveau
      // code forment une nouvelle page, placée avant ; l'ancienne garde son
      // code (et sa sortie) avec les markdowns restants — un markdown vide
      // s'il n'en reste aucun (sinon deux zones de code se suivraient).
      const partants = mds.slice(0, j + 1);
      const restants = mds.slice(j + 1);
      const nouvelle = pageVide();
      nouvelle.markdowns = emporterImages(page, nouvelle, partants);
      page.markdowns = restants.length ? restants : [""];
      oublierImagesParties(page, nomsCitesDans(partants));
      resynchroniser(nouvelle);
      resynchroniser(page);
      pages.splice(p, 0, nouvelle);
      finStructure(avant, nouvelle, { focusCode: true });
      return true;
    }

    const avant = debutStructure();
    const page = pages[p];
    mdsDe(page).splice(j + 1, 0, "");
    resynchroniser(page);
    finStructure(avant, page, { focusMd: j + 1 });
    return true;
  }

  function couperMarkdown(p, j) {
    if (!cellulesActives()) return false;
    const pages = pagesState.pages;
    if (!pages[p] || !Number.isFinite(j) || j < 0 || j >= mdsDe(pages[p]).length) return false;
    if (!peutCouperMarkdown(p).ok) return false;
    const avant = debutStructure();
    const page = pages[p];
    const mds = mdsDe(page);
    mds.splice(j, 1);
    resynchroniser(page);
    // Comme avant : sur la page active, le bloc qui prend la place passe en
    // édition.
    finStructure(avant, avant.active,
      page === avant.active ? { focusMd: Math.min(j, mds.length - 1) } : {});
    return true;
  }

  function deplacerMarkdown(p, j, sens) {
    if (!cellulesActives()) return false;
    const pages = pagesState.pages;
    if (!pages[p] || !Number.isFinite(j) || j < 0 || j >= mdsDe(pages[p]).length) return false;
    if (!peutDeplacerMarkdown(p, j, sens).ok) return false;
    const avant = debutStructure();
    const page = pages[p];
    const mds = mdsDe(page);

    const k = j + (sens < 0 ? -1 : 1);
    if (k >= 0 && k < mds.length) {
      // Dans la même page : simple échange.
      const tmp = mds[k];
      mds[k] = mds[j];
      mds[j] = tmp;
      resynchroniser(page);
      finStructure(avant, avant.active);
      return true;
    }

    // Le markdown franchit une zone de code : il change de page, et on le
    // suit (sa nouvelle page devient la page active).
    const dest = sens < 0 ? pages[p - 1] : pages[p + 1];
    const texte = sens < 0 ? mds.shift() : mds.pop();
    const emporte = emporterImages(page, dest, [texte])[0];
    if (sens < 0) mdsDe(dest).push(emporte);
    else mdsDe(dest).unshift(emporte);
    oublierImagesParties(page, imagesCitees(texte));
    resynchroniser(page);
    resynchroniser(dest);
    finStructure(avant, dest);
    return true;
  }

  // La zone de code échange sa place avec le markdown voisin : c'est la
  // frontière entre deux pages qui bouge. La page du code devient active.
  function deplacerZoneCode(p, sens) {
    if (!cellulesActives()) return false;
    if (!peutDeplacerCode(p, sens).ok) return false;
    const avant = debutStructure();
    const pages = pagesState.pages;
    const page = pages[p];
    const voisine = pages[p + 1];

    if (sens < 0) {
      // Le dernier markdown au-dessus du code passe en tête de la page suivante.
      const texte = mdsDe(page).pop();
      const emporte = emporterImages(page, voisine, [texte])[0];
      mdsDe(voisine).unshift(emporte);
      oublierImagesParties(page, imagesCitees(texte));
    } else {
      // Le premier markdown sous le code rejoint cette page.
      const texte = mdsDe(voisine).shift();
      const emporte = emporterImages(voisine, page, [texte])[0];
      mdsDe(page).push(emporte);
      oublierImagesParties(voisine, imagesCitees(texte));
    }
    resynchroniser(page);
    resynchroniser(voisine);
    finStructure(avant, page);
    return true;
  }

  // mode "page" : la page entière (ses markdowns + sa zone de code).
  // mode "code" : la zone de code seule ; ses markdowns rejoignent la page
  // suivante (impossible pour la dernière zone de code).
  function couperZoneCode(p, mode) {
    if (!cellulesActives()) return false;
    if (mode !== "page" && mode !== "code") return false;
    if (!peutCouperCode(p, mode).ok) return false;
    const avant = debutStructure();
    const pages = pagesState.pages;
    const page = pages[p];
    let voulue = avant.active;

    if (mode === "code") {
      const suivante = pages[p + 1];
      const emportes = emporterImages(page, suivante, mdsDe(page));
      suivante.markdowns = emportes.concat(mdsDe(suivante));
      resynchroniser(suivante);
      pages.splice(p, 1);
      if (avant.active === page) voulue = suivante;
    } else {
      pages.splice(p, 1);
      if (avant.active === page) voulue = pages[Math.min(p, pages.length - 1)];
    }
    finStructure(avant, voulue);
    return true;
  }

  function nombreMarkdowns(p) {
    const page = pagesState.pages[p];
    return page ? mdsDe(page).length : 0;
  }

function buildPaginationControls() {
  if (pagesState.controlsBuilt) return;

  const prevBtn = document.getElementById("pagesPrevButton");
  const nextBtn = document.getElementById("pagesNextButton");
  const addBtn = document.getElementById("pagesAddButton");
  const removeBtn = document.getElementById("pagesRemoveButton");
  const indicator = document.getElementById("pagesMultiplesIndicator");

  // + et ✂ du haut : absents en notebook par cellules (Python, SQL), où l'on
  // ajoute et coupe directement les cellules.
  if (!prevBtn || !nextBtn || !indicator) {
    console.warn("pagesmultiples.js : contrôles de pagination introuvables");
    return;
  }

  prevBtn.addEventListener("click", goToPreviousPage);
  nextBtn.addEventListener("click", goToNextPage);
  if (addBtn) addBtn.addEventListener("click", addPage);
  if (removeBtn) removeBtn.addEventListener("click", removeCurrentPage);

  pagesState.pageIndicatorEl = indicator;
  pagesState.prevBtnEl = prevBtn;
  pagesState.nextBtnEl = nextBtn;
  pagesState.addBtnEl = addBtn;
  pagesState.removeBtnEl = removeBtn;
  pagesState.controlsBuilt = true;

  updatePaginationUi();
}

  function bindEditorChangeSync() {
    const editor = getEditor();
    if (!editor) return;

    editor.on("change", () => {
      if (pagesState.ignoreEditorChanges) return;
      saveActivePageFromEditor();
      updatePaginationUi();
    });
  }

  function initPagesModel() {
    const editor = getEditor();
    if (!editor) return;

    if (!pagesState.pages.length) {
  const initialComment = getExerciseTextSafe();
  pagesState.pages.push({
    code: editor.getValue(),
    topLine: 1,
    comment: initialComment,
    markdowns: [initialComment],
    images: {}
  });
  pagesState.activeIndex = 0;
}

    buildPaginationControls();
    bindEditorChangeSync();
    bindExerciseTextSync();
    updatePaginationUi();

    pagesState.editorReady = true;

    // Démarrage : générer les blocs de la page active si le multi-bloc est actif.
    // (Au démarrage vierge sans sauvegarde, loadPageIntoEditor n'est pas appelé,
    // donc les blocs ne seraient jamais affichés sans ceci.)
    if (
      window.MARKDOWNS_MULTIPLES_ACTIFS &&
      window.MarkdownEditor &&
      typeof window.MarkdownEditor.renderMarkdownBlocks === "function"
    ) {
      const page = pagesState.pages[pagesState.activeIndex];
      const mds = (page && Array.isArray(page.markdowns) && page.markdowns.length)
        ? page.markdowns
        : [String((page && page.comment) || "")];
      window.MarkdownEditor.renderMarkdownBlocks(mds);
    }
  }
  function waitForEditorThenInit() {
    let tries = 0;
    const maxTries = 200;

    const timer = setInterval(() => {
      const editor = getEditor();
      tries++;

      if (editor) {
        clearInterval(timer);
        initPagesModel();
        return;
      }

      if (tries >= maxTries) {
        clearInterval(timer);
        console.warn("pagesmultiples.js : éditeur introuvable");
      }
    }, 50);
  }

  
function getAllPages() {
  saveActivePageFromEditor();
  return pagesState.pages.map((page, index) => {
    const comment = page.comment || "";
    const markdowns = (Array.isArray(page.markdowns) && page.markdowns.length)
      ? page.markdowns.map(m => String(m ?? ""))
      : [comment];

    return {
      index,
      code: page.code || "",
      topLine: page.topLine || 1,
      comment,
      markdowns,
      images: (page && page.images && typeof page.images === "object")
        ? { ...page.images }
        : {}
    };
  });
}

 function bindExerciseTextSync() {
  const textarea = document.getElementById("exerciseText");
  if (!textarea) return;

  textarea.addEventListener("input", () => {
    if (pagesState.ignoreEditorChanges) return;

    const page = getCurrentPage();
    if (!page) return;

    page.comment = getExerciseTextSafe();
  });
} 
  
  
 function setAllPages(pages, activeIndex = 0) {
  const editor = getEditor();
  if (!editor) return;

 const safePages = Array.isArray(pages) && pages.length
  ? pages.map(p => {
      const comment = String((p && p.comment) || "");
      const markdowns = (p && Array.isArray(p.markdowns) && p.markdowns.length)
        ? p.markdowns.map(m => String(m ?? ""))
        : [comment];

      return {
        code: String((p && p.code) || ""),
        topLine: parseInt((p && p.topLine), 10) || 1,
        comment,
        markdowns,
        images: (p && p.images && typeof p.images === "object")
          ? { ...p.images }
          : {}
      };
    })
  : [{
      code: "",
      topLine: 1,
      comment: "",
      markdowns: [""],
      images: {}
    }];

  pagesState.pages = safePages;

  let idx = parseInt(activeIndex, 10);
  if (!Number.isFinite(idx)) idx = 0;
  if (idx < 0) idx = 0;
  if (idx >= safePages.length) idx = safePages.length - 1;

  loadPageIntoEditor(idx, { saveCurrent: false });
  updatePaginationUi();
}

  function getActivePageIndex() {
    return pagesState.activeIndex;
  }

  // ─── Accès en lecture pour le ruban de pages (scrollContinu.js) ────────────
  // getPageRef : référence DIRECTE de l'objet page (pas une copie), pour lire
  // code/markdowns/images d'une page non active sans dupliquer les images.
  // getPageOutputText : dernière sortie TEXTE mémorisée pour cette page
  // (même source que la restauration faite par loadPageIntoEditor).
  function getPageRef(index) {
    const i = parseInt(index, 10);
    if (!Number.isFinite(i)) return null;
    return pagesState.pages[i] || null;
  }

  function getPageOutputText(index) {
    const page = getPageRef(index);
    if (!page) return "";
    return pageOutputs.get(page) || "";
  }

 // ─── Registre "contextes expirés" (mémoire de session uniquement) ──────────
  // Quand le rejeu des pages précédentes a dépassé 5 s (page lente / boucle
  // infinie), on mémorise le hash du code de ces pages. Tant qu'aucune page
  // précédente n'est modifiée, on ne refait plus l'attente de 5 s — mais on
  // affiche quand même le message. Le Set se vide au rechargement de la page.
  const _expiredContextHashes = new Set();

  function hashContext(code) {
    const s = String(code || "");
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h) ^ s.charCodeAt(i);
      h = h >>> 0;
    }
    return "ctx_" + h.toString(36);
  }

  function markContextExpired(hash) {
    if (hash) _expiredContextHashes.add(String(hash));
  }

  function isContextExpired(hash) {
    return _expiredContextHashes.has(String(hash || ""));
  }

  window.PagesMultiples = {
    executePersistentCode,
    clearEditorButKeepPythonMemory,
    resetPythonNotebookMemory,
    getAllPages,
    setAllPages,
    getActivePageIndex,
    goToPreviousPage,
    goToNextPage,
    addPage,
    removeCurrentPage,
    saveActivePageFromEditor,
    updatePaginationUi,
    loadPageIntoEditor,
    insertMarkdownAfter,
    insertMarkdownAt,
    removeMarkdownAt,
    moveMarkdownUp,
    moveMarkdownDown,
    refreshMarkdownBlocksUi,
    getCurrentPageRef: () => getCurrentPage(),
    getPageRef,
    getPageOutputText,
    getPagesCount: () => pagesState.pages.length,
    hashContext,
    markContextExpired,
    isContextExpired,
    // Notebook par cellules (cellules.js).
    cellules: {
      actives: cellulesActives,
      insererApres: insererCelluleApres,
      couperMarkdown,
      deplacerMarkdown,
      deplacerZoneCode,
      couperZoneCode,
      nombreMarkdowns,
      peutDeplacerMarkdown,
      peutCouperMarkdown,
      peutDeplacerCode,
      peutInsererCode,
      peutCouperCode
    }
  };

  document.addEventListener("DOMContentLoaded", waitForEditorThenInit);
})();
