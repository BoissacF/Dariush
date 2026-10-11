
/***************************************************************
DARIUSH PYTHON — 8/02/2026
auteur : Frédéric Boissac
licence : gratos pour un usage non commercial
***************************************************************/


let numversion="cssjs45";
let buildVersion = "29970-1887"; // à changer à chaque modification du worker

let editor;
let pyodideInstance = null;

let pyWorker = null;
let pyWorkerReady = false;

let outputElement, outputVerticalElement, outputHorizontalElement, runButton;
let isHorizontalOutput = false;
let inputPanel, inputPromptEl, inputValueEl, sendInputButton, cancelInputButton;

let pendingInputResolve = null;
let pendingInputReject = null;

let pendingWorkerInputRequestId = null;

let emergencyButton;
window.isDebugMode = false;


function activerGuidesIndentation(cm) {
  if (!cm) return;

  const couleur = "rgba(128,128,128,0.28)";

  function largeurIndentation(texte) {
    const tabSize = cm.getOption("tabSize") || 4;
    const leading = (texte.match(/^[ \t]*/) || [""])[0];
    let cols = 0;
    for (const ch of leading) cols += (ch === "\t") ? tabSize : 1;
    return cols;
  }

  // Ensemble des colonnes où un VRAI texte commence (lignes non vides uniquement)
  function recalculerColonnes() {
    const set = new Set();
    cm.eachLine(function (h) {
      if (!/\S/.test(h.text)) return;          // ligne vide ou blancs seuls : ignorée
      const cols = largeurIndentation(h.text);
      if (cols > 0) set.add(cols);
    });
    const sig = Array.from(set).sort((a, b) => a - b).join(",");
    if (sig !== cm._guideSig) {
      cm._guideSig = sig;
      cm._guideCols = set;
      return true;                              // l'ensemble a changé
    }
    return false;
  }

  cm._guideCols = new Set();
  cm._guideSig = null;
  recalculerColonnes();

  cm.on("renderLine", function (cm, line, elt) {
    const cols = largeurIndentation(line.text);
    if (cols <= 0) { elt.style.backgroundImage = ""; return; }

    const charWidth   = cm.defaultCharWidth();
    const basePadding = 4; // padding gauche par défaut d'une ligne CodeMirror
    const stops = [];

    cm._guideCols.forEach(function (C) {
      if (C > cols) return;                     // barre au-delà du texte de la ligne : ignorée
      const x = basePadding + C * charWidth;
      stops.push(
        "linear-gradient(to right, transparent " + x + "px, " +
        couleur + " " + x + "px, " + couleur + " " + (x + 1) + "px, " +
        "transparent " + (x + 1) + "px)"
      );
    });

    elt.style.backgroundImage  = stops.length ? stops.join(",") : "";
    elt.style.backgroundRepeat = "no-repeat";
    elt.style.backgroundSize   = "100% 100%";
  });

  // Si les colonnes d'alignement changent (ajout/retrait d'un niveau), on redessine tout
  cm.on("change", function () {
    if (recalculerColonnes()) cm.refresh();
  });

  cm.refresh();
}


function ajusterHauteurEditeurHorizontal() {
  if (!editor) return;

  const scroller = editor.getScrollerElement();
  const wrapper = editor.getWrapperElement();
  if (!scroller || !wrapper) return;

  const lastLine = Math.max(0, editor.lineCount() - 1);
  const lastLineTop = editor.heightAtLine(lastLine, "local");
  const lineHeight = editor.defaultTextHeight();
  const extraPixels = lineHeight * 2;

  const wantedHeight = Math.max(
    6 * lineHeight,
    lastLineTop + lineHeight + extraPixels
  );

  scroller.style.height = wantedHeight + "px";
  wrapper.style.height = wantedHeight + "px";
  scroller.style.overflowY = "hidden";
  scroller.style.overflowX = "auto";

  editor.refresh();
}


// ───────────────────────────────────────────────────────────────────────────
// Chien de garde du rejeu de contexte.
// Quand le worker rejoue les pages precedentes (run force par une dependance,
// ou build du debogueur), il ne doit pas tourner indefiniment (page lente /
// boucle infinie sur une page precedente). On arme une minuterie ; si elle
// expire, on tue et relance le worker, puis on previent.
// ───────────────────────────────────────────────────────────────────────────
const ContextWatchdog = {
  timerId: null,
  delayMs: 5000,
  onTimeout: null,

  arm(onTimeout) {
    this.disarm();
    this.onTimeout = typeof onTimeout === "function" ? onTimeout : null;
    this.timerId = setTimeout(async () => {
      this.timerId = null;
      const cb = this.onTimeout;
      this.onTimeout = null;
      try {
        if (typeof window.restartPyodideWorker === "function") {
          await window.restartPyodideWorker();
        } else if (typeof restartPyodideWorker === "function") {
          await restartPyodideWorker();
        }
      } catch (e) {
        console.error("Redémarrage du worker après expiration :", e);
      }
      if (cb) cb();
    }, this.delayMs);
  },

  disarm() {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.onTimeout = null;
  }
};

let runContextHadInputPages = false;
let lastRunContextHash = null;   // hash du contexte du dernier run
let pendingRunExpired = false;   // true si ce contexte est deja marque expire


// Detecte un appel input() en ignorant les commentaires (meme logique que le
// debogueur). Sert a ne pas rejouer en contexte les pages qui attendent une saisie.
function codeContainsInputForRun(code) {
  const sansCommentaires = String(code || "").replace(/#.*$/gm, "");
  return /\binput\s*\(/.test(sansCommentaires);
}



//gestion du pasa pas par le worker
function requestDebugSnapshotsFromWorker(code, contextCode = "", activePageIndex = 0) {
  return new Promise((resolve, reject) => {
    if (!pyWorker || !pyWorkerReady) {
      reject(new Error("Worker Python non prêt"));
      return;
    }

    let activeIndex = parseInt(activePageIndex, 10);
    if (!Number.isFinite(activeIndex) || activeIndex < 0) {
      activeIndex = 0;
    }

    const cleanup = () => {
      ContextWatchdog.disarm();
      pyWorker.removeEventListener("message", onMessage);
    };

    const onMessage = (event) => {
      const data = event.data || {};

      if (data.type === "debug_replay_start") {
        // Le build commence (apres chargement des paquets) : on surveille.
        ContextWatchdog.arm(() => {
          // Le worker a ete tue et relance par le chien de garde. Le listener
          // courant ne recevra plus rien : on nettoie et on rejette.
          pyWorker.removeEventListener("message", onMessage);
          const e = new Error("Rejeu de contexte trop long (plus de 5 s).");
          e.timeout = true;
          reject(e);
        });
        return;
      }

      if (data.type === "debug_snapshots_result") {
        cleanup();
        resolve(Array.isArray(data.snapshots) ? data.snapshots : []);
        return;
      }

      if (data.type === "error") {
        cleanup();
        reject(new Error(data.message || "Erreur worker"));
      }
    };

    pyWorker.addEventListener("message", onMessage);
    pyWorker.postMessage({
      type: "build_debug_snapshots",
      code: String(code || ""),
      contextCode: String(contextCode || ""),
      activePageIndex: activeIndex
    });
  });
}

window.requestDebugSnapshotsFromWorker = requestDebugSnapshotsFromWorker;

// fin de gestion du pas a pas par le worker

// ===== Gestion du worker Pyodide =====

async function restartPyodideWorker() {
  pyWorkerReady = false;
  
 
window.pyWorkerReady = false;

  if (pyWorker) {
    try {
      pyWorker.terminate();
    } catch (err) {
      console.warn("Impossible de terminer l'ancien worker :", err);
    }
    pyWorker = null;
  }

  pendingWorkerInputRequestId = null;
  pendingInputResolve = null;
  pendingInputReject = null;
  hideInput();

  if (runButton) {
    runButton.disabled = true;
  }

  setOutput("Redémarrage de l'interpréteur Python...");

  await initPyodideWorker();

  if (runButton) {
    runButton.disabled = false;
  }

  setOutput("L'interpréteur Python (worker) est prêt. Cliquez sur Exécuter.\n");
}

window.restartPyodideWorker = restartPyodideWorker;

async function resetWorkerPythonState() {
  await restartPyodideWorker();
}

window.resetWorkerPythonState = resetWorkerPythonState;

function finishWorkerExecution() {
  ensureNewLine();

  if (runButton) {
    runButton.disabled = false;
  }

  if (window.PythonAutosave) {
    window.PythonAutosave.notifyExecutionEnd();
  }
}

function initPyodideWorker() {
  return new Promise((resolve, reject) => {
    let initResolved = false;

    try {
      // portable=1 -> Pyodide local ; portable=0 -> Pyodide depuis le CDN
      var portableFlag = (typeof window !== "undefined" && window.MODE_PORTABLE) ? "1" : "0";
      pyWorker = new Worker(
        numversion + "/pyworker.js?v=" + buildVersion + "&portable=" + portableFlag
      );
      window.pyWorker = pyWorker;
      window.pyWorkerReady = false;
    } catch (err) {
      reject(err);
      return;
    }
    pyWorker.onmessage = (event) => {
      const data = event.data || {};

      if (data.type === "run_replay_start") {
        if (runContextHadInputPages) {
          appendOutput(
            "Information : une ou plusieurs pages précédentes contiennent input() " +
            "et n'ont pas été rejouées. Leurs variables globales ne sont pas accessibles ici.\n"
          );
        }
        ContextWatchdog.arm(() => {
          if (lastRunContextHash && window.PagesMultiples?.markContextExpired) {
            window.PagesMultiples.markContextExpired(lastRunContextHash);
          }
          appendOutput(
            "ERR: Dariush a dû rejouer les pages précédentes, mais certaines sont " +
            "trop longues (boucle infinie ?) et n'ont pas pu être rejouées : les variables " +
            "globales des pages précédentes ne sont pas accessibles.\n"
          );
          finishWorkerExecution();
        });
        return;
      }

      if (data.type === "run_replay_end") {
        ContextWatchdog.disarm();
        return;
      }

      if (data.type === "status") {
        return;
      }

      if (data.type === "stdout") {
        const text = String(data.text || "");
        appendOutput(text.endsWith("\n") ? text : text + "\n");
        return;
      }

      if (data.type === "stderr") {
        const text = String(data.text || "");
        appendOutput(text.endsWith("\n") ? "ERR: " + text : "ERR: " + text + "\n");
        return;
      }

      if (data.type === "info") {
        const text = String(data.message || "");
        appendOutput(text.endsWith("\n") ? text : text + "\n");
        return;
      }

      if (data.type === "input_request") {
        pendingWorkerInputRequestId = data.requestId;
        requestInput(String(data.prompt || ""));
        return;
      }

      if (data.type === "done") {
        ContextWatchdog.disarm();
        pendingRunExpired = false;
        finishWorkerExecution();
        return;
      }

      if (data.type === "ready") {
        pyWorkerReady = true;
        window.pyWorkerReady = true;
        initResolved = true;
        resolve();
        return;
      }

      if (data.type === "image") {
        const base64 = String(data.base64 || "");
        if (base64 && typeof window.displayPythonImageFromBase64 === "function") {
          window.displayPythonImageFromBase64(base64);
        }
        return;
      }

      if (data.type === "html_output") {
        if (typeof window.AffichageHTML !== "undefined" && window.AffichageHTML.show) {
          window.AffichageHTML.show(
            String(data.html || ""),
            { title: data.title, filename: data.filename }
          );
        }
        return;
      }

      if (data.type === "error") {
        ContextWatchdog.disarm();
        const message = String(data.message || "Erreur worker");
        appendOutput("ERR: " + message + "\n");

        if (pendingRunExpired && /\bNameError\b/.test(message)) {
          appendOutput(
            "Information : une ou plusieurs pages précédentes sont trop longues " +
            "(boucle infinie ?) et n'ont pas été rejouées : les variables globales des " +
            "pages précédentes ne sont pas accessibles ici.\n"
          );
        }
        pendingRunExpired = false;

        finishWorkerExecution();

        if (!initResolved) {
          reject(new Error(message));
        } else {
          handleImportErrorIfAny(message);
        }

        return;
      }
    };

    pyWorker.onerror = (err) => {
      if (!initResolved) {
        reject(err);
      } else {
        console.error("Erreur worker :", err);
        appendOutput("ERR: erreur interne du worker.\n");
        finishWorkerExecution();
      }
    };

    pyWorker.postMessage({ type: "init" });
  });
}

function handleImportErrorIfAny(errorMessage) {
  // Détecte "ModuleNotFoundError: No module named 'xxx'" ou "ImportError: No module named 'xxx'"
  const match = String(errorMessage || "").match(
    /(?:ModuleNotFoundError|ImportError)[^']*'([^']+)'/
  );
  if (!match) return;

  const detected = match[1].split(".")[0]; // "PIL.Image" → "PIL"

  if (!confirm("Échec d'importation de " + detected + ", voulez-vous essayer de l'importer avec micropip ?")) {
    return;
  }

  const moduleName = prompt(
    "Nom du package à installer via micropip (modifiable si différent de l'import) :",
    detected
  );
  if (moduleName === null) return;

  const trimmed = String(moduleName).trim();
  if (!trimmed) return;

  installModuleViaMicropip(trimmed);
}

function installModuleViaMicropip(moduleName) {
  if (!pyWorker || !pyWorkerReady) {
    appendOutput("ERR: worker Python non prêt.\n");
    return;
  }

  appendOutput("Installation du module " + moduleName + " en cours...\n");

  const onMessage = (event) => {
    const data = event.data || {};
    if (data.type !== "install_module_result") return;
    if (data.moduleName !== moduleName) return;

    pyWorker.removeEventListener("message", onMessage);

    if (data.success) {
      appendOutput("Importation de " + moduleName + " terminée.\n");
      if (runButton && !runButton.disabled) {
        runButton.click();
      }
    } else {
      appendOutput("Importation de " + moduleName + " échouée : " + (data.error || "erreur inconnue") + "\n");
    }
  };

  pyWorker.addEventListener("message", onMessage);

  pyWorker.postMessage({
    type: "install_module",
    moduleName: moduleName
  });
}


function writeFileToWorker(filename, bytes) {
  return new Promise((resolve, reject) => {
    if (!pyWorker || !pyWorkerReady) {
      reject(new Error("Worker Python non prêt."));
      return;
    }

    const onMessage = (event) => {
      const data = event.data || {};

      if (data.type === "file_written" && data.filename === filename) {
        pyWorker.removeEventListener("message", onMessage);
        resolve(filename);
        return;
      }

      if (data.type === "error") {
        pyWorker.removeEventListener("message", onMessage);
        reject(new Error(data.message || "Erreur worker"));
      }
    };

    pyWorker.addEventListener("message", onMessage);

    pyWorker.postMessage({
      type: "write_file",
      filename,
      bytes: Array.from(bytes || [])
    });
  });
}

window.writeFileToWorker = writeFileToWorker;
window.addAwaitToInputCalls = addAwaitToInputCalls;

// ===== Fin gestion du worker Pyodide =====

//=====passage horizontal vertical
function setOutputLayout(horizontal) {
  const rightCol = document.getElementById("rightCol");
  const horizontalWrap = document.getElementById("horizontalOutputWrap");
  const layoutToggleButton = document.getElementById("layoutToggleButton");
  const mainSplit = document.getElementById("mainSplit");
  const colResizer = document.getElementById("colResizer");

  isHorizontalOutput = !!horizontal;

  if (rightCol) {
    rightCol.style.display = isHorizontalOutput ? "none" : "flex";
  }

  if (horizontalWrap) {
    horizontalWrap.style.display = isHorizontalOutput ? "block" : "none";
  }

  if (mainSplit) {
    mainSplit.classList.toggle("horizontal-layout", isHorizontalOutput);
  }

  if (colResizer) {
    colResizer.style.display = isHorizontalOutput ? "none" : "";
  }

  const newOutput = isHorizontalOutput ? outputHorizontalElement : outputVerticalElement;

  if (outputElement && newOutput && outputElement !== newOutput) {
    newOutput.textContent = outputElement.textContent;
  }

  outputElement = newOutput;

if (layoutToggleButton) {
  if (isHorizontalOutput) {
    layoutToggleButton.textContent = "⬌";
    layoutToggleButton.title = "Passer en affichage côte à côte";
  } else {
    layoutToggleButton.textContent = "⬍";
    layoutToggleButton.title = "Passer en affichage horizontal";
  }
}

  updateEditorLayoutMode();
  
 //if (isHorizontalOutput) {
  requestAnimationFrame(() => {
    ajusterHauteurEditeurHorizontal();
  });
//}
  
  
  
  applyEditorFontSize(currentEditorFontSize);
  if (window.saveEditorLayout) {
  window.saveEditorLayout(isHorizontalOutput ? "horizontal" : "vertical");
}
  updateBottomPageNav();
}


function updateEditorLayoutMode() {
  if (!editor) return;

  const wrapper = editor.getWrapperElement();
  const scroller = editor.getScrollerElement();
  if (!wrapper || !scroller) return;

  // Identique dans les deux modes : ajusterHauteurEditeurHorizontal gère la hauteur
  editor.setOption("viewportMargin", 10);
  wrapper.style.height = "auto";
  wrapper.style.flex = "0 0 auto";
  scroller.style.overflowY = "hidden";
  scroller.style.overflowX = "auto";

  editor.refresh();
}

function toggleOutputLayout() {
  setOutputLayout(!isHorizontalOutput);
}
  
  
  //====fin passage horizontal vertical
  

/* grossissement texte avec sourie*/

const MIN_EDITOR_FONT_SIZE = 10;
const MAX_EDITOR_FONT_SIZE = 40;
const DEFAULT_EDITOR_FONT_SIZE = 14;

let currentEditorFontSize = DEFAULT_EDITOR_FONT_SIZE;

function clampFontSize(size) {
  return Math.max(MIN_EDITOR_FONT_SIZE, Math.min(MAX_EDITOR_FONT_SIZE, size));
}

function applyEditorFontSize(size) {
  currentEditorFontSize = clampFontSize(size);

  // CodeMirror
  if (editor) {
    const wrapper = editor.getWrapperElement();
    if (wrapper) {
      wrapper.style.fontSize = currentEditorFontSize + "px";
    }
    editor.refresh();
  }
  
  
  
  
  // ===== commentaire (textarea) — ANCIEN système mono-bloc =====
const textarea = document.getElementById("exerciseText");
if (textarea) {
  textarea.style.fontSize = currentEditorFontSize + "px";
}

// ===== aperçu markdown — ANCIEN système mono-bloc =====
const preview = document.getElementById("exercisePreview");
if (preview) {
  preview.style.fontSize = currentEditorFontSize + "px";
}

// ===== MARKDOWNS MULTIPLES : tous les blocs (textareas + aperçus) =====
const mdContainer = document.getElementById("markdownsContainer");
if (mdContainer) {
  mdContainer.querySelectorAll(".md-block-textarea, .md-block-preview")
    .forEach((el) => {
      el.style.fontSize = currentEditorFontSize + "px";
    });
}

  // Console d'exécution
  if (outputVerticalElement) {
  outputVerticalElement.style.fontSize = currentEditorFontSize + "px";
}

if (outputHorizontalElement) {
  outputHorizontalElement.style.fontSize = currentEditorFontSize + "px";
}
   updateZoomControls();
}

// Réapplique UNIQUEMENT la taille courante aux blocs markdown (après une
// régénération : changement de page, ajout de bloc...). Lit la taille locale,
// ne touche ni au code, ni à la console, ni au curseur. Pas de NaN possible.
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
  const zoomRange = document.getElementById("zoomRange");
  const zoomPercentLabel = document.getElementById("zoomPercentLabel");

  if (zoomRange) {
    zoomRange.min = String(MIN_EDITOR_FONT_SIZE);
    zoomRange.max = String(MAX_EDITOR_FONT_SIZE);
    zoomRange.step = "1";
    zoomRange.value = String(currentEditorFontSize);
  }

  if (zoomPercentLabel) {
    const percent = Math.round((currentEditorFontSize / DEFAULT_EDITOR_FONT_SIZE) * 100);
    zoomPercentLabel.textContent = percent + "%";
  }
}

function handleWheelFontResize(event) {
  // Sans Ctrl : comportement normal = défilement
  if (!event.ctrlKey) {
    return;
  }

  // Avec Ctrl : on empêche le zoom navigateur / scroll normal
  event.preventDefault();

  if (event.deltaY < 0) {
    changeEditorFontSize(1);   // molette vers le haut => agrandir
  } else if (event.deltaY > 0) {
    changeEditorFontSize(-1);  // molette vers le bas => réduire
  }
}
/*fin du grossissement*/


/* ===========================
   """ Gestion de l'affichage de la descritpion de l exercice"""
   =========================== */
const DEFAULT_EXERCISE_TEXT = "";
const EXERCISE_PLACEHOLDER_TEXT = "Entrez un commentaire pour ce code";
function getExerciseTextarea() {
  return document.getElementById("exerciseText");
}

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
  autoResizeTextarea(el);
  
  if (window.MarkdownEditor && typeof window.MarkdownEditor.refreshPreview === "function") {
  window.MarkdownEditor.refreshPreview();
}
  
  
  
}

/* Encodage base64 URL-safe pour supporter accents + retours ligne */
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
  const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/* ===========================
   """ Gestion de l'affichage """
   =========================== */

/**
""" Remplace totalement le texte de la sortie (efface l’ancien contenu). """
*/
function setOutput(text) {
  outputElement.textContent = text;
}

/**
""" Ajoute du texte à la fin de la sortie. """
*/
function appendOutput(text) {
  outputElement.textContent += text;
}


// Lecture/ecriture de la fenetre d'execution TEXTE (utilisees par la
// memorisation par page dans pagesmultiples.js). Texte pur : les images et
// panels matplotlib ne sont pas concernes (ils sont geres hors de cette zone).
window.getCurrentOutputText = function () {
  return outputElement ? outputElement.textContent : "";
};
window.setCurrentOutputText = function (text) {
  if (outputElement) outputElement.textContent = String(text == null ? "" : text);
};
/**
""" S’assure qu’on commence à écrire sur une nouvelle ligne.
Si la sortie ne finit pas par '\n', on ajoute '\n'. """
*/
function ensureNewLine() {
  const t = outputElement.textContent;
  if (t.length > 0 && !t.endsWith("\n")) appendOutput("\n");
}

/* ==================================================
   """ Gestion d'un input() Python (asynchrone) """
   ================================================== */

/**
""" Affiche le panneau de saisie et renvoie une Promise.
- resolve(valeur) quand l’élève valide
- reject(erreur) quand l’élève annule
"""
*/
function requestInput(promptText) {
  return new Promise((resolve, reject) => {
    pendingInputResolve = resolve;
    pendingInputReject = reject;

    inputPromptEl.textContent = promptText || "Saisie requise :";
    inputValueEl.value = "";
    inputPanel.style.display = "block";
    inputValueEl.focus();
  });
}

/**
""" Cache le panneau de saisie. """
*/
function hideInput() {
  inputPanel.style.display = "none";
}

/**
""" Valide la saisie :
- cache le panneau
- echo la valeur dans la sortie (style terminal)
- résout la Promise pour débloquer input() côté Python
"""
*/
function submitInput() {
  const v = inputValueEl.value ?? "";
  hideInput();

  appendOutput(v + "\n");

  if (pendingWorkerInputRequestId !== null && pyWorker) {
    pyWorker.postMessage({
      type: "input_response",
      requestId: pendingWorkerInputRequestId,
      value: v
    });
    pendingWorkerInputRequestId = null;
    return;
  }

  if (!pendingInputResolve) return;

  const resolve = pendingInputResolve;
  pendingInputResolve = null;
  pendingInputReject = null;
  resolve(v);
}

/**
""" Annule la saisie :
- cache le panneau
- rejette la Promise
"""
*/
function cancelInput() {
  hideInput();

  if (pendingWorkerInputRequestId !== null && pyWorker) {
    pyWorker.postMessage({
      type: "input_cancel",
      requestId: pendingWorkerInputRequestId
    });
    pendingWorkerInputRequestId = null;
    return;
  }

  if (!pendingInputReject) return;

  const reject = pendingInputReject;
  pendingInputResolve = null;
  pendingInputReject = null;
  reject(new Error("Saisie annulée"));
}

/* =========================================================
   """ Transformation du code : ajouter await devant input() """
   ========================================================= */

/**
""" Ajoute automatiquement "await" devant chaque appel à input(...)
en évitant (de manière simple) les strings et commentaires.

Suffisant pour des codes lycée (pas de triple quotes).
"""
*/
function addAwaitToInputCalls(code) {
  let out = "";
  let i = 0;

  let inSingle = false;
  let inDouble = false;

  while (i < code.length) {
    const ch = code[i];

    // Commentaire Python (#) si pas dans une string
    if (!inSingle && !inDouble && ch === "#") {
      while (i < code.length && code[i] !== "\n") {
        out += code[i++];
      }
      continue;
    }

    // Quotes simples/doubles
    if (!inDouble && ch === "'" && code[i - 1] !== "\\") inSingle = !inSingle;
    if (!inSingle && ch === '"' && code[i - 1] !== "\\") inDouble = !inDouble;

    // Détection input( / input (
    if (!inSingle && !inDouble) {
      if (code.startsWith("input", i)) {
        const prev = i > 0 ? code[i - 1] : "";
        const isWordBoundaryBefore = !/[A-Za-z0-9_]/.test(prev);

        let j = i + 5;
        while (j < code.length && /\s/.test(code[j])) j++;

        if (isWordBoundaryBefore && code[j] === "(") {
          // Vérifier si déjà précédé par await
          let k = out.length - 1;
          while (k >= 0 && /\s/.test(out[k])) k--;
          const alreadyAwait = k >= 4 && out.slice(k - 4, k + 1) === "await";
          if (!alreadyAwait) out += "await ";
        }
      }
    }

    out += ch;
    i++;
  }

  return out;
}

/* =========================================================
   """ Nettoyage du code : caractères invisibles du copier-coller """
   ========================================================= */

// Espaces "exotiques" (insécable, fine, cadratin, idéographique...) : ils
// ressemblent à un espace normal mais Python les refuse -> espace normal.
const ESPACES_EXOTIQUES_PYTHON = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/;

// Caractères sans largeur (espace sans chasse, BOM, césure invisible, marques
// de sens d'écriture...) : supprimés. Les remplacer par un espace décalerait
// l'indentation ou couperait un mot en deux.
const CARACTERES_SANS_LARGEUR_PYTHON = /[\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

/**
""" Renvoie le code débarrassé des caractères invisibles que Python refuse.

Les chaînes de caractères et les commentaires sont recopiés tels quels :
Python les y accepte, et un texte peut en contenir volontairement.
Dans une f-string, seul le code placé entre { } est nettoyé.
Le nombre de lignes ne change jamais.
"""
*/
function nettoyerCaracteresInvisibles(code) {
  const source = String(code ?? "");

  // Cas habituel : rien à nettoyer, on rend le code sans le parcourir
  if (
    !ESPACES_EXOTIQUES_PYTHON.test(source) &&
    !CARACTERES_SANS_LARGEUR_PYTHON.test(source)
  ) {
    return source;
  }

  let out = "";
  let i = 0;

  // Chaînes ouvertes, de la plus externe à la plus interne. Pour une f-string,
  // accolades > 0 signifie qu'on est entre { } : c'est de nouveau du code.
  const chaines = [];

  while (i < source.length) {
    const ch = source[i];
    const chaine = chaines.length ? chaines[chaines.length - 1] : null;
    const dansTexte = !!chaine && chaine.accolades === 0;

    // Antislash dans le texte d'une chaîne : il protège le caractère suivant
    if (dansTexte && ch === "\\" && i + 1 < source.length) {
      out += ch + source[i + 1];
      i += 2;
      continue;
    }

    // Fin de ligne : une chaîne à guillemet simple s'arrête là, fermée ou non
    if (ch === "\n") {
      while (chaines.length && chaines[chaines.length - 1].delimiteur.length === 1) {
        chaines.pop();
      }
      out += ch;
      i++;
      continue;
    }

    // Texte d'une chaîne : recopié tel quel jusqu'au délimiteur fermant
    if (dansTexte) {
      if (source.startsWith(chaine.delimiteur, i)) {
        out += chaine.delimiteur;
        i += chaine.delimiteur.length;
        chaines.pop();
        continue;
      }

      if (chaine.fString && ch === "{") {
        // {{ est une accolade affichée, { seule ouvre une expression
        if (source[i + 1] === "{") {
          out += "{{";
          i += 2;
          continue;
        }
        chaine.accolades = 1;
      }

      out += ch;
      i++;
      continue;
    }

    // À partir d'ici : du code (niveau principal, ou entre { } d'une f-string)
    if (chaine) {
      if (ch === "{") chaine.accolades++;
      if (ch === "}") chaine.accolades--;
    } else if (ch === "#") {
      // Commentaire Python : recopié tel quel jusqu'à la fin de la ligne
      while (i < source.length && source[i] !== "\n") {
        out += source[i++];
      }
      continue;
    }

    // Début de chaîne : ' " ''' ou """, f-string si préfixe f, fr ou rf
    if (ch === "'" || ch === '"') {
      const delimiteur = source.startsWith(ch + ch + ch, i) ? ch + ch + ch : ch;
      const fString = /(^|[^a-z0-9_])(f|fr|rf)$/.test(out.slice(-3).toLowerCase());

      chaines.push({ delimiteur, fString, accolades: 0 });
      out += delimiteur;
      i += delimiteur.length;
      continue;
    }

    if (ESPACES_EXOTIQUES_PYTHON.test(ch)) {
      out += " ";
    } else if (!CARACTERES_SANS_LARGEUR_PYTHON.test(ch)) {
      out += ch;
    }
    i++;
  }

  return out;
}

/**
""" Appelée juste avant une exécution (bouton Exécuter, pas à pas).

Renvoie le code de l'éditeur sans ses caractères invisibles et corrige
l'éditeur lui-même : aux exécutions suivantes il n'y a plus rien à faire.
Aucun message n'est affiché.

- une seule modification CodeMirror, donc un seul événement "change" ;
- curseur, sélection et défilement conservés ;
- éditeur en lecture seule (élève d'un groupe sans droit d'écriture) :
  l'éditeur reste tel quel, seul le code envoyé à Python est nettoyé.
"""
*/
function nettoyerEditeurAvantExecution(cm) {
  const code = cm.getValue();
  const propre = nettoyerCaracteresInvisibles(code);

  if (propre === code) return code;

  try {
    if (cm.getOption("readOnly")) return propre;

    // Plus petite zone qui diffère entre l'ancien code et le nouveau
    let debut = 0;
    while (debut < propre.length && code[debut] === propre[debut]) debut++;

    let finAncien = code.length;
    let finPropre = propre.length;
    while (finPropre > debut && code[finAncien - 1] === propre[finPropre - 1]) {
      finAncien--;
      finPropre--;
    }

    // Curseur / sélection, repérés par leur place dans le code nettoyé
    const reperes = cm.listSelections().map((sel) => ({
      anchor: nettoyerCaracteresInvisibles(code.slice(0, cm.indexFromPos(sel.anchor))).length,
      head: nettoyerCaracteresInvisibles(code.slice(0, cm.indexFromPos(sel.head))).length
    }));

    cm.operation(() => {
      cm.replaceRange(
        propre.slice(debut, finPropre),
        cm.posFromIndex(debut),
        cm.posFromIndex(finAncien)
      );

      cm.setSelections(
        reperes.map((r) => ({
          anchor: cm.posFromIndex(r.anchor),
          head: cm.posFromIndex(r.head)
        })),
        undefined,
        { scroll: false }
      );
    });
  } catch (err) {
    console.warn("Nettoyage des caractères invisibles : éditeur non modifié.", err);
  }

  return propre;
}

window.nettoyerCaracteresInvisibles = nettoyerCaracteresInvisibles;
window.nettoyerEditeurAvantExecution = nettoyerEditeurAvantExecution;

/* =====================================
   """ Initialisation de l'application """
   ===================================== */

/**
""" Récupère le DOM, crée CodeMirror, branche les events, puis charge Pyodide. """
*/
async function initPythonEditor() {
  outputVerticalElement = document.getElementById("output");
outputHorizontalElement = document.getElementById("outputhorizontal");
outputElement = outputVerticalElement;
  runButton = document.getElementById("runButton");
  
emergencyButton = document.getElementById("emergencyButton");
  inputPanel = document.getElementById("inputPanel");
  inputPromptEl = document.getElementById("inputPrompt");
  inputValueEl = document.getElementById("inputValue");
  sendInputButton = document.getElementById("sendInputButton");
  cancelInputButton = document.getElementById("cancelInputButton");

  const codeEditorEl = document.getElementById("codeEditor");
  
  const linkInput = document.getElementById("generatedLink");
  
  const exerciseTextEl = document.getElementById("exerciseText");
  
  const clearButtonCode = document.getElementById("clearButtonCode");
  
  
  const zoomButton = document.getElementById("zoomButton");
const zoomPanel = document.getElementById("zoomPanel");
const zoomRange = document.getElementById("zoomRange");
const zoomOutButton = document.getElementById("zoomOutButton");
const zoomInButton = document.getElementById("zoomInButton");
  const zoomCloseButton = document.getElementById("zoomCloseButton");
  
  const layoutToggleButton = document.getElementById("layoutToggleButton");
 
  
  
  
  
  if (layoutToggleButton) {
  layoutToggleButton.addEventListener("click", toggleOutputLayout);
}
  
  if (zoomCloseButton && zoomPanel) {
  zoomCloseButton.addEventListener("click", () => {
    zoomPanel.classList.add("hidden");
  });
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

if (zoomOutButton) {
  zoomOutButton.addEventListener("click", () => {
    changeEditorFontSize(-1);
  });
}

if (zoomInButton) {
  zoomInButton.addEventListener("click", () => {
    changeEditorFontSize(1);
  });
}

if (clearButtonCode) {
  clearButtonCode.addEventListener("click", () => {
    setOutput("");
  if (!editor) return;

  if (confirm("Effacer tout le code ?")) {
    editor.setValue("");

    const linkInput = document.getElementById("generatedLink");
    if (linkInput) {
      linkInput.value = "";
      linkInput.style.display = "none";
    }
  }
});
}
  
  autoResizeTextarea(exerciseTextEl);
  
  
  if (window.MarkdownEditor && typeof window.MarkdownEditor.init === "function") {
  window.MarkdownEditor.init();
}
  
  
  const helpBugButton = document.getElementById("helpBugButton");
  const themeButton = document.getElementById("themeButton");

  if (helpBugButton) {
    helpBugButton.disabled = false;
    helpBugButton.addEventListener("click", tentative_correction);
  }

  // Champ lien (doit exister dans le DOM)
  linkInput.style.display = "none";

  
  
 const ok =
  outputVerticalElement && outputHorizontalElement && runButton && codeEditorEl && linkInput &&
  inputPanel && inputPromptEl && inputValueEl && sendInputButton && cancelInputButton &&
  exerciseTextEl;
  

  if (!ok) {
    console.error("DOM incomplet : vérifie output/run/clear/codeEditor/inputPanel...");
    return;
  }
/*
  editor = CodeMirror.fromTextArea(codeEditorEl, {
    mode: "python",
    theme: getSavedEditorTheme(),
    lineNumbers: true,
    indentUnit: 4,
    indentWithTabs: false
  });
*/
editor = CodeMirror.fromTextArea(codeEditorEl, {
  mode: "python",
  theme: getSavedEditorTheme(),
  lineNumbers: true,
  indentUnit: 4,
  indentWithTabs: false,
  smartIndent: false,

  extraKeys: {
    Enter: function(cm) {
      const cursor = cm.getCursor();
      const lineText = cm.getLine(cursor.line) || "";

      // Partie de la ligne avant le curseur seulement
      const beforeCursor = lineText.slice(0, cursor.ch);

      // Indentation de la ligne courante
      const indentMatch = beforeCursor.match(/^\s*/);
      const indent = indentMatch ? indentMatch[0] : "";

      // Si la partie avant le curseur finit par ":" => on ajoute 4 espaces
      const needsExtraIndent = beforeCursor.trimEnd().endsWith(":");
      let extra = "";
if (needsExtraIndent) {
  const n = cm.getOption("indentUnit") || 4;
  for (let i = 0; i < n; i++) {
    extra += " ";
  }
}

      cm.replaceSelection("\n" + indent + extra, "end");
    }
  }
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
  
 
  
  window.pythonEditor = editor;
  activerGuidesIndentation(editor); 
  
  applyEditorTheme(getSavedEditorMode()); //applyEditorTheme(getSavedEditorTheme());
  initColumnResize();
  
  initBottomPageNav();
if (themeButton) {
  themeButton.addEventListener("click", toggleEditorTheme);
}

  /**
  """ Dès que le code change :
  - on efface le champ lien
  - on le cache
  """
  */
  editor.on("change", () => {
    linkInput.value = "";
    linkInput.style.display = "none";
    //if (isHorizontalOutput) {
    ajusterHauteurEditeurHorizontal();
  //}
  });
  
  exerciseTextEl.addEventListener("input", () => {
  linkInput.value = "";
  linkInput.style.display = "none";
  autoResizeTextarea(exerciseTextEl);
});
  
  
  const savedLayout =
  (window.getSavedEditorLayout && window.getSavedEditorLayout()) || "vertical";

setOutputLayout(savedLayout === "horizontal");

  runButton.disabled = true;

  runButton.addEventListener("click", runPythonCode);
  
  
 
  
  
  if (emergencyButton) {
  emergencyButton.addEventListener("click", handleEmergencyReload);
}
  sendInputButton.addEventListener("click", submitInput);
  cancelInputButton.addEventListener("click", cancelInput);

  inputValueEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitInput();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelInput();
    }
  });

  const generateLinkButton = document.getElementById("generateLinkButton");
  if (generateLinkButton) {
    generateLinkButton.addEventListener("click", generateLink);
  }

  //  Ouvrir / Enregistrer
  const openPyButton = document.getElementById("openPyButton");
  const savePyButton = document.getElementById("savePyButton");
  const openPyFile = document.getElementById("openPyFile");
  const newFileButton = document.getElementById("newFileButton");
  
  
 
  if (newFileButton) {
  newFileButton.addEventListener("click", createNewEmptyFile);
}

  if (openPyButton && openPyFile) {
  openPyButton.addEventListener("click", async () => {
    try {
      await handleOpenPythonAction();
    } catch (err) {
      console.error(err);
      ensureNewLine();
      appendOutput("ERR: " + (err?.message || String(err)) + "\n");
    } finally {
      openPyFile.value = "";
    }
  });
}

 if (savePyButton) {
  savePyButton.addEventListener("click", async () => {
    try {
      await handleSavePythonAction();
    } catch (err) {
      console.error(err);
      ensureNewLine();
      appendOutput("ERR: " + (err?.message || String(err)) + "\n");
    }
  });
}

    const params = new URLSearchParams(window.location.search);
  const codeParam = params.get("code");
  const exoParam = params.get("exo");
  const sidParam = params.get("sid");
  const commentParam = params.get("c");

  const hasLoadableUrlParam = !!(codeParam || exoParam || sidParam);

  if (!hasLoadableUrlParam) {
    if (commentParam && typeof decode_text_deflate_b64url === "function") {
      try {
        setExerciseText(decode_text_deflate_b64url(commentParam));
      } catch (e) {
        console.warn("Impossible de décoder le texte d'exercice depuis l'URL :", e);
        setExerciseText(DEFAULT_EXERCISE_TEXT);
      }
    } else {
      setExerciseText(DEFAULT_EXERCISE_TEXT);
    }
  }

  if (hasLoadableUrlParam) {
    if (window.PythonAutosave) {
      window.PythonAutosave.init(editor, { restore: false });
    }

    const decodedOk = await decode_url(window.location.href);

    if (!decodedOk) {
      loadPyodideEnvironment();
      return;
    }

    if (
      window.PythonAutosave &&
      typeof window.PythonAutosave.restorePersistentGlobalCss === "function"
    ) {
      window.PythonAutosave.restorePersistentGlobalCss();
    }

    if (window.PythonAutosave && typeof window.PythonAutosave.saveNow === "function") {
      window.PythonAutosave.saveNow();
    }

    history.replaceState({}, document.title, window.location.pathname);

    loadPyodideEnvironment();
    return;
  }
  // Pas de code dans l'URL : restauration normale
  if (window.PythonAutosave) {
    window.PythonAutosave.init(editor);
  }

  loadPyodideEnvironment();
  
 
}
/* =============================================
   """ Chargement Pyodide + patch input() async """
   ============================================= */

/**
""" Charge Pyodide et remplace input() par une version async qui appelle JS. """
*/

function createNewEmptyFile() {
  const ok = window.confirm(
    "Attention : créer un nouveau fichier va effacer le fichier actuel.\n\nVoulez-vous continuer ?"
  );

  if (!ok) return;

  if (
    window.PagesMultiples &&
    typeof window.PagesMultiples.setAllPages === "function"
  ) {
    window.PagesMultiples.setAllPages([
      {
        code: "",
        topLine: 1,
        comment: "",
        images: {}
      }
    ], 0);
  } else {
    if (editor) {
      editor.setValue("");
    }

    if (typeof window.setExerciseText === "function") {
      window.setExerciseText("");
    }
  }

  const generatedLinkEl = document.getElementById("generatedLink");
  if (generatedLinkEl) {
    generatedLinkEl.value = "";
    generatedLinkEl.style.display = "none";
  }

  if (typeof window.resetLoadedPageUi === "function") {
    window.resetLoadedPageUi();
  }

  if (window.PagesMultiples && typeof window.PagesMultiples.resetPythonNotebookMemory === "function") {
  window.PagesMultiples.resetPythonNotebookMemory();
}
  
  if (window.PythonAutosave && typeof window.PythonAutosave.saveNow === "function") {
    window.PythonAutosave.saveNow();
  }
}
/* correction bug avec autopep8*/


let autopep8ReadyPromise = null;

let autopep8Status = {
  ready: false,
  loading: false,
  errorMessage: ""
};

function getAutopep8Status() {
  return {
    ready: !!autopep8Status.ready,
    loading: !!autopep8Status.loading,
    errorMessage: String(autopep8Status.errorMessage || "")
  };
}

function getAutopep8StatusMessage() {
  if (autopep8Status.ready) {
    return "";
  }

  if (autopep8Status.loading) {
    return "Chargement de autopep8 en cours.";
  }

  if (autopep8Status.errorMessage) {
    return "Chargement de autopep8 échoué : " + autopep8Status.errorMessage;
  }

  return "autopep8 n'est pas encore chargé.";
}

window.getAutopep8Status = getAutopep8Status;
window.getAutopep8StatusMessage = getAutopep8StatusMessage;

async function ensureAutopep8Ready() {
  if (!pyWorker || !pyWorkerReady) {
    autopep8Status.ready = false;
    autopep8Status.loading = false;
    autopep8Status.errorMessage = "Worker Python non prêt";
    throw new Error("Worker Python non prêt");
  }

  if (autopep8Status.ready) {
    return true;
  }

  if (autopep8ReadyPromise) {
    return autopep8ReadyPromise;
  }

  autopep8Status.loading = true;
  autopep8Status.errorMessage = "";

  autopep8ReadyPromise = new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const data = event.data || {};

      if (data.type === "autopep8_ready") {
        pyWorker.removeEventListener("message", onMessage);
        autopep8Status.ready = true;
        autopep8Status.loading = false;
        autopep8Status.errorMessage = "";
        autopep8ReadyPromise = null;
        resolve(true);
        return;
      }

      if (data.type === "error") {
        pyWorker.removeEventListener("message", onMessage);
        autopep8Status.ready = false;
        autopep8Status.loading = false;
        autopep8Status.errorMessage = String(data.message || "Erreur worker");
        autopep8ReadyPromise = null;
        reject(new Error(autopep8Status.errorMessage));
      }
    };

    pyWorker.addEventListener("message", onMessage);
    pyWorker.postMessage({ type: "ensure_autopep8" });
  });

  return autopep8ReadyPromise;
}

window.ensureAutopep8Ready = ensureAutopep8Ready;

/*fin de  correction bug avec autopep8*/
async function loadPyodideEnvironment() {
  try {
    setOutput("Chargement de l'interpréteur Python...");

    await initPyodideWorker();

    runButton.disabled = false;
    setOutput("L'interpréteur Python (worker) est prêt. Cliquez sur Exécuter.\n");

    const savedLayout =
      (window.getSavedEditorLayout && window.getSavedEditorLayout()) || "vertical";

    if (typeof setOutputLayout === "function") {
      setOutputLayout(savedLayout === "horizontal");
    }
  } catch (err) {
    console.error(err);
    setOutput("Erreur worker/Pyodide: " + (err?.toString?.() ?? String(err)));
  }
}

async function installPillowShowPatch() {
  if (!pyodideInstance) return;

  await pyodideInstance.runPythonAsync(`
import base64
import io

def _install_pillow_show_patch():
    try:
        from PIL import Image
    except Exception:
        return

    def _dariush_show(self, *args, **kwargs):
        buffer = io.BytesIO()
        self.save(buffer, format="PNG")
        data = base64.b64encode(buffer.getvalue()).decode("ascii")
        js_show_image_base64(data)

    Image.Image.show = _dariush_show

_install_pillow_show_patch()
`);
}

/* =========================================================
   """ Extraction des lignes : from ... import * """
   ========================================================= */




/* ===================================
   """ Exécution du code utilisateur """
   =================================== */

/**
""" Exécute le code Python en capturant stdout/stderr dans Python :
- stdout : affiché normalement
- stderr : chaque ligne préfixée par "ERR: "
- "--- Exécution ---" démarre sur une ligne propre

Compatibilité ajoutée :
- les lignes `from ... import *` sont sorties du code async
  puis exécutées au niveau global, car Python interdit
  `import *` à l'intérieur d'une fonction.
"""
*/



async function handleEmergencyReload() {
  const ok = window.confirm(
    "Urgence : le programme en cours va être interrompu.\n\n" +
    "L'interpréteur Python va être redémarré sans recharger la page.\n\n" +
    "Voulez-vous continuer ?"
  );

  if (!ok) return;

  try {
    if (window.PagesMultiples?.saveActivePageFromEditor) {
      window.PagesMultiples.saveActivePageFromEditor();
    }
  } catch (err) {
    console.warn("Impossible de sauvegarder la page active avant redémarrage :", err);
  }

  try {
    if (window.PythonAutosave?.saveNow) {
      window.PythonAutosave.saveNow();
    }
  } catch (err) {
    console.warn("Impossible d'écrire la sauvegarde d'urgence :", err);
  }

  try {
    await restartPyodideWorker();
  } catch (err) {
    console.error("Erreur pendant le redémarrage d'urgence du worker :", err);
    setOutput("ERR: impossible de redémarrer l'interpréteur Python.\n");
  }
}

async function runPythonCode() {

  if (window.isDebugMode) {
  appendOutput("ERR: impossible d'exécuter pendant un débogage.\n");
  return;
}

  if (!pyWorker || !pyWorkerReady || !editor) return;

  console.log("[main] clic Exécuter");
  setOutput("");



  if (typeof window.resetPythonImageGallery === "function") {
    window.resetPythonImageGallery();
  }

if (typeof window.AffichageHTML !== "undefined" && window.AffichageHTML.reset) {
    window.AffichageHTML.reset();
  }

  if (window.PythonAutosave) {
    window.PythonAutosave.notifyExecutionStart();
  }

  pendingInputResolve = null;
  pendingInputReject = null;
  hideInput();

  runButton.disabled = true;

  setOutput("--- Exécution ---\n");

  try {
    // Caractères invisibles collés par mégarde (espaces insécables...) :
    // corrigés dans l'éditeur dès la 1re exécution, sans message.
    const userCode = nettoyerEditeurAvantExecution(editor);

    const transformedCode = addAwaitToInputCalls(userCode);

    // Code des pages précédentes (séparées par un marqueur), envoyé au worker
    // UNIQUEMENT comme filet de sécurité : il ne sert que si la page active
    // plante sur une dépendance manquante (NameError). Sinon il est ignoré.
   let contextCode = "";
    runContextHadInputPages = false;
    pendingRunExpired = false;
    lastRunContextHash = null;

    if (
      window.PagesMultiples?.getAllPages &&
      window.PagesMultiples?.getActivePageIndex
    ) {
      if (window.PagesMultiples.saveActivePageFromEditor) {
        window.PagesMultiples.saveActivePageFromEditor();
      }
      const allPages = window.PagesMultiples.getAllPages() || [];
      const activeIndex = window.PagesMultiples.getActivePageIndex() ?? 0;

      const previousPages = allPages.slice(0, activeIndex);

      // Hash du code des pages precedentes : identifie ce "contexte". S'il a
      // deja expire (page precedente trop lente lors d'un essai anterieur), on
      // ne retente PAS le rejeu (donc plus d'attente de 5 s ni de kill).
      const rawPrev = previousPages
        .map(page => String(page.code || ""))
        .join("\n###__DARIUSH_PAGE_SEP__###\n");

      lastRunContextHash = window.PagesMultiples.hashContext
        ? window.PagesMultiples.hashContext(rawPrev)
        : null;

      pendingRunExpired = !!(
        lastRunContextHash &&
        window.PagesMultiples.isContextExpired &&
        window.PagesMultiples.isContextExpired(lastRunContextHash)
      );

      if (pendingRunExpired) {
        // Contexte connu comme trop lent : on n'envoie rien. La page active
        // s'executera sans contexte ; si elle a une dependance manquante, le
        // message sera affiche (voir handler "error").
        contextCode = "";
      } else {
        // Contexte normal : on vide les pages a input() (jamais rejouees), on
        // garde les autres. Leurs caracteres invisibles sont retires a la
        // volee, sans modifier les pages elles-memes.
        contextCode = previousPages
          .map(page => {
            const c = nettoyerCaracteresInvisibles(String(page.code || ""));
            if (typeof codeContainsInputForRun === "function" && codeContainsInputForRun(c)) {
              runContextHadInputPages = true;
              return "";
            }
            return addAwaitToInputCalls(c);
          })
          .join("\n###__DARIUSH_PAGE_SEP__###\n");
      }
    }
    

console.log("[main] envoi au worker :", transformedCode);

pyWorker.postMessage({
  type: "run",
  code: transformedCode,
  contextCode: contextCode
});
  } catch (err) {
    ensureNewLine();
    appendOutput("ERR: " + (err && err.toString ? err.toString() : String(err)) + "\n");
    runButton.disabled = false;

    if (window.PythonAutosave) {
      window.PythonAutosave.notifyExecutionEnd();
    }
  }
}

async function installMatplotlibShowPatch() {
  if (!pyodideInstance) return;

  await pyodideInstance.runPythonAsync(`
import io
import base64

def _install_matplotlib_show_patch():
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:
        return
    def _dariush_matplotlib_show(*args, **kwargs):
        figure_numbers = plt.get_fignums()
        
        for num in figure_numbers:
            fig = plt.figure(num)
            buffer = io.BytesIO()
            fig.savefig(buffer, format="PNG", bbox_inches="tight")
            data = base64.b64encode(buffer.getvalue()).decode("ascii")
            js_show_image_base64(data)

        plt.close("all")
    

    plt.show = _dariush_matplotlib_show

_install_matplotlib_show_patch()
`);
}

function resetLoadedPageUi() {
  // vide la fenêtre d'exécution
  setOutput("");

  // remet le panneau commentaires/aperçu visible
  const commentsWrap = document.getElementById("fenetrescommentaires");
  if (commentsWrap) {
    commentsWrap.style.display = "inline";
  }

  // remet le bouton du bandeau sur "-"
  const toggleBtn = document.getElementById("previewToggleBtn");
  if (toggleBtn) {
    toggleBtn.textContent = "—";
    toggleBtn.title = "Masquer l’aperçu";
  }

  // force l'affichage de l'aperçu par défaut
  const textarea = document.getElementById("exerciseText");
  const preview = document.getElementById("exercisePreview");

  if (textarea && preview) {
    textarea.classList.add("hidden");
    preview.classList.remove("hidden");
  }

  // rafraîchit le rendu markdown si le module est chargé
  if (window.MarkdownEditor && typeof window.MarkdownEditor.refreshPreview === "function") {
    window.MarkdownEditor.refreshPreview();
  }

  // au cas où un input Python était ouvert
  if (typeof hideInput === "function") {
    hideInput();
  }
}

window.resetLoadedPageUi = resetLoadedPageUi;

window.DEFAULT_EXERCISE_TEXT = DEFAULT_EXERCISE_TEXT;
window.getExerciseText = getExerciseText;
window.setExerciseText = setExerciseText;
window.normalizeExerciseText = normalizeExerciseText;

window.installPillowShowPatch = installPillowShowPatch;
window.installMatplotlibShowPatch = installMatplotlibShowPatch;


/*fonction pour les fleches suiv et prev*/
function getPageCountsFromIndicator() {
  const indicator = document.getElementById("pagesMultiplesIndicator");
  if (!indicator) {
    return { current: 1, total: 1 };
  }

  const text = (indicator.textContent || "").trim();
  const match = text.match(/^(\d+)\s*\/\s*(\d+)$/);

  if (!match) {
    return { current: 1, total: 1 };
  }

  return {
    current: parseInt(match[1], 10) || 1,
    total: parseInt(match[2], 10) || 1
  };
}

function isBottomNavBlockedByOpenPanel() {
  const iaPanel = document.getElementById("iaPanel");
  const connexionPanel = document.getElementById("connexion");

  const iaOpen = !!(iaPanel && iaPanel.classList.contains("ia-open"));
  const connexionOpen = !!(connexionPanel && connexionPanel.classList.contains("group-open"));

  return iaOpen || connexionOpen;
}

function updateBottomPageNav() {
  const nav = document.getElementById("bottomPageNav");
  const navIndicator = document.getElementById("bottomPageNavIndicator");
  const prevBtn = document.getElementById("bottomPrevPageButton");
  const nextBtn = document.getElementById("bottomNextPageButton");
  const mainSplit = document.getElementById("mainSplit");

  if (!nav || !navIndicator || !prevBtn || !nextBtn || !mainSplit) return;

  // En mode groupe élève : navigation contrôlée par connexion.js
  if (window.__groupNavLocked) {
    // Lire PagesMultiples directement plutôt que getPageCountsFromIndicator
    // qui dépend du span pagesMultiplesIndicator caché en mode groupe
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

  const counts = getPageCountsFromIndicator();
  const hasSeveralPages = counts.total > 1;
  const blocked = isBottomNavBlockedByOpenPanel();

  navIndicator.textContent = counts.current + "/" + counts.total;

  if (!hasSeveralPages || blocked) {
    nav.classList.add("hidden");
    return;
  }

  nav.classList.remove("hidden");
  prevBtn.disabled = counts.current <= 1;
  nextBtn.disabled = counts.current >= counts.total;
}

function initBottomPageNav() {
  const bottomPrev = document.getElementById("bottomPrevPageButton");
  const bottomNext = document.getElementById("bottomNextPageButton");
  const topPrev = document.getElementById("pagesPrevButton");
  const topNext = document.getElementById("pagesNextButton");
  const indicator = document.getElementById("pagesMultiplesIndicator");
  const iaPanel = document.getElementById("iaPanel");
  const connexionPanel = document.getElementById("connexion");
  const openIaPanelBtn = document.getElementById("openIaPanel");
  const closeIaPanelBtn = document.getElementById("closeIaPanel");
  const openConnexionBtn = document.getElementById("boutonmenuconnexion");
  const closeConnexionBtn = document.getElementById("closeConnexionPanel");

  if (bottomPrev && topPrev) {
    bottomPrev.addEventListener("click", () => {
      topPrev.click();
    });
  }

  if (bottomNext && topNext) {
    bottomNext.addEventListener("click", () => {
      topNext.click();
    });
  }

  if (indicator) {
    const observer = new MutationObserver(() => {
      updateBottomPageNav();
    });

    observer.observe(indicator, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  if (iaPanel) {
    const iaObserver = new MutationObserver(() => {
      updateBottomPageNav();
    });

    iaObserver.observe(iaPanel, {
      attributes: true,
      attributeFilter: ["class"]
    });
  }

  if (connexionPanel) {
    const connexionObserver = new MutationObserver(() => {
      updateBottomPageNav();
    });

    connexionObserver.observe(connexionPanel, {
      attributes: true,
      attributeFilter: ["class"]
    });
  }

  if (openIaPanelBtn) {
    openIaPanelBtn.addEventListener("click", () => {
      requestAnimationFrame(updateBottomPageNav);
    });
  }

  if (closeIaPanelBtn) {
    closeIaPanelBtn.addEventListener("click", () => {
      requestAnimationFrame(updateBottomPageNav);
    });
  }

  if (openConnexionBtn) {
    openConnexionBtn.addEventListener("click", () => {
      requestAnimationFrame(updateBottomPageNav);
    });
  }

  if (closeConnexionBtn) {
    closeConnexionBtn.addEventListener("click", () => {
      requestAnimationFrame(updateBottomPageNav);
    });
  }

  window.addEventListener("resize", updateBottomPageNav);
  updateBottomPageNav();
}
document.addEventListener("DOMContentLoaded", initPythonEditor);

