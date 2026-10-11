// ===============================
// mon debogueur PAS A PAS -
// ===============================

let debugSnapshots = [];
let debugStepIndex = 0;
let debugLastCode = "";
let debugLastOutput = ""; // sortie sur la fenetre de l' executeur
let debugHighlightedLine = null; // ligne bleu surligné  du code
let debugRecordedEvents = [];
let debugPreparing = false;
let debugErrorStopIndex = -1;   // index d'arret sur erreur non rattrapee (-1 = pas d'arret)
let debugDisplayedPage = 0;     // page actuellement affichee par le debogueur
let debugPreviousPagesCode = "";
let debugActiveCode = "";
let debugUsedFallbackContext = false;
let debugFallbackMessage = "";

// ===============================
// Accès éditeur / pyodide
// ===============================

function getCurrentPythonCode() {
  const ed = window.pythonEditor || window.editor || null;
  if (!ed || typeof ed.getValue !== "function") {
    throw new Error("L'éditeur CodeMirror n'est pas encore disponible.");
  }

  // Caractères invisibles collés par mégarde (espaces insécables...) :
  // corrigés dans l'éditeur avant le pas à pas, comme pour Exécuter.
  if (typeof window.nettoyerEditeurAvantExecution === "function") {
    return window.nettoyerEditeurAvantExecution(ed);
  }

  return ed.getValue();
}

function getPyodide() {
  return null;
}

function setDebugMode(active) {
  const isActive = !!active;
  window.isDebugMode = isActive;

  const runBtn = document.getElementById("runButton");
  if (runBtn) {
    runBtn.disabled = isActive;
  }
}

// ===============================
// Construction des snapshots
// ===============================
async function buildDebugSnapshots(code, contextCode = "", activePageIndex = 0) {
  if (typeof window.requestDebugSnapshotsFromWorker !== "function") {
    throw new Error("Pont debug worker introuvable.");
  }

  return await window.requestDebugSnapshotsFromWorker(code, contextCode || "", activePageIndex || 0);
}

// ===============================
// Outils console
// ===============================

function printVariablesBlock(title, varsObj) {
  console.log(title);

  const keys = Object.keys(varsObj || {});
  if (keys.length === 0) {
    console.log("(aucune)");
    return;
  }

  for (const key of keys) {
    console.log(key + " = " + varsObj[key]);
  }
}

function showSnapshotInConsole(snapshot) {
  console.log("\n==============================");
  console.log("=== PAS A PAS ===");
  console.log("Étape : " + snapshot.step);
  console.log("Ligne : " + snapshot.line);
  console.log("Fonction : " + snapshot.function);

  if (snapshot.error_type) {
    console.log("Erreur : " + snapshot.error_type + " : " + snapshot.error_message);
  }

  if (snapshot.event === "return") {
    console.log("Sortie de " + snapshot.function + " : valeur renvoyée");
    console.log(snapshot.return_value);
  }

  console.log("--- Sortie ---");
  if (snapshot.stdout && snapshot.stdout.length > 0) {
    console.log(snapshot.stdout);
  } else {
    console.log("(vide)");
  }

  if (snapshot.same_scope) {
    printVariablesBlock("--- Variables globales de cette page ---", snapshot.globals || {});
  } else {
    printVariablesBlock("--- Variables locales ---", snapshot.locals || {});
    printVariablesBlock("--- Variables globales de cette page ---", snapshot.globals || {});
  }

  if (snapshot.context_globals && Object.keys(snapshot.context_globals).length > 0) {
    printVariablesBlock("--- Variables globales précédentes ---", snapshot.context_globals || {});
  }
}

// ===============================
// Outils modale
// ===============================
function getDebugModalElements() {
  return {
    modal: document.getElementById("debugModal"),
    content: document.getElementById("debugStepContent"),
    btnNext: document.getElementById("btnDebugNext"),
    btnClose: document.getElementById("btnDebugClose"),
    btnGoToLine: document.getElementById("btnDebugGoToLine"),
    goToLineInput: document.getElementById("debugGoToLineInput"),
    btnStepOver: document.getElementById("btnDebugStepOver"),
    btnStepBack: document.getElementById("btnDebugStepBack")
  };
}

// Index du snapshot sur lequel "Step into" doit s'ARRETER en cas d'erreur NON
// rattrapee : la cause profonde (1er evenement "exception" de la trace) si la
// trace se termine par une erreur fatale. Sinon -1 : aucun arret force, donc
// les exceptions rattrapees par try/except continuent de se deboguer normalement.
function computeDebugErrorStopIndex(snapshots) {
  if (!Array.isArray(snapshots) || !snapshots.length) return -1;

  const last = snapshots[snapshots.length - 1];
  const unhandled = last && (last.event === "fatal_exception" || last.event === "syntax_error");
  if (!unhandled) return -1;

  for (let i = 0; i < snapshots.length; i++) {
    if (snapshots[i].event === "exception") return i;
  }
  for (let i = 0; i < snapshots.length; i++) {
    if (snapshots[i].event === "syntax_error") return i;
  }
  return snapshots.length - 1;
}



function findStepOverIndex(startIndex) {
  if (!debugSnapshots.length || startIndex < 0 || startIndex >= debugSnapshots.length) {
    return -1;
  }

  const current = debugSnapshots[startIndex];
  const currentFunction = current.function;
  const currentLine = current.line;
  const currentDepth = typeof current.depth === "number" ? current.depth : 0;

  for (let i = startIndex + 1; i < debugSnapshots.length; i++) {
    const snap = debugSnapshots[i];

    if (
      snap.event === "fatal_exception" ||
      snap.event === "syntax_error" ||
      snap.event === "end"
    ) {
      return i;
    }

    const snapDepth = typeof snap.depth === "number" ? snap.depth : 0;

    // Plus profond : on est dans une fonction appelee par la ligne courante,
    // le step over ne s'y arrete pas. La profondeur (et non le seul nom de la
    // fonction) est ce qui permet de ne pas entrer dans un appel RECURSIF.
    if (snapDepth > currentDepth) {
      continue;
    }

    // Moins profond : la fonction courante est terminee, on s'arrete chez
    // celui qui l'a appelee.
    if (snapDepth < currentDepth) {
      return i;
    }

    // Erreur survenue sur la LIGNE COURANTE elle-meme (ex: l'appel f(5) qui
    // plante) : le step over s'arrete au point d'appel, sans entrer dans la
    // fonction ni changer de page.
    if (
      snap.event === "exception" &&
      snap.function === currentFunction &&
      snap.line === currentLine
    ) {
      return i;
    }

    // Sortie de la fonction courante : etape "ce que la fonction renvoie".
    if (snap.event === "return" && snap.function === currentFunction) {
      return i;
    }

    if (snap.function === currentFunction && snap.line !== currentLine) {
      return i;
    }
  }

  return -1;
}

/* bouton executer ligne */
/* bouton Step over : execute la ligne sans entrer dans la fonction */
function handleDebugStepOverClick(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  if (!debugSnapshots.length) return;

  const nextIndex = findStepOverIndex(debugStepIndex);
  if (nextIndex === -1) return;

  debugStepIndex = nextIndex;
  showDebugStepAt(debugStepIndex);
}

function findNextDifferentLineIndex(startIndex) {
  if (!debugSnapshots.length || startIndex < 0 || startIndex >= debugSnapshots.length) {
    return -1;
  }

  const currentLine = debugSnapshots[startIndex].line;

  for (let i = startIndex + 1; i < debugSnapshots.length; i++) {
    if (debugSnapshots[i].line !== currentLine) {
      return i;
    }
  }

  return -1;
}

function findFirstSnapshotIndexForLineAndFunction(targetLine, targetFunction) {
  if (!debugSnapshots.length) return -1;

  for (let i = 0; i < debugSnapshots.length; i++) {
    const snap = debugSnapshots[i];
    if (snap.line === targetLine && snap.function === targetFunction) {
      return i;
    }
  }

  return -1;
}

function findNextIndexForLine(targetLine, startIndex, targetPage) {
  if (!debugSnapshots.length) return -1;

  for (let i = startIndex + 1; i < debugSnapshots.length; i++) {
    const snap = debugSnapshots[i];
    if (snap.line !== targetLine) continue;
    if (
      targetPage !== undefined &&
      targetPage !== null &&
      snap.page !== undefined &&
      snap.page !== targetPage
    ) {
      continue;
    }
    return i;
  }

  return -1;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function varsToHtml(title, varsObj) {
  const keys = Object.keys(varsObj || {});
  let html = `<div><strong>${escapeHtml(title)}</strong></div>`;

  if (keys.length === 0) {
    html += `<div>(aucune)</div>`;
    return html;
  }

  for (const key of keys) {
    html += `<div>${escapeHtml(key)} = ${escapeHtml(varsObj[key])}</div>`;
  }

  return html;
}

let debugStackNodeCounter = 0;

function formatDebugFrameName(name) {
  const raw = String(name ?? "");
  if (raw === "" || raw === "<module>") {
    return "programme principal";
  }
  return raw + "()";
}

// Pile d'appels : le programme principal en haut, la fonction en cours en bas,
// un decalage par niveau. Chaque appelant se deroule pour montrer SES variables
// locales : c'est ce qui rend la recursivite lisible (un niveau = un appel
// encore en attente de son resultat).
// Etape de sortie de fonction : ce que la fonction renvoie, sous forme d'arbre
// depliant (une liste, un tuple ou un dictionnaire se deroulent comme les
// autres variables).
function renderReturnValueHtml(snapshot) {
  if (!snapshot || snapshot.event !== "return") {
    return "";
  }

  const nom = formatDebugFrameName(snapshot.function);
  const valeur = snapshot.return_value;

  let valeurHtml;
  if (window.DebugTreeMenu?.renderDebugVarsTree) {
    // Valeur sans etiquette : le titre du bloc dit deja de quoi il s'agit.
    // On retire le titre interne de l'arbre, puis le " = " de la ligne du
    // haut (celui des elements deplies, plus bas, est conserve).
    valeurHtml = window.DebugTreeMenu
      .renderDebugVarsTree("", { "": valeur })
      .replace(/<div class="debug-tree-title">[^<]*<\/div>/, "")
      .replace(`<span class="debug-tree-sep"> = </span>`, "");
  } else {
    valeurHtml = `<div>${escapeHtml(valeur && valeur.value)}</div>`;
  }

  return `
    <div class="debug-section" style="margin-top:8px; color:#EE0909;">
      <div><strong>La fonction ${escapeHtml(nom)} retourne :</strong></div>
      ${valeurHtml}
    </div>
  `;
}

function renderCallStackHtml(snapshot) {
  const stack = Array.isArray(snapshot?.stack) ? snapshot.stack : [];
  if (!stack.length) {
    return "";
  }

  const levels = stack.slice().reverse(); // du plus ancien appel au plus recent
  const total = levels.length + 1;
  let rows = "";

  levels.forEach((level, position) => {
    debugStackNodeCounter += 1;
    const contentId = "debugStackLevel_" + debugStackNodeCounter;
    const indent = position * 18;

    let localsHtml;
    if (level.same_scope) {
      localsHtml = `<div class="debug-tree-empty">(pas de variables locales : voir les variables globales de la page ci-dessus)</div>`;
    } else if (window.DebugTreeMenu?.renderDebugVarsTree) {
      localsHtml = window.DebugTreeMenu.renderDebugVarsTree("Variables locales", level.locals || {});
    } else {
      localsHtml = varsToHtml("Variables locales", level.locals || {});
    }

    rows += `
      <div class="debug-tree-node" style="margin-left:${indent}px;">
        <div class="debug-tree-row">
          <button
            type="button"
            class="debug-tree-toggle"
            data-target="${contentId}"
            aria-expanded="false"
            title="Dérouler / replier les variables locales de cet appel"
          >&#9654;</button>
          <span class="debug-tree-label">${escapeHtml(formatDebugFrameName(level.function))}</span>
          <span class="debug-tree-type">ligne ${escapeHtml(level.line)} &mdash; en attente</span>
        </div>

        <div id="${contentId}" class="debug-tree-children" style="display:none;">
          ${localsHtml}
        </div>
      </div>
    `;
  });

  rows += `
    <div class="debug-tree-node" style="margin-left:${levels.length * 18}px;">
      <div class="debug-tree-row">
        <span class="debug-tree-label">${escapeHtml(formatDebugFrameName(snapshot.function))}</span>
        <span class="debug-tree-type" style="color:#0b63c9;">ligne ${escapeHtml(snapshot.line)} &mdash; en cours</span>
      </div>
    </div>
  `;

  return `
    <hr>
    <div class="debug-tree-block">
      <div class="debug-tree-title">Pile d'appels (${total} niveaux)</div>
      ${rows}
    </div>
  `;
}

// L'echec d'une page precedente ne concerne la page active que si celle-ci
// s'arrete sur un nom introuvable. Si le programme va au bout, ou s'il
// s'arrete pour une autre raison, l'avertissement n'a pas lieu d'etre.
function debugContextErrorIsRelevant() {
  if (!debugSnapshots.length) return false;

  const last = debugSnapshots[debugSnapshots.length - 1];
  const unhandled = last && (last.event === "fatal_exception" || last.event === "syntax_error");
  if (!unhandled) return false;

  if (snapshotNeedsPreviousContext(last)) return true;

  const cause = debugErrorStopIndex >= 0 ? debugSnapshots[debugErrorStopIndex] : null;
  return snapshotNeedsPreviousContext(cause);
}

function renderSnapshotHtml(snapshot) {
  let html = "";

  function formatVarsInline(vars) {
    const entries = Object.entries(vars || {});
    if (entries.length === 0) {
      return "(aucune)";
    }

    let lines = [];

    for (const [name, value] of entries) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const subEntries = Object.entries(value);

        if (subEntries.length === 0) {
          lines.push(`${escapeHtml(name)} = {}`);
        } else {
          for (const [attr, val] of subEntries) {
            lines.push(`${escapeHtml(name)}.${escapeHtml(attr)} = ${escapeHtml(val)}`);
          }
        }
      } else {
        lines.push(`${escapeHtml(name)} = ${escapeHtml(value)}`);
      }
    }

    return lines.join("<br>");
  }

  html += `<div><strong>Ligne :</strong> ${escapeHtml(snapshot.line)}</div>`;

  html += renderReturnValueHtml(snapshot);

  if (debugFallbackMessage) {
    html += `
      <div style="color:#0b63c9; margin-top:8px; margin-bottom:8px;">
        <strong>Information :</strong> ${escapeHtml(debugFallbackMessage)}
      </div>
    `;
  }

  if (snapshot.context_error && debugContextErrorIsRelevant()) {
    html += `
      <div style="color:#c77700; margin-top:8px; margin-bottom:8px;">
        <strong>Attention :</strong> Une ou plusieurs pages précédentes n'ont pas pu être exécutées.
        Les variables globales de ces pages ne seront pas accessibles ici.
      </div>
    `;
  }

  if (
    snapshot.error_type ||
    snapshot.event === "exception" ||
    snapshot.event === "fatal_exception" ||
    snapshot.event === "syntax_error"
  ) {
    html += `<div style="color:#EE0909;"><strong>Erreur :</strong> ${escapeHtml(snapshot.error_type)} : ${escapeHtml(snapshot.error_message)}</div>`;
  }

  html += `<hr>`;

  const hasContextGlobals =
    snapshot.context_globals &&
    Object.keys(snapshot.context_globals).length > 0;

  if (hasContextGlobals) {
    let contextVarsHtml;
    if (window.DebugTreeMenu?.renderDebugVarsTree) {
      // On retire le titre interne ajouté par renderDebugVarsTree
      // pour ne garder que le titre du bouton.
      contextVarsHtml = window.DebugTreeMenu
        .renderDebugVarsTree("", snapshot.context_globals || {})
        .replace(/<div class="debug-tree-title">[^<]*<\/div>/, "");
    } else {
      contextVarsHtml = formatVarsInline(snapshot.context_globals || {});
    }

    html += `
      <div class="debug-section">
        <button type="button" id="toggleContextGlobalsBtn" class="nav-item nav-btn">
          Variables globales précédentes
        </button>
        <div id="contextGlobalsBlock" class="debug-context-block" style="display:none;">
          <div class="debug-vars-list">
            ${contextVarsHtml}
          </div>
        </div>
      </div>
    `;
  }

  if (snapshot.same_scope) {
    if (window.DebugTreeMenu?.renderDebugVarsTree) {
      html += window.DebugTreeMenu.renderDebugVarsTree(
        "Variables globales de cette page",
        snapshot.globals || {}
      );
    } else {
      html += `<div><strong>Variables globales de cette page</strong><br>${formatVarsInline(snapshot.globals || {})}</div>`;
    }
  } else {
    if (window.DebugTreeMenu?.renderDebugVarsTree) {
      html += window.DebugTreeMenu.renderDebugVarsTree(
        "Variables locales",
        snapshot.locals || {}
      );
      html += `<br>`;
      html += window.DebugTreeMenu.renderDebugVarsTree(
        "Variables globales de cette page",
        snapshot.globals || {}
      );
    } else {
      html += `<div><strong>Variables locales</strong><br>${formatVarsInline(snapshot.locals || {})}</div>`;
      html += `<br>`;
      html += `<div><strong>Variables globales de cette page</strong><br>${formatVarsInline(snapshot.globals || {})}</div>`;
    }
  }

  html += renderCallStackHtml(snapshot);

  if (snapshot.event === "end") {
    html += `<hr><div style="color:#EE0909;"><strong>Fin du pas à pas</strong></div>`;
  }

  return html;
}

function openDebugModal() {
  const { modal } = getDebugModalElements();
  if (!modal) return;
  modal.classList.remove("hidden");
  setDebugMode(true);
}

function closeDebugModal() {
  clearDebugHighlight();
  const { modal } = getDebugModalElements();
  if (!modal) return;
  modal.classList.add("hidden");
  setDebugMode(false);
}

function showDebugStepAt(index) {
  const { content, btnNext, goToLineInput, btnGoToLine, btnStepOver, btnStepBack } = getDebugModalElements();

  if (!content || !btnNext) {
    console.error("Fenêtre de debug introuvable.");
    return;
  }

  if (!debugSnapshots.length) {
    content.innerHTML = "<div>Aucune étape enregistrée.</div>";
    btnNext.disabled = true;
    return;
  }

  if (index < 0 || index >= debugSnapshots.length) {
    content.innerHTML = "<div><strong>Fin du pas à pas.</strong></div>";
    btnNext.disabled = true;
    return;
  }

  const snapshot = debugSnapshots[index];

  // Bascule de page : si la ligne courante est sur une autre page que celle
  // affichee, on ouvre cette page (sans scroll auto : c'est le surlignage qui
  // pilote le defilement). C'est ce qui permet au step into de passer d'une
  // page a l'autre et de s'arreter sur la ligne fautive d'une autre page.
  if (
    typeof snapshot.page === "number" &&
    snapshot.page !== debugDisplayedPage &&
    window.PagesMultiples &&
    typeof window.PagesMultiples.loadPageIntoEditor === "function"
  ) {
    window.PagesMultiples.loadPageIntoEditor(snapshot.page, { keepScroll: true });
    debugDisplayedPage = snapshot.page;
  }

  if (goToLineInput) {
    goToLineInput.value = snapshot.line ?? "";
  }

  if (Number.isInteger(snapshot.line) && snapshot.line >= 1) {
    highlightDebugLine(snapshot.line);
  } else {
    clearDebugHighlight();
  }

  const currentOutput = snapshot.stdout || "";

  if (currentOutput.startsWith(debugLastOutput)) {
    const newPart = currentOutput.slice(debugLastOutput.length);

    if (newPart) {
      if (typeof appendOutput === "function") {
        appendOutput(newPart);
      } else {
        console.log(newPart);
      }
    }
  } else {
    if (typeof setOutput === "function") {
      setOutput(currentOutput);
    } else {
      console.log(currentOutput);
    }
  }

  debugLastOutput = currentOutput;
  content.innerHTML = renderSnapshotHtml(snapshot);

  if (window.DebugTreeMenu?.bindDebugTreeToggles) {
    window.DebugTreeMenu.bindDebugTreeToggles(content);
  }

  const toggleBtn = document.getElementById("toggleContextGlobalsBtn");
  const contextBlock = document.getElementById("contextGlobalsBlock");

  if (toggleBtn && contextBlock) {
    toggleBtn.addEventListener("click", () => {
      const isHidden = contextBlock.style.display === "none";
      contextBlock.style.display = isHidden ? "block" : "none";
    });
  }

  showSnapshotInConsole(snapshot);

  // Arret force sur la cause d'une erreur non rattrapee : une fois la ligne
  // fautive atteinte (meme sur une autre page), on n'avance plus.
  const atErrorStop = (debugErrorStopIndex >= 0 && index >= debugErrorStopIndex);

  btnNext.disabled = atErrorStop || (index >= debugSnapshots.length - 1);

  if (btnGoToLine) {
    btnGoToLine.disabled = false;
  }

  if (btnStepOver) {
    btnStepOver.disabled = atErrorStop || (findStepOverIndex(index) === -1);
  }

  // Retour en arriere : la trace est deja enregistree, donc revenir en arriere
  // est toujours possible, meme apres un arret sur erreur.
  if (btnStepBack) {
    btnStepBack.disabled = (index <= 0);
  }
}

/* bouton Step into : avance d'une etape (entre dans les fonctions) */
function handleDebugNextClick(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  if (!debugSnapshots.length) return;

  const nextIndex = debugStepIndex + 1;

  if (nextIndex >= debugSnapshots.length) {
    const { content, btnNext } = getDebugModalElements();
    if (content) {
      content.innerHTML = "<div><strong>Fin du pas à pas.</strong></div>";
    }
    if (btnNext) {
      btnNext.disabled = true;
    }
    return;
  }

  debugStepIndex = nextIndex;
  showDebugStepAt(debugStepIndex);
}

/* bouton Step back : revient a l'etape precedente de la trace enregistree */
function handleDebugStepBackClick(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  if (!debugSnapshots.length) return;
  if (debugStepIndex <= 0) return;

  debugStepIndex -= 1;
  showDebugStepAt(debugStepIndex);
}

function handleDebugGoToLineClick(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  const { goToLineInput } = getDebugModalElements();
  if (!goToLineInput || !debugSnapshots.length) return;

  const targetLine = parseInt(goToLineInput.value, 10);

  if (!Number.isInteger(targetLine) || targetLine < 1) {
    return;
  }

  // Les numeros de ligne se repetent d'une page a l'autre : on cherche la
  // ligne sur la PAGE actuellement affichee.
  const currentSnapshot = debugSnapshots[debugStepIndex] || {};
  const currentPage = currentSnapshot.page;

  const foundIndex = findNextIndexForLine(targetLine, debugStepIndex, currentPage);

  if (foundIndex !== -1) {
    debugStepIndex = foundIndex;
    showDebugStepAt(debugStepIndex);
  }
}

// ===============================
// Lancement du pas à pas
// ===============================
function snapshotNeedsPreviousContext(snapshot) {
  if (!snapshot) return false;

  const errorType = String(snapshot.error_type || "");
  const errorMessage = String(snapshot.error_message || "");

  if (errorType === "NameError") {
    return true;
  }

  if (errorMessage.includes("is not defined") || errorMessage.includes("name '")) {
    return true;
  }

  return false;
}

function findFirstFailingSnapshotIndex(snapshots) {
  if (!Array.isArray(snapshots)) return -1;

  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    if (
      snap &&
      (
        snap.event === "exception" ||
        snap.event === "fatal_exception" ||
        snap.event === "syntax_error"
      )
    ) {
      return i;
    }
  }

  return -1;
}

async function onStepByStepClick(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  if (debugPreparing) {
    return;
  }

  debugPreparing = true;

  let code;
  try {
    code = getCurrentPythonCode();
  } catch (err) {
    debugPreparing = false;
    console.error(err.message || String(err));
    return;
  }

  let previousPagesCode = "";
  let rawPrev = "";
  let activeIndex = 0;
  let hadInputInPreviousPages = false;

  if (window.PagesMultiples?.getAllPages && window.PagesMultiples?.getActivePageIndex) {
    const allPages = window.PagesMultiples.getAllPages();
    activeIndex = window.PagesMultiples.getActivePageIndex();
    const previousPages = allPages.slice(0, activeIndex);

    // Code BRUT des pages precedentes : sert au hash, partage avec l'execution.
    rawPrev = previousPages
      .map(page => String(page.code || ""))
      .join("\n###__DARIUSH_PAGE_SEP__###\n");

    // Code envoye au worker : pages a input() videes (jamais rejouees),
    // caracteres invisibles retires a la volee (pages non modifiees).
    previousPagesCode = previousPages
      .map(page => {
        const brut = String(page.code || "");
        const c = (typeof window.nettoyerCaracteresInvisibles === "function")
          ? window.nettoyerCaracteresInvisibles(brut)
          : brut;
        if (codeContainsDebuggerUnsupportedFeature(c)) {
          hadInputInPreviousPages = true;
          return "";
        }
        return c;
      })
      .join("\n###__DARIUSH_PAGE_SEP__###\n");
  }

  const hasUnsupportedInActivePage = codeContainsDebuggerUnsupportedFeature(code);
  if (hasUnsupportedInActivePage) {
    clearDebugHighlight();
    showDebugNotSupportedMessage();
    debugPreparing = false;
    return;
  }

  if (hadInputInPreviousPages) {
    alert(
      "Le débogueur de Dariush ne gère pas encore les instructions input(). " +
      "Les variables globales des pages contenant un input() ne seront pas accessibles, " +
      "sauf si vous mettez ces lignes en commentaire et remplacez les input() par des valeurs provisoires."
    );
  }

  clearDebugHighlight();

  // Hash du contexte (partage avec l'execution normale). Si ce contexte a deja
  // expire (page precedente trop lente), on ne le rejoue pas et on previent.
  const contextHash = window.PagesMultiples?.hashContext
    ? window.PagesMultiples.hashContext(rawPrev)
    : null;
  const contextAlreadyExpired = !!(
    contextHash &&
    window.PagesMultiples?.isContextExpired &&
    window.PagesMultiples.isContextExpired(contextHash)
  );

  const slowMessage =
    "Certaines pages précédentes ont un temps d'exécution supérieur à 5 secondes : " +
    "Dariush n'a donc pas pu récupérer les variables globales et fonctions définies en dehors de cette page. Veuillez mettre en commentaire les codes précedents qui posent ce problème de temps. ";

  let contextToUse = previousPagesCode;
  if (contextAlreadyExpired) {
    contextToUse = "";
    alert(slowMessage);
  }

  const combinedSignature = contextToUse + "\n\n###PAGE_ACTIVE###\n\n" + code;

  if (combinedSignature !== debugLastCode) {
    debugLastCode = combinedSignature;
    debugSnapshots = [];
    debugStepIndex = 0;
    debugLastOutput = "";
    if (typeof setOutput === "function") setOutput("");

    try {
      debugSnapshots = await buildDebugSnapshots(code, contextToUse, activeIndex);
    } catch (err) {
      if (err && err.timeout) {
        // Rejeu de contexte trop long (worker deja relance par le chien de
        // garde). On memorise ce contexte comme expire, on previent, et on
        // reconstruit la trace SANS contexte (page active seule).
        if (contextHash && window.PagesMultiples?.markContextExpired) {
          window.PagesMultiples.markContextExpired(contextHash);
        }
        alert(slowMessage);
        debugLastCode = "" + "\n\n###PAGE_ACTIVE###\n\n" + code;

        try {
          debugSnapshots = await buildDebugSnapshots(code, "", activeIndex);
        } catch (err2) {
          debugLastCode = "";
          debugPreparing = false;
          setDebugMode(false);
          console.error("Erreur pendant la construction de la trace : " + (err2?.message || String(err2)));
          return;
        }
      } else {
        debugLastCode = "";
        debugPreparing = false;
        setDebugMode(false);
        console.error("Erreur pendant la construction de la trace : " + (err?.message || String(err)));
        return;
      }
    }
  } else {
    debugStepIndex = 0;
    debugLastOutput = "";
    if (typeof setOutput === "function") setOutput("");
  }

  debugPreparing = false;

  if (!debugSnapshots.length) {
    setDebugMode(false);
    console.log("Aucune étape enregistrée.");
    return;
  }

  debugErrorStopIndex = computeDebugErrorStopIndex(debugSnapshots);
  debugDisplayedPage = activeIndex;

  openDebugModal();
  showDebugStepAt(debugStepIndex);

}

// ===============================
// Initialisation
// ===============================

function initStepByStepButton() {
  const btn = document.getElementById("btnPasAPas");
  const { btnNext, btnClose, btnGoToLine, goToLineInput, btnStepOver, btnStepBack } = getDebugModalElements();

  if (!btn) {
    console.error("Bouton #btnPasAPas introuvable.");
    return;
  }

  if (btnStepOver) {
    btnStepOver.onclick = handleDebugStepOverClick;
  }

  if (btnStepBack) {
    btnStepBack.onclick = handleDebugStepBackClick;
  }

  btn.onclick = onStepByStepClick;

  if (btnNext) {
    btnNext.disabled = false;
    btnNext.onclick = handleDebugNextClick;
  } else {
    console.error("Bouton #btnDebugNext introuvable.");
  }

  if (btnGoToLine) {
    btnGoToLine.onclick = handleDebugGoToLineClick;
  }

  if (goToLineInput) {
    goToLineInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        handleDebugGoToLineClick(e);
      }
    });
  }

  if (btnClose) {
    btnClose.onclick = closeDebugModal;
  } else {
    console.error("Bouton #btnDebugClose introuvable.");
  }

  makeDebugWindowDraggable();
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", initStepByStepButton);
} else {
  initStepByStepButton();
}

// surligne en bleu la ligne de code executée
function makeDebugWindowDraggable() {
  const modalBox = document.querySelector(".debug-modal-box");
  const handle = document.getElementById("debugDragHandle");

  if (!modalBox || !handle) return;

  let isDragging = false;
  let offsetX = 0;
  let offsetY = 0;

  // La fenetre ne sort pas de l'ecran : son bandeau, qui sert a la deplacer
  // et a la fermer, doit toujours rester visible et attrapable.
  function placerDansEcran(left, top) {
    const largeur = modalBox.offsetWidth;
    const hauteurBandeau = handle.offsetHeight || 32;

    const maxLeft = Math.max(0, window.innerWidth - largeur);
    const maxTop = Math.max(0, window.innerHeight - hauteurBandeau - 10);

    modalBox.style.left = Math.min(Math.max(left, 0), maxLeft) + "px";
    modalBox.style.top = Math.min(Math.max(top, 0), maxTop) + "px";
  }

  handle.addEventListener("mousedown", (e) => {
    isDragging = true;
    offsetX = e.clientX - modalBox.offsetLeft;
    offsetY = e.clientY - modalBox.offsetTop;
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;

    placerDansEcran(e.clientX - offsetX, e.clientY - offsetY);
  });

  document.addEventListener("mouseup", () => {
    isDragging = false;
  });

  // Fenetre du navigateur redimensionnee : la boite est ramenee dans l'ecran.
  window.addEventListener("resize", () => {
    if (!modalBox.style.left && !modalBox.style.top) return;
    placerDansEcran(modalBox.offsetLeft, modalBox.offsetTop);
  });
}

function highlightDebugLine(lineNumber) {
  const ed = window.pythonEditor || window.editor;
  if (!ed) return;

  const lineIndex = lineNumber - 1;

  if (debugHighlightedLine !== null) {
    ed.removeLineClass(debugHighlightedLine, "background", "cm-debug-line");
  }

  ed.addLineClass(lineIndex, "background", "cm-debug-line");
  debugHighlightedLine = lineIndex;
  ed.scrollIntoView({ line: lineIndex, ch: 0 }, 100);
}

// efface la ligne bleue
function clearDebugHighlight() {
  const ed = window.pythonEditor || window.editor;
  if (!ed) return;

  if (debugHighlightedLine !== null) {
    ed.removeLineClass(debugHighlightedLine, "background", "cm-debug-line");
    debugHighlightedLine = null;
  }
}

/* DETECTION des inputs */

function removePythonComments(code) {
  return code
    .split("\n")
    .map(line => {
      let inSingle = false;
      let inDouble = false;
      let result = "";

      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        const prev = i > 0 ? line[i - 1] : "";

        if (ch === "'" && !inDouble && prev !== "\\") {
          inSingle = !inSingle;
          result += ch;
          continue;
        }

        if (ch === '"' && !inSingle && prev !== "\\") {
          inDouble = !inDouble;
          result += ch;
          continue;
        }

        if (ch === "#" && !inSingle && !inDouble) {
          break;
        }

        result += ch;
      }

      return result;
    })
    .join("\n");
}

function codeContainsInput(code) {
  const cleanCode = removePythonComments(code);
  return /\binput\s*\(/.test(cleanCode);
}

function codeContainsRandom(code) {
  const cleanCode = removePythonComments(code);
  return /\brandom\s*\./.test(cleanCode) || /\bfrom\s+random\s+import\b/.test(cleanCode);
}

function codeContainsDebuggerUnsupportedFeature(code) {
  return codeContainsInput(code);
}

function showDebugPreviousPagesNotSupportedMessage() {
  const { content, btnNext, btnGoToLine, btnStepOver } = getDebugModalElements();

  openDebugModal();

  if (btnStepOver) btnStepOver.disabled = true;
  if (btnGoToLine) btnGoToLine.disabled = true;
  if (btnNext) btnNext.disabled = true;

  if (content) {
    content.innerHTML = `
      <div>
        Le débogueur a besoin de recharger une ou plusieurs pages précédentes
        pour retrouver des variables globales, mais ces pages contiennent
        une instruction <code>input()</code>.
        <br><br>
        Le pas à pas peut donc démarrer tant qu’il n’a pas besoin de ces pages,
        mais il ne peut pas les rejouer automatiquement dans cet état.

        <br><br>
        Mettez provisoirement en commentaire les lignes concernées dans les pages
        précédentes et remplacez-les par des valeurs fixes.
      </div>
    `;
  }
}

function showDebugNotSupportedMessage() {
  const { content, btnNext, btnGoToLine, btnStepOver } = getDebugModalElements();

  openDebugModal();

  if (btnStepOver) {
    btnStepOver.disabled = true;
  }

  if (btnGoToLine) {
    btnGoToLine.disabled = true;
  }

  if (content) {
    content.innerHTML = `
      <div>
        Le débogueur de Dariush ne gère pas encore les instructions <code>input()</code>.
        Pour utiliser le pas à pas, mettez ces lignes en commentaire et remplacez-les par des valeurs provisoires.
        <br><br>
        Exemples :
        <code># a = input("entrez un nombre")</code>
        <br><br>
        <code>a = "12"</code>
      </div>
    `;
  }

  if (btnNext) {
    btnNext.disabled = true;
  }
}