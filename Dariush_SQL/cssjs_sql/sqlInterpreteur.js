/***************************************************************
DARIUSH SQL — sqlInterpreteur.js
auteur : Frédéric Boissac
licence : gratos pour un usage non commercial

Équivalent SQL de interpreteur.js (Python).
Moteur SQL : sql.js (SQLite WASM, in-browser).
- Une seule base partagée entre toutes les pages (window.sqlDatabase)
- Bouton Exécuter : exécute le code SQL et affiche le résultat
- SELECT  → tableau HTML
- Autres  → message court (ok / nb lignes affectées)
- Erreur  → message rouge
- Toutes les autres mécaniques (thème, zoom, layout, ouvrir, sauver,
  lien, multi-pages, markdown) sont reprises à l'identique de Python.
***************************************************************/

let versionenligne = false;
let versionTest    = false;
let numversion     = "cssjs_sql";
let buildVersion   = "20260517-1";

let editor;
let outputElement, outputVerticalElement, outputHorizontalElement, runButton;
let isHorizontalOutput = false;

// Flags utilisés par d'autres scripts communs (pagesmultiples, sauvegarde…)
window.isDebugMode   = false;
window.pyWorkerReady = false;     // gardé pour compat outils communs
window.sqlDatabase   = null;      // l'instance SQL.Database partagée

// URL CDN de sql.js
const SQL_JS_CDN     = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.js";
const SQL_WASM_PATH  = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/";

let sqlJsModule = null;           // résultat de initSqlJs

/* ============================================================
   Hauteur dynamique de l'éditeur en mode horizontal
   (repris à l'identique de interpreteur.js)
   ============================================================ */
function ajusterHauteurEditeurHorizontal() {
  if (!editor) return;

  const scroller = editor.getScrollerElement();
  const wrapper  = editor.getWrapperElement();
  if (!scroller || !wrapper) return;

  const lastLine    = Math.max(0, editor.lineCount() - 1);
  const lastLineTop = editor.heightAtLine(lastLine, "local");
  const lineHeight  = editor.defaultTextHeight();
  const extraPixels = lineHeight * 2;

  const wantedHeight = Math.max(
    6 * lineHeight,
    lastLineTop + lineHeight + extraPixels
  );

  scroller.style.height = wantedHeight + "px";
  wrapper.style.height  = wantedHeight + "px";
  scroller.style.overflowY = "hidden";
  scroller.style.overflowX = "auto";

  editor.refresh();
}

/* ============================================================
   Layout horizontal / vertical
   ============================================================ */
function setOutputLayout(horizontal) {
  const rightCol           = document.getElementById("rightCol");
  const horizontalWrap     = document.getElementById("horizontalOutputWrap");
  const layoutToggleButton = document.getElementById("layoutToggleButton");
  const mainSplit          = document.getElementById("mainSplit");
  const colResizer         = document.getElementById("colResizer");

  isHorizontalOutput = !!horizontal;

  if (rightCol)       rightCol.style.display       = isHorizontalOutput ? "none" : "flex";
  if (horizontalWrap) horizontalWrap.style.display = isHorizontalOutput ? "block" : "none";
  if (mainSplit)      mainSplit.classList.toggle("horizontal-layout", isHorizontalOutput);
  if (colResizer)     colResizer.style.display     = isHorizontalOutput ? "none" : "";

  const newOutput = isHorizontalOutput ? outputHorizontalElement : outputVerticalElement;

  // On transfère le HTML (pas textContent), car en SQL la sortie contient des tableaux
  if (outputElement && newOutput && outputElement !== newOutput) {
    newOutput.innerHTML = outputElement.innerHTML;
  }

  outputElement = newOutput;

  if (layoutToggleButton) {
    if (isHorizontalOutput) {
      layoutToggleButton.textContent = "⬌";
      layoutToggleButton.title       = "Passer en affichage côte à côte";
    } else {
      layoutToggleButton.textContent = "⬍";
      layoutToggleButton.title       = "Passer en affichage horizontal";
    }
  }

  updateEditorLayoutMode();

  requestAnimationFrame(() => {
    ajusterHauteurEditeurHorizontal();
  });

  applyEditorFontSize(currentEditorFontSize);
  if (window.saveEditorLayout) {
    window.saveEditorLayout(isHorizontalOutput ? "horizontal" : "vertical");
  }
  if (typeof updateBottomPageNav === "function") updateBottomPageNav();
}

function updateEditorLayoutMode() {
  if (!editor) return;
  const wrapper  = editor.getWrapperElement();
  const scroller = editor.getScrollerElement();
  if (!wrapper || !scroller) return;

  editor.setOption("viewportMargin", 10);
  wrapper.style.height  = "auto";
  wrapper.style.flex    = "0 0 auto";
  scroller.style.overflowY = "hidden";
  scroller.style.overflowX = "auto";
  editor.refresh();
}

function toggleOutputLayout() {
  setOutputLayout(!isHorizontalOutput);
}

/* ============================================================
   Zoom (taille de police)
   ============================================================ */
const MIN_EDITOR_FONT_SIZE     = 10;
const MAX_EDITOR_FONT_SIZE     = 40;
const DEFAULT_EDITOR_FONT_SIZE = 14;

let currentEditorFontSize = DEFAULT_EDITOR_FONT_SIZE;

function clampFontSize(size) {
  return Math.max(MIN_EDITOR_FONT_SIZE, Math.min(MAX_EDITOR_FONT_SIZE, size));
}

function applyEditorFontSize(size) {
  currentEditorFontSize = clampFontSize(size);

  if (editor) {
    const wrapper = editor.getWrapperElement();
    if (wrapper) wrapper.style.fontSize = currentEditorFontSize + "px";
    editor.refresh();
  }

  const textarea = document.getElementById("exerciseText");
  if (textarea) textarea.style.fontSize = currentEditorFontSize + "px";

 const preview = document.getElementById("exercisePreview");
  if (preview) preview.style.fontSize = currentEditorFontSize + "px";

  // ===== MARKDOWNS MULTIPLES : tous les blocs (textareas + aperçus) =====
  const mdContainer = document.getElementById("markdownsContainer");
  if (mdContainer) {
    mdContainer.querySelectorAll(".md-block-textarea, .md-block-preview")
      .forEach((el) => {
        el.style.fontSize = currentEditorFontSize + "px";
      });
  }

  if (outputVerticalElement)   outputVerticalElement.style.fontSize   = currentEditorFontSize + "px";
  if (outputHorizontalElement) outputHorizontalElement.style.fontSize = currentEditorFontSize + "px";

  updateZoomControls();
}


// Réapplique UNIQUEMENT la taille courante aux blocs markdown (après une
// régénération : changement de page, ajout de bloc...). Lit la taille locale,
// ne touche ni au code, ni à la console, ni au curseur.
function reapplyMarkdownFontSize() {
  const mdContainer = document.getElementById("markdownsContainer");
  if (!mdContainer) return;
  mdContainer.querySelectorAll(".md-block-textarea, .md-block-preview")
    .forEach((el) => {
      el.style.fontSize = currentEditorFontSize + "px";
    });
}
window.reapplyMarkdownFontSize = reapplyMarkdownFontSize;


function changeEditorFontSize(delta) {
  applyEditorFontSize(currentEditorFontSize + delta);
}

function updateZoomControls() {
  const zoomRange        = document.getElementById("zoomRange");
  const zoomPercentLabel = document.getElementById("zoomPercentLabel");

  if (zoomRange) {
    zoomRange.min   = String(MIN_EDITOR_FONT_SIZE);
    zoomRange.max   = String(MAX_EDITOR_FONT_SIZE);
    zoomRange.step  = "1";
    zoomRange.value = String(currentEditorFontSize);
  }

  if (zoomPercentLabel) {
    const percent = Math.round((currentEditorFontSize / DEFAULT_EDITOR_FONT_SIZE) * 100);
    zoomPercentLabel.textContent = percent + "%";
  }
}

function handleWheelFontResize(event) {
  if (!event.ctrlKey) return;
  event.preventDefault();
  if (event.deltaY < 0)      changeEditorFontSize(1);
  else if (event.deltaY > 0) changeEditorFontSize(-1);
}

/* ============================================================
   Gestion du texte d'exercice (markdown)
   (repris à l'identique de interpreteur.js)
   ============================================================ */
const DEFAULT_EXERCISE_TEXT = "";

function getExerciseTextarea() {
  return document.getElementById("exerciseText");
}

function normalizeExerciseText(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").trim();
}

function getExerciseText() {
  const el = getExerciseTextarea();
  if (!el) return "";
  return normalizeExerciseText(el.value);
}

function setExerciseText(text) {
  const el = getExerciseTextarea();
  if (!el) return;
  el.value = normalizeExerciseText(text);
  if (typeof autoResizeTextarea === "function") autoResizeTextarea(el);
  if (window.MarkdownEditor && typeof window.MarkdownEditor.refreshPreview === "function") {
    window.MarkdownEditor.refreshPreview();
  }
}

function encodeTextForUrl(text) {
  const utf8 = new TextEncoder().encode(String(text));
  let binary = "";
  for (const byte of utf8) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeTextFromUrl(value) {
  if (!value) return "";
  let base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) base64 += "=";
  const binary = atob(base64);
  const bytes  = Uint8Array.from(binary, ch => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/* ============================================================
   Sortie : SQL utilise innerHTML (pour les tableaux)
   ============================================================ */
function setOutput(html) {
  if (outputElement) outputElement.innerHTML = html;
}

function appendOutput(html) {
  if (outputElement) outputElement.innerHTML += html;
}

function ensureNewLine() {
  if (!outputElement) return;
  const t = outputElement.innerHTML;
  if (t.length > 0 && !t.endsWith("<br>") && !t.endsWith("\n")) appendOutput("<br>");
}

/* Convertit n'importe quelle valeur SQL en texte affichable et échappé HTML */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatSqlValue(v) {
  if (v === null || v === undefined) {
    return "<span class='sql-null'>NULL</span>";
  }
  if (v instanceof Uint8Array) {
    return "<span class='sql-blob'>[BLOB " + v.length + " octets]</span>";
  }
  return escapeHtml(v);
}

/* ============================================================
   sql.js — chargement dynamique + initialisation
   ============================================================ */
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    // Si déjà chargé, on ne le recharge pas
    if (document.querySelector(`script[data-loaded-src="${src}"]`)) {
      resolve();
      return;
    }
    const s = document.createElement("script");
    s.src   = src;
    s.async = true;
    s.dataset.loadedSrc = src;
    s.onload  = () => resolve();
    s.onerror = () => reject(new Error("Impossible de charger : " + src));
    document.head.appendChild(s);
  });
}

async function loadSqlEngine() {
  setOutput("<span class='loading'>Chargement du moteur SQLite…</span>");

  try {
    await loadScriptOnce(SQL_JS_CDN);

    if (typeof initSqlJs !== "function") {
      throw new Error("initSqlJs introuvable après chargement");
    }

    sqlJsModule = await initSqlJs({
      locateFile: (file) => SQL_WASM_PATH + file
    });

    // Création de la base partagée
    window.sqlDatabase = new sqlJsModule.Database();
    window.SQL         = sqlJsModule;         // exposé pour usage avancé éventuel
    window.pyWorkerReady = true;              // compat outils communs

    runButton.disabled = false;
    setOutput("<span class='sql-ready'>✓ Moteur SQLite prêt. La base est vide et partagée entre toutes les pages.</span>");
  } catch (err) {
    console.error("[SQL] Erreur de chargement :", err);
    setOutput("<span class='sql-error'>Erreur de chargement du moteur SQLite : " + escapeHtml(err.message || err) + "</span>");
  }
}

/* ============================================================
   Exécution du code SQL
   ============================================================ */
function runSqlCode() {
  if (!window.sqlDatabase || !editor) return;

  const code = editor.getValue().trim();
  if (!code) {
    setOutput("<span class='sql-info'>Aucun code à exécuter.</span>");
    return;
  }

  setOutput("");

  if (window.PythonAutosave) window.PythonAutosave.notifyExecutionStart();

  try {
    // db.exec() renvoie un tableau de résultats (un par requête SELECT)
    // Pour les autres requêtes (CREATE, INSERT, UPDATE, DELETE) il renvoie un tableau vide
    // mais on peut lire db.getRowsModified() entre temps.

    // On découpe en requêtes individuelles pour pouvoir afficher un message
    // précis pour chaque ordre. db.exec() exécute tout d'un coup mais ne
    // donne pas le nombre de lignes affectées par requête.
    const statements = splitSqlStatements(code);
    let html = "";

    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;

      // On ignore les commentaires purs
      if (/^\s*(--|\/\*)/.test(trimmed) && !/[a-zA-Z]/.test(stripSqlComments(trimmed))) {
        continue;
      }

      const isSelect = /^\s*(SELECT|PRAGMA|EXPLAIN|WITH)\b/i.test(trimmed);

      if (isSelect) {
        // SELECT : on récupère les résultats
        const results = window.sqlDatabase.exec(trimmed);
        if (results.length === 0) {
          html += "<div class='sql-block sql-info'>Requête exécutée — aucun résultat.</div>";
        } else {
          for (const res of results) {
            html += renderResultTable(res);
          }
        }
      } else {
        // CREATE / INSERT / UPDATE / DELETE / etc.
        window.sqlDatabase.run(trimmed);
        const affected = window.sqlDatabase.getRowsModified();
        const verb = (trimmed.match(/^\s*(\w+)/i) || ["",""])[1].toUpperCase();
        let msg;
        if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE") {
          msg = `✓ ${verb} — ${affected} ligne${affected > 1 ? "s" : ""} affectée${affected > 1 ? "s" : ""}.`;
        } else {
          msg = `✓ ${verb} OK.`;
        }
        html += "<div class='sql-block sql-ok'>" + escapeHtml(msg) + "</div>";
      }
    }

    setOutput(html || "<span class='sql-info'>Aucune requête exécutée.</span>");
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    setOutput("<div class='sql-block sql-error'>Erreur SQL : " + escapeHtml(msg) + "</div>");
  } finally {
    if (window.PythonAutosave) window.PythonAutosave.notifyExecutionEnd();
  }
}

/* Découpe un script SQL en requêtes individuelles (sépare sur ; mais
   ignore les ; à l'intérieur de chaînes 'foo;bar' ou "foo;bar"). */
function splitSqlStatements(sql) {
  const out  = [];
  let buf    = "";
  let inSingle = false;
  let inDouble = false;
  let inLineComment  = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const c    = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      buf += c;
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      buf += c;
      if (c === "*" && next === "/") { buf += next; i++; inBlockComment = false; }
      continue;
    }
    if (inSingle) {
      buf += c;
      if (c === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      buf += c;
      if (c === '"') inDouble = false;
      continue;
    }

    if (c === "-" && next === "-") { buf += c; inLineComment  = true; continue; }
    if (c === "/" && next === "*") { buf += c; inBlockComment = true; continue; }
    if (c === "'") { buf += c; inSingle = true; continue; }
    if (c === '"') { buf += c; inDouble = true; continue; }

    if (c === ";") {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

function stripSqlComments(sql) {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/* Rend un résultat de db.exec() en tableau HTML.
   res = { columns: [...], values: [[...], [...]] }                 */
function renderResultTable(res) {
  let html = "<div class='sql-block'>";
  html += "<table class='sql-table'>";

  // En-tête
  html += "<thead><tr>";
  for (const col of res.columns) {
    html += "<th>" + escapeHtml(col) + "</th>";
  }
  html += "</tr></thead>";

  // Corps
  html += "<tbody>";
  if (res.values.length === 0) {
    html += "<tr><td colspan='" + res.columns.length + "' class='sql-empty'>(aucune ligne)</td></tr>";
  } else {
    for (const row of res.values) {
      html += "<tr>";
      for (const v of row) {
        html += "<td>" + formatSqlValue(v) + "</td>";
      }
      html += "</tr>";
    }
  }
  html += "</tbody>";

  html += "</table>";
  html += "<div class='sql-count'>" + res.values.length + " ligne" + (res.values.length > 1 ? "s" : "") + "</div>";
  html += "</div>";
  return html;
}

/* ============================================================
   API publique pour pagesmultiples.js et autres
   ============================================================ */

/* Réinitialise la base SQL (équivalent du "reset Python" entre pages).
   ATTENTION : on NE l'appelle PAS automatiquement entre les pages
   pour que les tables persistent d'une page à l'autre. */
function resetSqlDatabase() {
  if (sqlJsModule) {
    if (window.sqlDatabase) {
      try { window.sqlDatabase.close(); } catch (e) {}
    }
    window.sqlDatabase = new sqlJsModule.Database();
  }
}
window.resetSqlDatabase = resetSqlDatabase;

/* ============================================================
   Réinitialisation UI au changement de page (multi-pages)
   (repris à l'identique de interpreteur.js)
   ============================================================ */
function resetLoadedPageUi() {
  setOutput("");

  const commentsWrap = document.getElementById("fenetrescommentaires");
  if (commentsWrap) commentsWrap.style.display = "inline";

  const toggleBtn = document.getElementById("previewToggleBtn");
  if (toggleBtn) {
    toggleBtn.textContent = "—";
    toggleBtn.title       = "Masquer l’aperçu";
  }

  const textarea = document.getElementById("exerciseText");
  const preview  = document.getElementById("exercisePreview");

  if (textarea && preview) {
    textarea.classList.add("hidden");
    preview.classList.remove("hidden");
  }

  if (window.MarkdownEditor && typeof window.MarkdownEditor.refreshPreview === "function") {
    window.MarkdownEditor.refreshPreview();
  }
}
window.resetLoadedPageUi = resetLoadedPageUi;

window.DEFAULT_EXERCISE_TEXT = DEFAULT_EXERCISE_TEXT;
window.getExerciseText       = getExerciseText;
window.setExerciseText       = setExerciseText;
window.normalizeExerciseText = normalizeExerciseText;

/* ============================================================
   Navigation bas de page (multi-pages)
   ============================================================ */
function getPageCountsFromIndicator() {
  const indicator = document.getElementById("pagesMultiplesIndicator");
  if (!indicator) return { current: 1, total: 1 };

  const text  = (indicator.textContent || "").trim();
  const match = text.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!match) return { current: 1, total: 1 };

  return {
    current: parseInt(match[1], 10) || 1,
    total:   parseInt(match[2], 10) || 1
  };
}

function isBottomNavBlockedByOpenPanel() {
  const iaPanel        = document.getElementById("iaPanel");
  const connexionPanel = document.getElementById("connexion");
  const iaOpen        = !!(iaPanel        && iaPanel.classList.contains("ia-open"));
  const connexionOpen = !!(connexionPanel && connexionPanel.classList.contains("group-open"));
  return iaOpen || connexionOpen;
}

function updateBottomPageNav() {
  const nav          = document.getElementById("bottomPageNav");
  const navIndicator = document.getElementById("bottomPageNavIndicator");
  const prevBtn      = document.getElementById("bottomPrevPageButton");
  const nextBtn      = document.getElementById("bottomNextPageButton");
  const mainSplit    = document.getElementById("mainSplit");

  if (!nav || !navIndicator || !prevBtn || !nextBtn || !mainSplit) return;

  if (window.__groupNavLocked) {
    let current = 1, total = 1;
    if (window.PagesMultiples) {
      const pages = window.PagesMultiples.getAllPages() || [];
      total   = pages.length || 1;
      current = (window.PagesMultiples.getActivePageIndex?.() ?? 0) + 1;
    }
    navIndicator.textContent = current + "/" + total;
    nav.classList.remove("hidden");
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    return;
  }

  const counts          = getPageCountsFromIndicator();
  const hasSeveralPages = counts.total > 1;
  const blocked         = isBottomNavBlockedByOpenPanel();

  navIndicator.textContent = counts.current + "/" + counts.total;

  if (!hasSeveralPages || blocked) {
    nav.classList.add("hidden");
    return;
  }

  nav.classList.remove("hidden");
  prevBtn.disabled = counts.current <= 1;
  nextBtn.disabled = counts.current >= counts.total;
}
window.updateBottomPageNav = updateBottomPageNav;

function initBottomPageNav() {
  const bottomPrev        = document.getElementById("bottomPrevPageButton");
  const bottomNext        = document.getElementById("bottomNextPageButton");
  const topPrev           = document.getElementById("pagesPrevButton");
  const topNext           = document.getElementById("pagesNextButton");
  const indicator         = document.getElementById("pagesMultiplesIndicator");
  const iaPanel           = document.getElementById("iaPanel");
  const connexionPanel    = document.getElementById("connexion");
  const openIaPanelBtn    = document.getElementById("openIaPanel");
  const closeIaPanelBtn   = document.getElementById("closeIaPanel");
  const openConnexionBtn  = document.getElementById("boutonmenuconnexion");
  const closeConnexionBtn = document.getElementById("closeConnexionPanel");

  if (bottomPrev && topPrev) {
    bottomPrev.addEventListener("click", () => { topPrev.click(); });
  }
  if (bottomNext && topNext) {
    bottomNext.addEventListener("click", () => { topNext.click(); });
  }

  // Observe le span pagesMultiplesIndicator : dès que son contenu change
  // (ajout / suppression / changement de page), on rafraîchit la nav du bas.
  if (indicator) {
    const observer = new MutationObserver(() => updateBottomPageNav());
    observer.observe(indicator, {
      childList:     true,
      subtree:       true,
      characterData: true
    });
  }

  // Observe l'ouverture/fermeture du panneau IA (change la classe)
  if (iaPanel) {
    const iaObserver = new MutationObserver(() => updateBottomPageNav());
    iaObserver.observe(iaPanel, {
      attributes:      true,
      attributeFilter: ["class"]
    });
  }

  // Observe l'ouverture/fermeture du panneau Groupe
  if (connexionPanel) {
    const connexionObserver = new MutationObserver(() => updateBottomPageNav());
    connexionObserver.observe(connexionPanel, {
      attributes:      true,
      attributeFilter: ["class"]
    });
  }

  if (openIaPanelBtn)    openIaPanelBtn.addEventListener("click",    () => requestAnimationFrame(updateBottomPageNav));
  if (closeIaPanelBtn)   closeIaPanelBtn.addEventListener("click",   () => requestAnimationFrame(updateBottomPageNav));
  if (openConnexionBtn)  openConnexionBtn.addEventListener("click",  () => requestAnimationFrame(updateBottomPageNav));
  if (closeConnexionBtn) closeConnexionBtn.addEventListener("click", () => requestAnimationFrame(updateBottomPageNav));

  window.addEventListener("resize", updateBottomPageNav);
  updateBottomPageNav();
} 

/* ============================================================
   Nouveau fichier
   ============================================================ */
function createNewEmptyFile() {
  const ok = window.confirm(
    "Attention : créer un nouveau fichier va effacer le fichier actuel " +
    "ET réinitialiser la base SQL.\n\nVoulez-vous continuer ?"
  );
  if (!ok) return;

  if (window.PagesMultiples && typeof window.PagesMultiples.setAllPages === "function") {
    window.PagesMultiples.setAllPages([{
      code:    "",
      topLine: 1,
      comment: "",
      images:  {}
    }], 0);
  } else {
    if (editor) editor.setValue("");
    if (typeof window.setExerciseText === "function") window.setExerciseText("");
  }

  const generatedLinkEl = document.getElementById("generatedLink");
  if (generatedLinkEl) {
    generatedLinkEl.value         = "";
    generatedLinkEl.style.display = "none";
  }

  if (typeof window.resetLoadedPageUi === "function") window.resetLoadedPageUi();

  if (window.PagesMultiples && typeof window.PagesMultiples.resetPythonNotebookMemory === "function") {
    window.PagesMultiples.resetPythonNotebookMemory();
  }

  // Réinitialisation de la base SQL : on repart d'une base vide
  resetSqlDatabase();
  setOutput("<span class='sql-ready'>✓ Nouveau notebook — base SQL réinitialisée.</span>");

  if (window.PythonAutosave && typeof window.PythonAutosave.saveNow === "function") {
    window.PythonAutosave.saveNow();
  }
}

/* ============================================================
   Initialisation principale
   ============================================================ */
async function initSqlEditor() {
  outputVerticalElement   = document.getElementById("output");
  outputHorizontalElement = document.getElementById("outputhorizontal");
  outputElement           = outputVerticalElement;
  runButton               = document.getElementById("runButton");

  const codeEditorEl   = document.getElementById("codeEditor");
  const linkInput      = document.getElementById("generatedLink");
  const exerciseTextEl = document.getElementById("exerciseText");
  const clearButtonCode = document.getElementById("clearButtonCode");

  const zoomButton     = document.getElementById("zoomButton");
  const zoomPanel      = document.getElementById("zoomPanel");
  const zoomRange      = document.getElementById("zoomRange");
  const zoomOutButton  = document.getElementById("zoomOutButton");
  const zoomInButton   = document.getElementById("zoomInButton");
  const zoomCloseButton = document.getElementById("zoomCloseButton");
  const layoutToggleButton = document.getElementById("layoutToggleButton");

  if (!outputVerticalElement || !outputHorizontalElement || !runButton ||
      !codeEditorEl || !linkInput || !exerciseTextEl) {
    console.error("[SQL] DOM incomplet");
    return;
  }

  // Toolbar : layout
  if (layoutToggleButton) layoutToggleButton.addEventListener("click", toggleOutputLayout);

  // Toolbar : zoom
  if (zoomCloseButton && zoomPanel) {
    zoomCloseButton.addEventListener("click", () => zoomPanel.classList.add("hidden"));
  }
  if (zoomButton && zoomPanel) {
    zoomButton.addEventListener("click", () => {
      zoomPanel.classList.toggle("hidden");
      updateZoomControls();
    });
  }
  if (zoomRange) {
    zoomRange.addEventListener("input", () => {
      const value = parseInt(zoomRange.value, 10);
      applyEditorFontSize(value);
    });
  }
  if (zoomOutButton) zoomOutButton.addEventListener("click", () => changeEditorFontSize(-1));
  if (zoomInButton)  zoomInButton.addEventListener("click",  () => changeEditorFontSize(1));

  // Toolbar : effacer
  if (clearButtonCode) {
    clearButtonCode.addEventListener("click", () => {
      setOutput("");
      if (!editor) return;
      if (confirm("Effacer tout le code ?")) {
        editor.setValue("");
        if (linkInput) {
          linkInput.value = "";
          linkInput.style.display = "none";
        }
      }
    });
  }

  // Markdown
  if (typeof autoResizeTextarea === "function") autoResizeTextarea(exerciseTextEl);
  if (window.MarkdownEditor && typeof window.MarkdownEditor.init === "function") {
    window.MarkdownEditor.init();
  }

  // Champ lien
  linkInput.style.display = "none";

  // Création de l'éditeur CodeMirror — mode SQL (et non Python)
  editor = CodeMirror.fromTextArea(codeEditorEl, {
    mode:           "text/x-sql",
    theme:          (typeof getSavedEditorTheme === "function") ? getSavedEditorTheme() : "default",
    lineNumbers:    true,
    indentUnit:     2,
    indentWithTabs: false,
    smartIndent:    false
  });

  applyEditorFontSize(DEFAULT_EDITOR_FONT_SIZE);
  updateZoomControls();

  const codeMirrorWrapper = editor.getWrapperElement();
  if (codeMirrorWrapper) {
    codeMirrorWrapper.addEventListener("wheel", handleWheelFontResize, { passive: false });
  }
  if (outputVerticalElement) {
    outputVerticalElement.addEventListener("wheel", handleWheelFontResize, { passive: false });
  }
  if (outputHorizontalElement) {
    outputHorizontalElement.addEventListener("wheel", handleWheelFontResize, { passive: false });
  }

  // Expose l'éditeur sous le nom historique window.pythonEditor pour que
  // pagesmultiples.js, sauvegarde.js, connexion.js, etc. fonctionnent
  // sans aucune modification.
  window.pythonEditor = editor;

  if (typeof applyEditorTheme === "function" && typeof getSavedEditorMode === "function") {
    applyEditorTheme(getSavedEditorMode());
  }
  if (typeof initColumnResize === "function") initColumnResize();
  initBottomPageNav();

  // Toolbar : thème
  const themeButton = document.getElementById("themeButton");
  if (themeButton && typeof toggleEditorTheme === "function") {
    themeButton.addEventListener("click", toggleEditorTheme);
  }

  // Au moindre changement de code, on cache le lien généré
  editor.on("change", () => {
    linkInput.value = "";
    linkInput.style.display = "none";
    ajusterHauteurEditeurHorizontal();
  });

  exerciseTextEl.addEventListener("input", () => {
    linkInput.value = "";
    linkInput.style.display = "none";
    if (typeof autoResizeTextarea === "function") autoResizeTextarea(exerciseTextEl);
  });

  // Layout sauvegardé
  const savedLayout =
    (window.getSavedEditorLayout && window.getSavedEditorLayout()) || "vertical";
  setOutputLayout(savedLayout === "horizontal");

  // Le bouton Exécuter est désactivé tant que sql.js n'est pas chargé
  runButton.disabled = true;
  runButton.addEventListener("click", runSqlCode);

  // Toolbar : lien
  const generateLinkButton = document.getElementById("generateLinkButton");
  if (generateLinkButton && typeof generateLink === "function") {
    generateLinkButton.addEventListener("click", generateLink);
  }

  // Toolbar : Nouveau / Ouvrir / Enregistrer
  const openPyButton   = document.getElementById("openPyButton");
  const savePyButton   = document.getElementById("savePyButton");
  const openPyFile     = document.getElementById("openPyFile");
  const newFileButton  = document.getElementById("newFileButton");

  if (newFileButton) newFileButton.addEventListener("click", createNewEmptyFile);

  if (openPyButton && openPyFile) {
    openPyButton.addEventListener("click", async () => {
      try {
        if (typeof handleOpenSqlAction === "function") {
          await handleOpenSqlAction();
        } else {
          openPyFile.click();
        }
      } catch (err) {
        console.error(err);
        ensureNewLine();
        appendOutput("<span class='sql-error'>ERR: " + escapeHtml(err?.message || String(err)) + "</span>");
      } finally {
        openPyFile.value = "";
      }
    });
  }

  if (savePyButton) {
    savePyButton.addEventListener("click", async () => {
      try {
        if (typeof handleSavePythonAction === "function") {
          await handleSaveSqlAction();
        }
      } catch (err) {
        console.error(err);
        ensureNewLine();
        appendOutput("<span class='sql-error'>ERR: " + escapeHtml(err?.message || String(err)) + "</span>");
      }
    });
  }

  // Décodage URL (lien partagé)
  const params = new URLSearchParams(window.location.search);
  const codeParam    = params.get("code");
  const exoParam     = params.get("exo");
  const sidParam     = params.get("sid");
  const commentParam = params.get("c");

  const hasLoadableUrlParam = !!(codeParam || exoParam || sidParam);

  if (!hasLoadableUrlParam) {
    if (commentParam && typeof decode_text_deflate_b64url === "function") {
      try {
        setExerciseText(decode_text_deflate_b64url(commentParam));
      } catch (e) {
        setExerciseText(DEFAULT_EXERCISE_TEXT);
      }
    } else {
      setExerciseText(DEFAULT_EXERCISE_TEXT);
    }
  }

  if (hasLoadableUrlParam) {
    if (window.PythonAutosave) window.PythonAutosave.init(editor, { restore: false });

    if (typeof decode_url === "function") {
      const decodedOk = await decode_url(window.location.href);
      if (!decodedOk) {
        await loadSqlEngine();
        return;
      }
    }

    if (window.PythonAutosave && typeof window.PythonAutosave.restorePersistentGlobalCss === "function") {
      window.PythonAutosave.restorePersistentGlobalCss();
    }
    if (window.PythonAutosave && typeof window.PythonAutosave.saveNow === "function") {
      window.PythonAutosave.saveNow();
    }

    history.replaceState({}, document.title, window.location.pathname);

    await loadSqlEngine();
    return;
  }

  // Pas de paramètre URL : restauration normale puis chargement du moteur
  if (window.PythonAutosave) window.PythonAutosave.init(editor);

  await loadSqlEngine();
}
/* ============================================================
   OUVERTURE / SAUVEGARDE DARIUSH SQL

   Modèle calqué sur initLinux.js (.dli) mais avec un menu
   intermédiaire à 4 options (Ouvrir) et 4 options (Enregistrer)
   car Dariush SQL gère plus de formats.

   Fonctions du commun (outils.js, importer.js) réutilisées :
   buildDariushRawPayload, downloadTextFile, decode_url.
   ============================================================ */

const DSQL_FILE_EXTENSION = ".dsql";
const DSQL_FILE_MIME      = "text/plain;charset=utf-8";
const DB_FILE_MIME        = "application/x-sqlite3";

/* ----- Petit dialogue de choix (calqué sur chooseActionDialog
        de outils.js, mais local pour ne pas dépendre d'un nom
        non exposé globalement). ----- */
function chooseSqlActionDialog(title, choices) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.position       = "fixed";
    overlay.style.inset          = "0";
    overlay.style.background     = "rgba(0,0,0,0.35)";
    overlay.style.display        = "flex";
    overlay.style.alignItems     = "center";
    overlay.style.justifyContent = "center";
    overlay.style.zIndex         = "9999";

    const panel = document.createElement("div");
    panel.style.background    = "white";
    panel.style.padding       = "16px";
    panel.style.borderRadius  = "10px";
    panel.style.minWidth      = "340px";
    panel.style.maxWidth      = "90vw";
    panel.style.boxShadow     = "0 10px 30px rgba(0,0,0,0.25)";
    overlay.appendChild(panel);

    const titleEl = document.createElement("div");
    titleEl.textContent       = title;
    titleEl.style.fontWeight  = "bold";
    titleEl.style.marginBottom = "12px";
    panel.appendChild(titleEl);
    if (window.DariushDrive) window.DariushDrive.attachCheckbox(titleEl);

    const list = document.createElement("div");
    list.style.display       = "flex";
    list.style.flexDirection = "column";
    list.style.gap           = "8px";
    panel.appendChild(list);

    function close(value) {
      overlay.remove();
      resolve(value);
    }

    for (const choice of choices) {
      const btn = document.createElement("button");
      btn.type        = "button";
      btn.textContent = choice.label;
      btn.className   = "nav-item";
      btn.style.width = "100%";
      btn.style.justifyContent = "flex-start";
      btn.style.textAlign      = "left";
      btn.addEventListener("click", () => close(choice.value));
      list.appendChild(btn);
    }

    const cancelRow = document.createElement("div");
    cancelRow.style.display        = "flex";
    cancelRow.style.justifyContent = "flex-end";
    cancelRow.style.marginTop      = "12px";
    panel.appendChild(cancelRow);

    const cancelBtn = document.createElement("button");
    cancelBtn.type        = "button";
    cancelBtn.textContent = "Annuler";
    cancelBtn.className   = "nav-item";
    cancelBtn.addEventListener("click", () => close(null));
    cancelRow.appendChild(cancelBtn);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });

    document.body.appendChild(overlay);
  });
}

/* ----- Sélection d'un fichier via input file dynamique ----- */
function pickFileForSql(accept) {
  // Case "Google Drive" cochée : le fichier vient du Drive
  if (window.DariushDrive && window.DariushDrive.isEnabled()) {
    return window.DariushDrive.pickFile(accept);
  }

  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type    = "file";
    input.accept  = accept;
    input.style.display = "none";
    input.addEventListener("change", () => {
      const file = input.files && input.files[0] ? input.files[0] : null;
      resolve(file);
      setTimeout(() => input.remove(), 100);
    }, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

/* ============================================================
   OUVRIR — 4 actions
   ============================================================ */
async function handleOpenSqlAction() {
  const action = await chooseSqlActionDialog("Quel fichier voulez-vous ouvrir ?", [
    { value: "open_dsql",   label: "1 : Ouvrir un fichier Dariush SQL (" + DSQL_FILE_EXTENSION + ")" },
    { value: "open_sql",    label: "2 : Importer un fichier SQL (.sql)" },
    { value: "open_ipynb",  label: "3 : Importer un notebook Jupyter (.ipynb)" },
    { value: "import_db",   label: "4 : Importer une base de données (.db)" },
    { value: "import_pdf",  label: "5 : Importer un PDF pour le transformer en notebook" }
  ]);

  if (!action) return;

  if (action === "open_dsql") {
    const file = await pickFileForSql(".dsql");
    if (!file) return;
    await openDsqlFileFromDisk(file);
    return;
  }

  if (action === "open_sql") {
    const file = await pickFileForSql(".sql,text/plain");
    if (!file) return;
    await openPlainSqlFileFromDisk(file);
    return;
  }

  if (action === "open_ipynb") {
    const file = await pickFileForSql(".ipynb");
    if (!file) return;
    // On délègue à la fonction notebook du commun, qui sait déjà
    // remplir les pages multiples à partir des cells code+markdown.
    if (typeof openNotebookFileFromDisk === "function") {
      await openNotebookFileFromDisk(file);
    } else {
      alert("Fonction d'import notebook indisponible.");
    }
    return;
  }

  if (action === "import_db") {
    const file = await pickFileForSql(".db,.sqlite,.sqlite3,application/x-sqlite3");
    if (!file) return;
    await importDbFileFromDisk(file);
    return;
  }

  if (action === "import_pdf") {
    if (window.ImporterPdf && typeof window.ImporterPdf.open === "function") {
      await window.ImporterPdf.open();
    } else {
      alert("Le module d'import PDF (importer_pdf.js) n'est pas chargé.");
    }
    return;
  }

  throw new Error("Action inconnue : " + action);
}
/* Ouvre un .dsql (même logique que .dli côté Linux) */
async function openDsqlFileFromDisk(file) {
  if (!file) return;
  const raw = (await file.text()).trim();
  if (!raw) return;

  if (typeof decode_url !== "function") {
    throw new Error("Fonction decode_url introuvable.");
  }

  const fakeUrl = "https://physalgo.fr/Dariush_SQL/index.html?" + raw;
  const ok = await decode_url(fakeUrl);
  if (!ok) {
    throw new Error("Impossible d'ouvrir le fichier Dariush SQL.");
  }
}

/* Ouvre un .sql simple : tout le contenu va dans la page courante */
async function openPlainSqlFileFromDisk(file) {
  if (!file) return;
  const text = await file.text();
  if (editor) editor.setValue(text);

  const generatedLinkEl = document.getElementById("generatedLink");
  if (generatedLinkEl) {
    generatedLinkEl.value         = "";
    generatedLinkEl.style.display = "none";
  }

  if (window.PythonAutosave && typeof window.PythonAutosave.saveNow === "function") {
    window.PythonAutosave.saveNow();
  }
}

/* Importe une base SQLite .db et remplace la base courante */
async function importDbFileFromDisk(file) {
  if (!file) return;
  if (!sqlJsModule) {
    throw new Error("Moteur SQL non prêt.");
  }

  const buffer = await file.arrayBuffer();
  const bytes  = new Uint8Array(buffer);

  // Remplace silencieusement la base courante (choix utilisateur)
  try {
    if (window.sqlDatabase) window.sqlDatabase.close();
  } catch (e) {}

  try {
    window.sqlDatabase = new sqlJsModule.Database(bytes);
  } catch (err) {
    setOutput("<span class='sql-error'>Erreur : impossible de lire ce fichier .db ("
      + escapeHtml(err.message || err) + ")</span>");
    // Remettre une base vide pour ne pas laisser l'app dans un état cassé
    window.sqlDatabase = new sqlJsModule.Database();
    return;
  }

  // Petit message d'info : on liste les tables importées
  let tablesInfo = "";
  try {
    const res = window.sqlDatabase.exec(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
    );
    if (res.length > 0 && res[0].values.length > 0) {
      const tables = res[0].values.map(row => row[0]);
      tablesInfo = " Tables disponibles : " + tables.join(", ") + ".";
    } else {
      tablesInfo = " La base ne contient aucune table.";
    }
  } catch (e) {}

  setOutput(
    "<span class='sql-ready'>✓ Base \"" + escapeHtml(file.name)
    + "\" importée." + escapeHtml(tablesInfo) + "</span>"
  );
}

/* ============================================================
   ENREGISTRER — 4 actions
   ============================================================ */
async function handleSaveSqlAction() {
  const action = await chooseSqlActionDialog("Quel format de fichier ?", [
    { value: "save_dsql",   label: "1 : Enregistrer tout dans un fichier Dariush SQL (" + DSQL_FILE_EXTENSION + ")" },
    { value: "save_sql",    label: "2 : Exporter le code actif dans un fichier SQL (.sql)" },
    { value: "save_ipynb",  label: "3 : Exporter en notebook Jupyter (.ipynb)" },
    { value: "export_db",   label: "4 : Exporter la base de données (.db)" },
    { value: "save_pdf",    label: "5 : Exporter en PDF (impression)" }
  ]);

  if (!action) return;

  if (action === "save_dsql")  { saveDsqlFileToDisk(); return; }
  if (action === "save_sql")   { savePlainSqlFileToDisk(); return; }
  if (action === "save_ipynb") {
    if (typeof saveNotebookFileToDisk === "function") {
      saveNotebookFileToDisk();
    } else {
      alert("Fonction d'export notebook indisponible.");
    }
    return;
  }
  if (action === "export_db")  { exportDbFileToDisk(); return; }
  if (action === "save_pdf")   {
    if (typeof exportNotebookToPrintPdf === "function") {
      exportNotebookToPrintPdf({ codeLanguage: "sql" });
    } else {
      alert("Fonction d'export PDF indisponible.");
    }
    return;
  }

  throw new Error("Action inconnue : " + action);
}
/* Enregistre tout dans un .dsql (même payload qu'un lien) */
function saveDsqlFileToDisk() {
  if (typeof buildDariushRawPayload !== "function") {
    alert("Fonction buildDariushRawPayload introuvable.");
    return;
  }

  const rawPayload = buildDariushRawPayload();
  if (!rawPayload) return;

  return saveTextFileAs(rawPayload, {
    defaultName: "activite" + DSQL_FILE_EXTENSION,
    extension: DSQL_FILE_EXTENSION,
    mimeType: DSQL_FILE_MIME,
    promptLabel: "Nom du fichier Dariush SQL :",
    description: "Fichier Dariush SQL"
  });
}

/* Exporte uniquement le code SQL de la page courante */
function savePlainSqlFileToDisk() {
  if (!editor) return;

  return saveTextFileAs(editor.getValue(), {
    defaultName: "requete.sql",
    extension: ".sql",
    mimeType: "text/plain;charset=utf-8",
    promptLabel: "Nom du fichier SQL :",
    description: "Fichier SQL"
  });
}

/* Exporte la base SQLite actuelle en .db autonome */
function exportDbFileToDisk() {
  if (!window.sqlDatabase) {
    alert("Aucune base SQL chargée.");
    return;
  }

  const defaultName = "base.db";
  const filename    = prompt("Nom du fichier de base de données :", defaultName) || defaultName;
  const finalName   = (/\.(db|sqlite|sqlite3)$/i).test(filename)
    ? filename
    : (filename + ".db");

  const bytes = window.sqlDatabase.export();   // Uint8Array
  downloadBytesAsFile(bytes, finalName, DB_FILE_MIME);
}

/* Téléchargement binaire (pour le .db) */
function downloadBytesAsFile(bytes, filename, mimeType) {
  const blob = new Blob([bytes], { type: mimeType });
  const url  = URL.createObjectURL(blob);

  const a       = document.createElement("a");
  a.href        = url;
  a.download    = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 200);
}

/* Exposés pour debug éventuel */
window.handleOpenSqlAction = handleOpenSqlAction;
window.handleSaveSqlAction = handleSaveSqlAction;
/* ============================================================
   Démarrage : on attend que le DOM soit prêt
   ============================================================ */
document.addEventListener("DOMContentLoaded", () => {
  initSqlEditor().catch(err => {
    console.error("[SQL] init error :", err);
  });
});