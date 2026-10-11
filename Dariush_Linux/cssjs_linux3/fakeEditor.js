/*
fakeEditor.js — Dariush Linux

Crée un éditeur fantôme qui simule l'API CodeMirror minimale pour que
pagesmultiples.js, outils.js et sauvegarde.js fonctionnent sans modification
dans Dariush Linux où il n'y a pas de vrai éditeur de code.

Initialise aussi MarkdownEditor (qui dans Python est initialisé par interpreteur.js).
*/

(function () {
  "use strict";

  const FIXED_CODE = "Le terminal du notebook";
  let currentValue = FIXED_CODE;

  const fakeEditor = {
    getValue: function () { return currentValue; },
    setValue: function (val) { currentValue = String(val ?? ""); },
    on: function () {},
    off: function () {},
    refresh: function () {},
    focus: function () {},
    setOption: function () {},
    getOption: function () { return null; },
    getScrollInfo: function () { return { top: 0, left: 0, height: 0, width: 0, clientHeight: 0, clientWidth: 0 }; },
    lineAtHeight: function () { return 0; },
    heightAtLine: function () { return 0; },
    scrollTo: function () {},
    setCursor: function () {},
    lastLine: function () { return 0; },
    getWrapperElement: function () { return null; }
  };

  window.editor = fakeEditor;
  window.pythonEditor = fakeEditor;
})();

