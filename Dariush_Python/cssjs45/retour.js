/***************************************************************
retour.js
Gestion indépendante de l'historique undo/redo pour CodeMirror
avance et recule dans le code
***************************************************************/

(function () {
  "use strict";

  const MAX_HISTORY = 20;
  const DEBOUNCE_DELAY = 500;

  let historyStack = [];
  let historyIndex = -1;
  let historyTimer = null;
  let suspendHistory = false;

  let initialized = false;
  let undoButton = null;
  let redoButton = null;

  function getEditor() {
    return window.pythonEditor || window.editor || null;
  }

  function getCurrentCode() {
    const cm = getEditor();
    return cm ? cm.getValue() : "";
  }

  function updateButtons() {
    if (!undoButton) undoButton = document.getElementById("undoButton");
    if (!redoButton) redoButton = document.getElementById("redoButton");

    const canUndo = historyIndex > 0;
    const canRedo = historyIndex >= 0 && historyIndex < historyStack.length - 1;

    if (undoButton) undoButton.disabled = !canUndo;
    if (redoButton) redoButton.disabled = !canRedo;
  }

  function pushHistoryState(code, force = false) {
    if (suspendHistory) return;
    if (typeof code !== "string") return;

    // Ne rien faire si identique à l'état courant
    if (!force && historyIndex >= 0 && historyStack[historyIndex] === code) {
      updateButtons();
      return;
    }

    // Si on était revenu en arrière, on coupe tout ce qui est "devant"
    if (historyIndex < historyStack.length - 1) {
      historyStack = historyStack.slice(0, historyIndex + 1);
    }

    historyStack.push(code);

    // Limite mémoire
    if (historyStack.length > MAX_HISTORY) {
      const excess = historyStack.length - MAX_HISTORY;
      historyStack.splice(0, excess);
    }

    historyIndex = historyStack.length - 1;
    updateButtons();
  }

  function scheduleHistorySave() {
    if (suspendHistory) return;

    clearTimeout(historyTimer);
    historyTimer = setTimeout(() => {
      pushHistoryState(getCurrentCode());
    }, DEBOUNCE_DELAY);
  }

  function saveHistoryNow(force = false) {
    clearTimeout(historyTimer);
    pushHistoryState(getCurrentCode(), force);
  }

  function restoreState(targetIndex) {
    const cm = getEditor();
    if (!cm) return;

    if (targetIndex < 0 || targetIndex >= historyStack.length) return;

    suspendHistory = true;
    historyIndex = targetIndex;

    const oldScroll = cm.getScrollInfo();
    const oldCursor = cm.getCursor();

    cm.setValue(historyStack[historyIndex]);

    // On essaye de garder un comportement agréable
    try {
      cm.setCursor(oldCursor);
    } catch (_) {
      // si la position n'existe plus, on ignore
    }

    cm.scrollTo(oldScroll.left, oldScroll.top);
    cm.focus();

    suspendHistory = false;
    updateButtons();
  }

  function undoEditor() {
    clearTimeout(historyTimer);

    if (historyIndex > 0) {
      restoreState(historyIndex - 1);
    } else {
      updateButtons();
    }
  }

  function redoEditor() {
    clearTimeout(historyTimer);

    if (historyIndex < historyStack.length - 1) {
      restoreState(historyIndex + 1);
    } else {
      updateButtons();
    }
  }

  function bindButtons() {
    undoButton = document.getElementById("undoButton");
    redoButton = document.getElementById("redoButton");

    if (undoButton && !undoButton.dataset.historyBound) {
      undoButton.dataset.historyBound = "1";
      undoButton.addEventListener("click", undoEditor);
      undoButton.title = undoButton.title || "Retour en arrière";
    }

    if (redoButton && !redoButton.dataset.historyBound) {
      redoButton.dataset.historyBound = "1";
      redoButton.addEventListener("click", redoEditor);
      redoButton.title = redoButton.title || "Retour en avant";
    }

    updateButtons();
  }

  function installOnEditor() {
    const cm = getEditor();
    if (!cm || initialized) return false;

    initialized = true;

    // État initial
    pushHistoryState(cm.getValue(), true);

    // Historique sur modification utilisateur ou setValue externe
    cm.on("change", () => {
      if (suspendHistory) return;
      scheduleHistorySave();
    });

    bindButtons();
    updateButtons();
    return true;
  }

  function waitForEditorAndInit() {
    bindButtons();

    if (installOnEditor()) return;

    const maxAttempts = 200; // ~20 s si intervalle 100 ms
    let attempts = 0;

    const interval = setInterval(() => {
      attempts += 1;
      bindButtons();

      if (installOnEditor() || attempts >= maxAttempts) {
        clearInterval(interval);
        updateButtons();
      }
    }, 100);
  }

  // Fonctions globales utiles si un autre module veut s'en servir plus tard
window.undoEditor = undoEditor;
  window.redoEditor = redoEditor;
  window.saveEditorHistoryNow = saveHistoryNow;
  window.updateHistoryButtons = updateButtons;
  window.clearEditorHistory = function () {
    clearTimeout(historyTimer);
    historyStack = [];
    historyIndex = -1;
    suspendHistory = false;
    const cm = getEditor();
    if (cm) pushHistoryState(cm.getValue(), true);
    updateButtons();
  };

  document.addEventListener("DOMContentLoaded", waitForEditorAndInit);
})();