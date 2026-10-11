/* =========================================================================
   executerTout.js  --  Bouton "Tous"
   -------------------------------------------------------------------------
   Execute TOUTES les pages du notebook dans l'ordre, en semantique CUMULEE
   (l'etat Python est partage d'une page a l'autre, exactement comme un vrai
   notebook : la page N voit les variables/fonctions definies aux pages
   precedentes). A la fin, affiche un petit panneau listant les pages qui
   n'ont pas pu etre executees.

   - Une page qui plante n'interrompt PAS le test : on passe a la suivante.
     (Une page suivante peut neanmoins planter si elle dependait d'une globale
      definie dans la page en echec : comportement normal du cumul.)
   - Une page qui reclame input() est annulee puis marquee "non testee
     (saisie)", de sorte qu'aucune page ne puisse bloquer toute la batterie.
   - Une page qui tourne trop longtemps (TIMEOUT_PAGE_MS, boucle infinie ?)
     est interrompue en TUANT le worker. Comme l'etat cumule est alors perdu,
     le test S'ARRETE : la page est marquee "interrompue", les suivantes
     "non testees".
   - Bouton "Stop" dans le panneau : meme interruption, declenchee a la main.
   - Pendant le test, le bouton "Fermer" (et la croix, et le clic en dehors)
     est DESACTIVE : seul "Stop" arrete reellement un eventuel calcul en cours.
     "Fermer" se reactive des que le test est termine (fin normale, timeout
     ou Stop).

   Dependances deja globales :
     - window.pyWorker                (worker Pyodide)
     - window.resetWorkerPythonState  (remet l'etat Python a zero, awaitable)
     - window.addAwaitToInputCalls    (transforme input() pour le worker)
     - window.nettoyerCaracteresInvisibles (retire les caracteres invisibles)
     - window.PagesMultiples          (getAllPages, ...)
   ========================================================================= */
(function () {
  "use strict";

  /* -----------------------------------------------------------------------
     REGLAGES
     ----------------------------------------------------------------------- */

  // Duree max d'execution d'une page avant interruption (boucle infinie ?).
  var TIMEOUT_PAGE_MS = 15000;

  // Que faire d'une page qui reclame une saisie input() ?
  //   false (defaut) -> on ANNULE la saisie, page marquee "non testee (saisie)".
  //   true           -> on envoie une saisie VIDE ("") et la page tourne.
  var ENVOYER_SAISIE_VIDE = false;

  /* ----------------------------------------------------------------------- */

  var enCours = false;

  // Reference vers la page en cours d'execution, pour pouvoir l'interrompre
  // depuis le bouton Stop. { arreter: fn } ou null.
  var pageEnCours = null;

  function getRunAllButton() {
    return document.getElementById("runAllButton");
  }

  /* ---------------------- Petit panneau de resultats --------------------- */
  function fermerPanel() {
    var ex = document.getElementById("runAllResultOverlay");
    if (ex) ex.remove();
  }

  function ouvrirPanel(titre) {
    fermerPanel();

    var overlay = document.createElement("div");
    overlay.id = "runAllResultOverlay";
    overlay.className = "menu-modal-overlay";
    overlay.style.display = "flex";

    var win = document.createElement("div");
    win.className = "menu-modal-window";
    win.style.width = "min(640px, calc(100vw - 32px))";

    win.innerHTML =
      '<div class="menu-modal-header">' +
        "<h3>" + titre + "</h3>" +
        '<button class="menu-close-btn nav-item nav-btn" type="button" aria-label="Fermer">\u2715</button>' +
      "</div>" +
      '<div class="menu-modal-body"><div id="runAllResultContent"></div></div>' +
      '<div class="menu-modal-footer">' +
        '<button class="nav-item nav-btn" type="button" id="runAllStop">\u23F9 Stop</button>' +
        '<button class="nav-item nav-btn" type="button" id="runAllResultClose">Fermer</button>' +
      "</div>";

    overlay.appendChild(win);
    document.body.appendChild(overlay);

    // On ne ferme JAMAIS le panneau tant que le test tourne : seul "Stop"
    // peut interrompre. close() est donc neutralise pendant l'execution.
    function close() {
      if (enCours) return;
      fermerPanel();
    }
    win.querySelector(".menu-close-btn").addEventListener("click", close);
    win.querySelector("#runAllResultClose").addEventListener("click", close);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });

    return overlay;
  }

  function majProgression(content, courante, total) {
    if (!content) return;
    content.textContent = "Test en cours\u2026 page " + courante + " / " + total;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function afficherResultats(content, resultats, total) {
    if (!content) return;

    var echecs    = resultats.filter(function (r) { return r.statut === "echec"; });
    var saisies   = resultats.filter(function (r) { return r.statut === "saisie"; });
    var timeouts  = resultats.filter(function (r) { return r.statut === "timeout"; });
    var arrets    = resultats.filter(function (r) { return r.statut === "arret"; });
    var nontestes = resultats.filter(function (r) { return r.statut === "nonteste"; });
    var exclues   = resultats.filter(function (r) { return r.statut === "exclue"; });
    var ok = resultats.filter(function (r) { return r.statut === "ok"; }).length;

    var html =
      '<p style="margin:0 0 10px;"><strong>' + ok + " / " + total +
      " page(s) executee(s) sans erreur.</strong></p>";

    var rien = echecs.length === 0 && saisies.length === 0 &&
               timeouts.length === 0 && arrets.length === 0 &&
               nontestes.length === 0 && exclues.length === 0;
    if (rien) {
      html += '<p style="margin:0;">Aucune page en echec. \u2705</p>';
    }

    if (exclues.length > 0) {
      html += '<p style="margin:12px 0 4px;"><strong>Pages retirees du test :</strong></p>' +
              '<p style="margin:0;">' +
              exclues.map(function (r) { return "Page " + r.page; }).join(", ") +
              "</p>";
    }

    if (echecs.length > 0) {
      html += '<p style="margin:12px 0 4px;"><strong>Pages en echec :</strong></p>' +
              '<ul style="margin:0;padding-left:20px;">';
      echecs.forEach(function (r) {
        html += '<li style="margin-bottom:6px;">Page ' + r.page +
                ' \u2014 <span style="color:#b00020;">' + esc(r.message) + "</span></li>";
      });
      html += "</ul>";
    }

    if (timeouts.length > 0) {
      timeouts.forEach(function (r) {
        html += '<p style="margin:12px 0 4px;color:#b00020;"><strong>Page ' + r.page +
                " interrompue : " + esc(r.message) + "</strong></p>";
      });
    }

    if (arrets.length > 0) {
      arrets.forEach(function (r) {
        html += '<p style="margin:12px 0 4px;"><strong>Test arrete manuellement a la page ' +
                r.page + ".</strong></p>";
      });
    }

    if (saisies.length > 0) {
      html += '<p style="margin:12px 0 4px;"><strong>Pages non testees (saisie interactive) :</strong></p>' +
              '<ul style="margin:0;padding-left:20px;">';
      saisies.forEach(function (r) {
        html += '<li style="margin-bottom:6px;">Page ' + r.page + "</li>";
      });
      html += "</ul>";
    }

    if (nontestes.length > 0) {
      html += '<p style="margin:12px 0 4px;"><strong>Pages non testees (test interrompu) :</strong></p>' +
              '<p style="margin:0;">' +
              nontestes.map(function (r) { return "Page " + r.page; }).join(", ") +
              "</p>";
    }

    content.innerHTML = html;
  }

  /* ---------------------------------------------------------------------
     Execute UNE page sur le worker et resout avec { statut, message }.
       statut : "ok" | "echec" | "saisie" | "timeout" | "arret"
     On detourne temporairement worker.onmessage le temps du run, puis on
     restaure le handler precedent. Un timeout (ou le bouton Stop via
     pageEnCours.arreter) TUE le worker : le run en cours est abandonne.
     --------------------------------------------------------------------- */
  function executerUnePage(worker, code, timeoutMs) {
    return new Promise(function (resolve) {
      var aDemandeSaisie = false;
      var messageErreur = null;
      var fini = false;
      var ancien = worker.onmessage;

      function terminer(resultat) {
        if (fini) return;
        fini = true;
        clearTimeout(timer);
        try { worker.onmessage = ancien; } catch (e) { /* worker mort : sans effet */ }
        pageEnCours = null;
        resolve(resultat);
      }

      var timer = setTimeout(function () {
        try { worker.terminate(); } catch (e) { /* rien */ }
        terminer({
          statut: "timeout",
          message: "boucle infinie ? (> " + Math.round(timeoutMs / 1000) + " s)"
        });
      }, timeoutMs);

      worker.onmessage = function (event) {
        var data = (event && event.data) || {};

        switch (data.type) {
          case "input_request":
            aDemandeSaisie = true;
            if (ENVOYER_SAISIE_VIDE) {
              worker.postMessage({ type: "input_response", requestId: data.requestId, value: "" });
            } else {
              worker.postMessage({ type: "input_cancel", requestId: data.requestId });
            }
            return;

          case "error":
            if (messageErreur === null) {
              messageErreur = String(data.message || "Erreur inconnue");
            }
            return;

          case "done":
            if (aDemandeSaisie && !ENVOYER_SAISIE_VIDE) {
              terminer({ statut: "saisie", message: "" });
            } else if (messageErreur) {
              terminer({ statut: "echec", message: messageErreur.split("\n")[0] });
            } else {
              terminer({ statut: "ok", message: "" });
            }
            return;

          // stdout / stderr / image / html_output / info / run_replay_* :
          // ignores pendant le test.
          default:
            return;
        }
      };

      // Permet au bouton Stop d'interrompre cette page.
      pageEnCours = {
        arreter: function () {
          try { worker.terminate(); } catch (e) { /* rien */ }
          terminer({ statut: "arret", message: "Test interrompu" });
        }
      };

      // Caracteres invisibles du copier-coller (espaces insecables...) :
      // retires a la volee, sans modifier les pages elles-memes.
      var propre = (typeof window.nettoyerCaracteresInvisibles === "function")
        ? window.nettoyerCaracteresInvisibles(code)
        : code;

      var transforme = (typeof window.addAwaitToInputCalls === "function")
        ? window.addAwaitToInputCalls(propre)
        : propre;

      // contextCode vide : en cumule, l'etat des pages precedentes est deja
      // present dans le worker, donc le filet "rejeu sur NameError" est inutile.
      worker.postMessage({ type: "run", code: transforme, contextCode: "" });
    });
  }

  /* ---------------------------------------------------------------------
     Reset Python "leger" : vide les variables/fonctions/classes (etat propre
     pour le test) MAIS garde le systeme de fichiers Pyodide, donc les
     ressources deja chargees (images, CSV, modules .py) restent en memoire
     -- exactement comme le debogueur pas a pas. On NE redemarre PAS le worker
     (un redemarrage viderait le systeme de fichiers).
     Rendu attendable grace au signal "reset_python_state_done" poste par le
     worker. Filet de securite : si le worker ne repond pas (mort/bloque), on
     bascule sur un redemarrage complet.
     --------------------------------------------------------------------- */
  function resetPythonGardeFichiers(worker, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!worker) { reject(new Error("worker absent")); return; }

      var fini = false;
      var ancien = worker.onmessage;

      function fin(ok) {
        if (fini) return;
        fini = true;
        clearTimeout(t);
        try { worker.onmessage = ancien; } catch (e) { /* worker mort */ }
        if (ok) resolve(); else reject(new Error("reset_python_state sans reponse"));
      }

      var t = setTimeout(function () { fin(false); }, timeoutMs || 15000);

      worker.onmessage = function (event) {
        var d = (event && event.data) || {};
        if (d.type === "reset_python_state_done") fin(true);
        // tout le reste est ignore pendant le reset
      };

      worker.postMessage({ type: "reset_python_state" });
    });
  }

  // Reset d'etat Python en conservant les ressources si possible ; sinon
  // (worker injoignable) redemarrage complet. Renvoie true si le systeme de
  // fichiers a ete conserve.
  async function resetEtatPython() {
    try {
      await resetPythonGardeFichiers(window.pyWorker, 15000);
      return true; // ressources conservees
    } catch (e) {
      if (typeof window.resetWorkerPythonState === "function") {
        await window.resetWorkerPythonState(); // redemarrage complet (FS perdu)
      }
      return false;
    }
  }

  async function executerToutesLesPages() {
    // Appel depuis le bouton : on repart d'une liste d'exclusions vide.
    await lancerTest(new Set());
  }

  async function lancerTest(pagesExclues) {
    if (enCours) return;

    if (!window.PagesMultiples || typeof window.PagesMultiples.getAllPages !== "function") {
      alert("Le systeme multi-pages n'est pas disponible.");
      return;
    }

    var pages = window.PagesMultiples.getAllPages() || [];
    if (pages.length < 2) return;

    enCours = true;
    var bouton = getRunAllButton();
    var runBtn = document.getElementById("runButton");
    if (bouton) bouton.disabled = true;
    if (runBtn) runBtn.disabled = true;

    var overlay  = ouvrirPanel("Test de toutes les pages");
    var content  = overlay.querySelector("#runAllResultContent");
    var stopBtn  = overlay.querySelector("#runAllStop");
    var closeBtn = overlay.querySelector("#runAllResultClose");
    var xBtn     = overlay.querySelector(".menu-close-btn");

    // Pendant le test : seul "Stop" est actif. "Fermer" et la croix sont
    // desactives pour qu'on ne puisse pas masquer un calcul (boucle infinie)
    // qui tournerait encore en arriere-plan.
    if (stopBtn)  stopBtn.disabled = false;
    if (closeBtn) closeBtn.disabled = true;
    if (xBtn)     xBtn.disabled = true;

    var resultats = [];
    var demandeArret = false;
    var workerTermine = false;   // vrai si le worker a ete tue (timeout/Stop)
    var pageInterrompue = null;  // { index, statut, message } de la page interrompue

    function onStop() {
      demandeArret = true;
      if (stopBtn) stopBtn.disabled = true;
      if (pageEnCours && typeof pageEnCours.arreter === "function") {
        pageEnCours.arreter();
      }
    }
    if (stopBtn) stopBtn.addEventListener("click", onStop);

    try {
      // Etat Python propre avant de jouer la 1re page (sinon des globales
      // d'une execution precedente fausseraient le test), MAIS on conserve les
      // ressources chargees (images, CSV, modules) via le reset leger.
      await resetEtatPython();

      var worker = window.pyWorker;
      if (!worker) {
        if (content) content.textContent = "Worker Python indisponible.";
        return;
      }

      var arrete = false;

      for (var i = 0; i < pages.length; i++) {
        if (demandeArret) { arrete = true; break; }

        // Page exclue lors d'une relance precedente : on ne l'execute pas.
        if (pagesExclues && pagesExclues.has(i)) {
          resultats.push({ page: i + 1, statut: "exclue", message: "" });
          continue;
        }

        majProgression(content, i + 1, pages.length);

        var code = String((pages[i] && pages[i].code) || "");

        // page vide : consideree OK (rien a executer), l'etat est conserve.
        if (!code.trim()) {
          resultats.push({ page: i + 1, statut: "ok", message: "" });
          continue;
        }

        var r = await executerUnePage(worker, code, TIMEOUT_PAGE_MS);
        resultats.push({ page: i + 1, statut: r.statut, message: r.message });

        // timeout ou Stop : worker tue, etat cumule perdu -> on arrete le test.
        if (r.statut === "timeout" || r.statut === "arret") {
          arrete = true;
          workerTermine = true;
          pageInterrompue = { index: i, statut: r.statut, message: r.message };
          break;
        }
      }

      // Pages restantes apres une interruption : marquees "non testees".
      if (arrete) {
        for (var j = resultats.length; j < pages.length; j++) {
          resultats.push({ page: j + 1, statut: "nonteste", message: "" });
        }
      }

      afficherResultats(content, resultats, pages.length);
    } catch (err) {
      if (content) {
        content.textContent = "Erreur pendant le test : " +
          (err && err.message ? err.message : String(err));
      }
    } finally {
      pageEnCours = null;
      enCours = false;

      // Test termine : "Stop" disparait, "Fermer" et la croix redeviennent
      // cliquables, quel que soit le mode de sortie (normal, timeout, Stop).
      if (stopBtn)  stopBtn.style.display = "none";
      if (closeBtn) closeBtn.disabled = false;
      if (xBtn)     xBtn.disabled = false;

      if (bouton) bouton.disabled = false;
      if (runBtn) runBtn.disabled = false;

      // Nettoyage de l'etat Python pour ne pas polluer une execution normale.
      // - Si le worker a ete tue (timeout/Stop) : on doit recreer un worker
      //   complet (le systeme de fichiers est perdu, c'est le cas abandon).
      // - Sinon : reset leger qui CONSERVE les ressources chargees.
      try {
        if (typeof workerTermine !== "undefined" && workerTermine) {
          if (typeof window.resetWorkerPythonState === "function") {
            await window.resetWorkerPythonState();
          }
        } else {
          await resetEtatPython();
        }
      } catch (e) { /* rien */ }
    }

    // Mode "elimination" : si une page a ete interrompue (boucle infinie ou
    // Stop), on propose de relancer tout le test sans elle. En acceptant
    // plusieurs fois, on retire au fur et a mesure les pages problematiques.
    // Le test repart toujours de la page 1 (semantique cumulee).
    if (pageInterrompue !== null) {
      var num = pageInterrompue.index + 1;
      var cause = (pageInterrompue.statut === "timeout")
        ? " : " + pageInterrompue.message
        : " (arret manuel)";
      var question = "La page " + num + " a ete interrompue" + cause +
        ".\n\nVoulez-vous relancer le test sans cette page ?";
      if (window.confirm(question)) {
        pagesExclues.add(pageInterrompue.index);
        await lancerTest(pagesExclues);
      }
    }
  }

  function init() {
    var bouton = getRunAllButton();
    if (!bouton) return;
    bouton.addEventListener("click", executerToutesLesPages);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();