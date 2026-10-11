/***************************************************************
SAUVEGARDE AUTOMATIQUE DARIUSH PYTHON
- sauvegarde après 10 s d'inactivité
- sauvegarde au lancement d'une exécution
- sauvegarde à la fermeture / rechargement / page cachée
- restaure :
    * pages multiples
    * code de chaque page
    * commentaire de chaque page
    * page active

***************************************************************/
(function () {
  const STORAGE_KEY = "dariush_python_autosave_v2";
  const LEGACY_STORAGE_KEY = "dariush_python_autosave_v1";
  const GLOBAL_CSS_STORAGE_KEY = "dariush_notebook_global_css_v1";
  const IDLE_DELAY_MS = 10000;

  let editorInstance = null;
  let stateDirty = false;
  let lastChangeTime = 0;
  let isRunning = false;
  let intervalId = null;
  let lifecycleAttached = false;

  function markDirty() {
    stateDirty = true;
    lastChangeTime = Date.now();
  }

  function getCurrentGlobalCss() {
    try {
      if (
        window.MarkdownEditor &&
        typeof window.MarkdownEditor.getNotebookGlobalCss === "function"
      ) {
        return window.MarkdownEditor.getNotebookGlobalCss() || "";
      }
    } catch (err) {
      console.warn("Erreur lecture CSS global :", err);
    }
    return "";
  }

  function savePersistentGlobalCss(css) {
    try {
      localStorage.setItem(GLOBAL_CSS_STORAGE_KEY, css || "");
    } catch (err) {
      console.warn("Erreur sauvegarde CSS global :", err);
    }
  }

  function readPersistentGlobalCss() {
    try {
      return localStorage.getItem(GLOBAL_CSS_STORAGE_KEY) || "";
    } catch (err) {
      console.warn("Erreur lecture CSS global :", err);
      return "";
    }
  }

  function applyPersistentGlobalCss() {
    let saved;
    try {
      const raw = localStorage.getItem(GLOBAL_CSS_STORAGE_KEY);
      saved = (raw !== null && raw.trim() !== "") ? raw : null;
    } catch (err) {
      saved = null;
    }

    function apply(css) {
      if (window.MarkdownEditor?.setNotebookGlobalCss) {
        window.MarkdownEditor.setNotebookGlobalCss(css);
        window.MarkdownEditor.syncCssTextarea?.();
        window.MarkdownEditor.refreshPreview?.();
      }
    }

    function waitAndApply(css) {
      if (window.MarkdownEditor?.setNotebookGlobalCss) {
        apply(css);
      } else {
        let tries = 0;
        const timer = setInterval(() => {
          tries++;
          if (window.MarkdownEditor?.setNotebookGlobalCss) {
            clearInterval(timer);
            apply(css);
          }
          if (tries > 200) clearInterval(timer);
        }, 50);
      }
    }

    if (saved !== null) {
      waitAndApply(saved);
    } else {
      // Rien en mémoire ou vide → lire le textarea HTML comme CSS par défaut
      const doApply = () => {
        const textarea = document.getElementById("cssTextarea");
        if (textarea) waitAndApply(textarea.value.trim());
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", doApply);
      } else {
        doApply();
      }
    }
  }

  function getFallbackSinglePageState() {
    let code = "";
    if (editorInstance && editorInstance.getValue) {
      code = editorInstance.getValue();
    }

    return {
      version: 2,
      activeIndex: 0,
      globalCss: getCurrentGlobalCss(),
      pages: [
        {
          code,
          topLine: 1,
          comment: window.DEFAULT_EXERCISE_TEXT || "Ecrire votre code en python"
        }
      ]
    };
  }

  function getFullState() {
    try {
      if (
        window.PagesMultiples &&
        typeof window.PagesMultiples.getAllPages === "function"
      ) {
        return {
          version: 2,
          activeIndex:
            window.PagesMultiples.getActivePageIndex?.() || 0,
          globalCss: getCurrentGlobalCss(),
          exerciceCourant: window.__exerciceCourant || null,
          pages: window.PagesMultiples.getAllPages()
        };
      }
    } catch (err) {
      console.warn("Erreur lecture pages :", err);
    }

    return getFallbackSinglePageState();
  }

  function writeSave() {
    try {
      const state = getFullState();

      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      // Ne pas écraser le CSS persistant avec une chaîne vide
      if (state.globalCss && state.globalCss.trim()) {
        savePersistentGlobalCss(state.globalCss);
      }

      stateDirty = false;
      return true;
    } catch (err) {
      console.warn("Erreur sauvegarde :", err);
      return false;
    }
  }

  function readSaveRaw() {
    try {
      const v2 = localStorage.getItem(STORAGE_KEY);
      if (v2 !== null) return { type: "v2", value: v2 };

      const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacy !== null) return { type: "legacy", value: legacy };
    } catch (err) {
      console.warn("Erreur lecture sauvegarde :", err);
    }

    return null;
  }

  function restoreFromStructuredSave(raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return false;
    }

    if (!data || !Array.isArray(data.pages)) return false;

    // Restaure l'identité de l'exercice (pour que l'agent Aide retrouve son
    // corrigé même après rechargement, y compris si l'URL a été nettoyée).
    if (data.exerciceCourant && data.exerciceCourant.lien_court) {
      window.__exerciceCourant = data.exerciceCourant;
    }

    if (window.PagesMultiples?.setAllPages) {
      window.PagesMultiples.setAllPages(data.pages, data.activeIndex || 0);
    } else if (editorInstance) {
      editorInstance.setValue(data.pages[0].code || "");
    }

    if (data.globalCss && data.globalCss !== "") {
      // CSS sauvegardé → on l'applique
      if (window.MarkdownEditor?.setNotebookGlobalCss) {
        window.MarkdownEditor.setNotebookGlobalCss(data.globalCss);
        savePersistentGlobalCss(data.globalCss);
        window.MarkdownEditor.syncCssTextarea?.();
        window.MarkdownEditor.refreshPreview?.();
      }
    } else {
      // Pas de CSS sauvegardé → appliquer le défaut (textarea HTML)
      applyPersistentGlobalCss();
    }

    stateDirty = false;
    lastChangeTime = Date.now();
    return true;
  }

  function restoreFromLegacySave(raw) {
    if (!editorInstance) return false;

    editorInstance.setValue(raw);
    applyPersistentGlobalCss();

    stateDirty = false;
    lastChangeTime = Date.now();
    return true;
  }

  function restore() {
    const saved = readSaveRaw();
    if (!saved) {
      // Rien du tout en localStorage → appliquer le CSS par défaut
      applyPersistentGlobalCss();
      return false;
    }

    if (saved.type === "v2") {
      return restoreFromStructuredSave(saved.value);
    }

    if (saved.type === "legacy") {
      return restoreFromLegacySave(saved.value);
    }

    return false;
  }

  function saveIfIdleAndAllowed() {
    if (!editorInstance || !stateDirty || isRunning) return;

    if (Date.now() - lastChangeTime >= IDLE_DELAY_MS) {
      writeSave();
    }
  }

  function forceSaveIfNeeded() {
    if (!editorInstance || !stateDirty) return false;
    return writeSave();
  }

  function attachLifecycleEvents() {
    if (lifecycleAttached) return;
    lifecycleAttached = true;

    window.addEventListener("beforeunload", forceSaveIfNeeded);
    window.addEventListener("pagehide", forceSaveIfNeeded);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        forceSaveIfNeeded();
      }
    });
  }

  function hookExerciseTextChanges() {
    const textarea = document.getElementById("exerciseText");
    if (!textarea || textarea.__autosaveHooked) return;

    textarea.addEventListener("input", markDirty);
    textarea.__autosaveHooked = true;
  }

  function init(editor, options = {}) {
    if (!editor) return false;

    editorInstance = editor;

    if (editor.on && !editor.__autosaveHooked) {
      editor.on("change", markDirty);
      editor.__autosaveHooked = true;
    }

    hookExerciseTextChanges();

    if (options.restore !== false) {
      restore();
    }

    if (!intervalId) {
      intervalId = setInterval(saveIfIdleAndAllowed, 1000);
    }

    attachLifecycleEvents();
    return true;
  }

  function notifyExecutionStart() {
    isRunning = true;
    if (stateDirty) writeSave();
  }

  function notifyExecutionEnd() {
    isRunning = false;
  }

  function saveNow() {
    return writeSave();
  }

  window.PythonAutosave = {
    init,
    notifyExecutionStart,
    notifyExecutionEnd,
    saveNow,
    restorePersistentGlobalCss: applyPersistentGlobalCss
  };
})();