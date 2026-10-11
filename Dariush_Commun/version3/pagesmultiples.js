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
    editor.focus();
    editor.refresh();

    if (!keepScroll) {
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

    if (pagesState.removeBtnEl) {
      pagesState.removeBtnEl.disabled = total <= 1;
      pagesState.removeBtnEl.style.opacity = total <= 1 ? "0.5" : "1";
      pagesState.removeBtnEl.title = total <= 1
        ? "Impossible de supprimer la dernière page"
        : "Supprimer la page active";
    }

    // Bouton "Tous" : visible uniquement s'il y a au moins 2 pages.
    const runAllBtn = document.getElementById("runAllButton");
    if (runAllBtn) {
      runAllBtn.style.display = total >= 2 ? "" : "none";
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

  const ok = confirm("Êtes-vous sûr de vouloir supprimer cette page ?");

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
  // Supprime le markdown à la position 'index' dans la page active.
  // Refuse de supprimer s'il ne reste qu'un seul bloc (invariant : au moins 1).
  function removeMarkdownAt(index) {
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
function buildPaginationControls() {
  if (pagesState.controlsBuilt) return;

  const prevBtn = document.getElementById("pagesPrevButton");
  const nextBtn = document.getElementById("pagesNextButton");
  const addBtn = document.getElementById("pagesAddButton");
  const removeBtn = document.getElementById("pagesRemoveButton");
  const indicator = document.getElementById("pagesMultiplesIndicator");

  if (!prevBtn || !nextBtn || !addBtn || !removeBtn || !indicator) {
    console.warn("pagesmultiples.js : contrôles de pagination introuvables");
    return;
  }

  prevBtn.addEventListener("click", goToPreviousPage);
  nextBtn.addEventListener("click", goToNextPage);
  addBtn.addEventListener("click", addPage);
  removeBtn.addEventListener("click", removeCurrentPage);

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
    removeMarkdownAt,
    moveMarkdownUp,
    moveMarkdownDown,
    refreshMarkdownBlocksUi,
    getCurrentPageRef: () => getCurrentPage(),
    getPagesCount: () => pagesState.pages.length,
    hashContext,
    markContextExpired,
    isContextExpired
  };

  document.addEventListener("DOMContentLoaded", waitForEditorThenInit);
})();
