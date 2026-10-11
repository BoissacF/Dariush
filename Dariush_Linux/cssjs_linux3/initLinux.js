/*
initLinux.js — Dariush Linux
*/
(function () {
  "use strict";


  /* Petit dialogue de choix autonome (Annuler + N options).
     Couleurs de texte forcées (!important) pour rester lisibles
     malgré le CSS global de l'application. */
  function chooseLinuxSaveAction(title, options) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;background:rgba(0,0,0,0.45);" +
        "display:flex;align-items:center;justify-content:center;z-index:99999;";

      const box = document.createElement("div");
      box.style.cssText =
        "background:#ffffff;border-radius:10px;padding:20px;" +
        "max-width:440px;width:90%;box-shadow:0 10px 40px rgba(0,0,0,0.3);" +
        "font-family:system-ui,sans-serif;";

      const h = document.createElement("p");
      h.textContent = title;
      h.style.cssText = "margin:0 0 14px;font-weight:600;font-size:15px;color:#111 !important;";
      box.appendChild(h);
      if (window.DariushDrive) window.DariushDrive.attachCheckbox(h);

      function finish(value) {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(value);
      }

      (options || []).forEach((opt) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = opt.label;
        btn.style.cssText =
          "display:block;width:100%;text-align:left;margin:6px 0;padding:10px 12px;" +
          "border:1px solid #ccc !important;border-radius:8px;" +
          "background:#f2f2f2 !important;color:#111 !important;" +
          "font-size:14px;font-weight:500;cursor:pointer;opacity:1 !important;";
        btn.addEventListener("mouseenter", () => { btn.style.background = "#e4e4e4"; });
        btn.addEventListener("mouseleave", () => { btn.style.background = "#f2f2f2"; });
        btn.addEventListener("click", () => finish(opt.value));
        box.appendChild(btn);
      });

      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Annuler";
      cancel.style.cssText =
        "display:block;width:100%;margin:12px 0 0;padding:9px 12px;" +
        "border:none !important;border-radius:8px;" +
        "background:#d8d8d8 !important;color:#111 !important;" +
        "font-size:14px;font-weight:500;cursor:pointer;opacity:1 !important;";
      cancel.addEventListener("mouseenter", () => { cancel.style.background = "#cacaca"; });
      cancel.addEventListener("mouseleave", () => { cancel.style.background = "#d8d8d8"; });
      cancel.addEventListener("click", () => finish(null));
      box.appendChild(cancel);

      // Clic en dehors = Annuler
      overlay.addEventListener("click", (e) => { if (e.target === overlay) finish(null); });

      overlay.appendChild(box);
      document.body.appendChild(overlay);
    });
  }


  function createNewEmptyFile() {
    const ok = window.confirm(
      "Attention : créer un nouveau fichier va effacer le fichier actuel.\n\nVoulez-vous continuer ?"
    );
    if (!ok) return;

    if (window.PagesMultiples && typeof window.PagesMultiples.setAllPages === "function") {
      window.PagesMultiples.setAllPages([
        { code: "", topLine: 1, comment: "", images: {} }
      ], 0);
    }

    const generatedLinkEl = document.getElementById("generatedLink");
    if (generatedLinkEl) {
      generatedLinkEl.value = "";
      generatedLinkEl.style.display = "none";
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    // 1) Init MarkdownEditor
    if (window.MarkdownEditor && typeof window.MarkdownEditor.init === "function") {
      window.MarkdownEditor.init();
    }

    // 1bis) Init PythonAutosave (sauvegarde automatique dans localStorage)
    // Réutilise tout le mécanisme de Dariush_Python : pages, CSS, index actif
    // Les changements de code ne sont pas détectés (pas d'éditeur Python en Linux),
    // mais on s'en fiche : le code est toujours "Le terminal du notebook" en Linux.
    if (window.PythonAutosave && typeof window.PythonAutosave.init === "function" && window.pythonEditor) {
      window.PythonAutosave.init(window.pythonEditor);

      // Hook : sauvegarder lors d'un changement de page ou de CSS
      // (en Python ces hooks sont posés par interpreteur.js / gestionMenu.js)
      const cssTextareaEl = document.getElementById("cssTextarea");
      if (cssTextareaEl) {
        cssTextareaEl.addEventListener("input", () => {
          if (window.PythonAutosave && typeof window.PythonAutosave.saveNow === "function") {
            window.PythonAutosave.saveNow();
          }
        });
      }

      // Hook sur les boutons de pagination pour sauvegarder à chaque changement
      ["pagesPrevButton", "pagesNextButton", "pagesAddButton", "pagesRemoveButton"].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
          btn.addEventListener("click", () => {
            // Utiliser un setTimeout pour laisser PagesMultiples appliquer le changement avant de sauver
            setTimeout(() => {
              if (window.PythonAutosave && typeof window.PythonAutosave.saveNow === "function") {
                window.PythonAutosave.saveNow();
              }
            }, 50);
          });
        }
      });
    }

    // 2) Définir window.setExerciseText (appelé par pagesmultiples.js)
    if (typeof window.setExerciseText !== "function") {
      window.setExerciseText = function (text) {
        const el = document.getElementById("exerciseText");
        if (!el) return;
        el.value = String(text ?? "").replace(/\r\n/g, "\n");
        if (window.MarkdownEditor && typeof window.MarkdownEditor.refreshPreview === "function") {
          window.MarkdownEditor.refreshPreview();
        }
      };
    }

    // 3) Câblage des 4 boutons
    const newFileButton      = document.getElementById("newFileButton");
    const openPyButton       = document.getElementById("openPyButton");
    const savePyButton       = document.getElementById("savePyButton");
    const openPyFile         = document.getElementById("openPyFile");
    const generateLinkButton = document.getElementById("generateLinkButton");

    if (newFileButton) {
      newFileButton.addEventListener("click", createNewEmptyFile);
    }

   if (openPyButton && openPyFile) {
      openPyButton.addEventListener("click", async () => {
        // Panneau à 2 choix (même esprit que le menu Ouvrir de Dariush Python)
        const action = await chooseLinuxSaveAction("Que voulez-vous ouvrir ?", [
          { value: "open_dli", label: "1 : Ouvrir un fichier Dariush Linux (.dli)" },
          { value: "import_pdf", label: "2 : Importer un PDF pour le transformer en notebook" }
        ]);

        if (!action) return; // Annuler

        if (action === "import_pdf") {
          if (window.ImporterPdf && typeof window.ImporterPdf.open === "function") {
            await window.ImporterPdf.open();
          } else {
            alert("Le module d'import PDF (importer_pdf.js) n'est pas chargé.");
          }
          return;
        }

        if (action === "open_dli") {
          const ouvrirDli = async (file) => {
            try {
              if (!file) return;
              const raw = (await file.text()).trim();
              if (!raw) return;

              if (typeof decode_url !== "function") {
                throw new Error("Fonction decode_url introuvable.");
              }
              const fakeUrl = "https://physalgo.fr/Dariush_Linux/index.html?" + raw;
              const ok = await decode_url(fakeUrl);
              if (!ok) {
                throw new Error("Impossible d'ouvrir le fichier Dariush Linux.");
              }
            } catch (err) {
              console.error("[initLinux] Erreur ouverture .dli :", err);
              alert("Erreur lors de l'ouverture : " + (err?.message || String(err)));
            }
          };

          // Case "Google Drive" cochée : le fichier vient du Drive
          if (window.DariushDrive && window.DariushDrive.isEnabled()) {
            await ouvrirDli(await window.DariushDrive.pickFile(".dli"));
            return;
          }

          // Ouverture directe d'un fichier .dli
          const input = document.createElement("input");
          input.type = "file";
          input.accept = ".dli";
          input.style.display = "none";
          input.addEventListener("change", () => {
            ouvrirDli(input.files && input.files[0]);
          }, { once: true });
          document.body.appendChild(input);
          input.click();
          setTimeout(() => input.remove(), 1000);
        }
      });
    }

    if (savePyButton) {
      savePyButton.addEventListener("click", async () => {
        const action = await chooseLinuxSaveAction("Que voulez-vous faire ?", [
          { value: "save_pdf", label: "1 : Exporter en PDF (textes / markdowns)" },
          { value: "save_dli", label: "2 : Enregistrer un fichier Dariush Linux (.dli)" }
        ]);

        if (!action) return; // Annuler

        if (action === "save_pdf") {
          if (typeof exportNotebookToPrintPdf === "function") {
            exportNotebookToPrintPdf({ includeCode: false });
          } else {
            alert("Fonction d'export PDF indisponible.");
          }
          return;
        }

        if (action === "save_dli") {
          try {
            if (typeof buildDariushRawPayload !== "function") {
              throw new Error("Fonction buildDariushRawPayload introuvable.");
            }
            const rawPayload = buildDariushRawPayload();
            if (!rawPayload) return;

            if (typeof saveTextFileAs === "function") {
              await saveTextFileAs(rawPayload, {
                defaultName: "activite.dli",
                extension: ".dli",
                mimeType: "text/plain;charset=utf-8",
                promptLabel: "Nom du fichier Dariush Linux :",
                description: "Fichier Dariush Linux"
              });
            } else {
              const finalName = "activite.dli";
              const blob = new Blob([rawPayload], { type: "text/plain;charset=utf-8" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = finalName;
              document.body.appendChild(a);
              a.click();
              setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
            }
          } catch (err) {
            console.error("[initLinux] Erreur sauvegarde .dli :", err);
            alert("Erreur lors de la sauvegarde : " + (err?.message || String(err)));
          }
        }
      });
    }

    if (generateLinkButton) {
      generateLinkButton.addEventListener("click", async () => {
        try {
          if (typeof generateLink === "function") {
            await generateLink();
          }
        } catch (err) {
          console.error("[initLinux] Erreur génération lien :", err);
          alert("Erreur lors de la génération du lien : " + (err?.message || String(err)));
        }
      });
    }

    // 4) Chargement automatique d'un exercice depuis l'URL
    const params = new URLSearchParams(window.location.search);
    const hasLoadableUrlParam = !!(params.get("code") || params.get("exo") || params.get("sid"));

    if (hasLoadableUrlParam && typeof decode_url === "function") {
      try {
        const ok = await decode_url(window.location.href);
        if (ok) {
          history.replaceState({}, document.title, window.location.pathname);
        }
      } catch (err) {
        console.error("[initLinux] Erreur décodage URL :", err);
      }
    }

    // Compteur d'élèves connectés (panneau "À propos")
    if (window._dariushSocket) {
      const sock = window._dariushSocket;

      // Mise à jour automatique quand le serveur diffuse
      sock.on("linux_count_update", (data) => {
        const elCount  = document.getElementById("aproposLinuxCount");
        const elMax    = document.getElementById("aproposLinuxMax");
        const elRecord = document.getElementById("aproposLinuxRecordCount");
        if (elCount)  elCount.textContent  = (data && typeof data.count  === "number") ? data.count  : "?";
        if (elMax)    elMax.textContent    = (data && typeof data.max    === "number") ? data.max    : "?";
        if (elRecord) elRecord.textContent = (data && typeof data.record === "number") ? data.record : "?";
      });

      // Quand on ouvre le panneau "À propos", redemander le compteur
      const btnApropos = document.querySelector('button[onclick*="panel-apropos"]');
      if (btnApropos) {
        btnApropos.addEventListener("click", () => {
          if (sock.connected) {
            sock.emit("linux_get_count");
          }
        });
      }

      // Demander une première fois au chargement
      if (sock.connected) {
        sock.emit("linux_get_count");
      } else {
        sock.once("connect", () => sock.emit("linux_get_count"));
      }
    }



  });
})();