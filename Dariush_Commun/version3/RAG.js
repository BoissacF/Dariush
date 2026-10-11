/* =============================================================================
   RAG.js  —  Generation de notebook d'exercices (bouton + zone de capture)
   -----------------------------------------------------------------------------
   Module autonome : il LIT seulement l'etat deja expose
   par IA.js via window.IAHelper.state (provider + apiKey valides).

   Responsabilites :
   - garder le bouton #iaNotebookBtn synchronise (grise/actif) sur les 3 boutons
     IA, en observant #iaCorrectBtn.
   - ouvrir la zone #ragGenZone (qui masque le reste du panneau IA).
   - animer le curseur de difficulte.
   - collecter le formulaire, demander confirmation (sauvegarde), appeler
     l'endpoint, puis importer le notebook genere a la place du fichier actuel.

   Depend de :
   - window.IAHelper.state  (expose par IA.js)
   - window.importNotebookObject(nb)  (a exposer cote importer.js, etape suivante)
   ============================================================================= */

(function () {
  "use strict";

const ENDPOINT = "https://physalgo.fr/Dariush_Commun/api/genere_exercice_ia.php";
//const ENDPOINT = "https://physalgo.fr/Dariush_Commun/api/genere_exercice_ia.php?debug=1";
  const RAG = {

    cacheDom() {
      this.btn        = document.getElementById("iaNotebookBtn");
      this.zone       = document.getElementById("ragGenZone");
      this.correctBtn = document.getElementById("iaCorrectBtn"); // pour la synchro grise/actif

      this.slider     = document.getElementById("ragDifficulte");
      this.sliderVal  = document.getElementById("ragDifficulteVal");
      this.niveau     = document.getElementById("ragNiveau");
      this.nombre     = document.getElementById("ragNombre");

      this.genererBtn = document.getElementById("ragGenererBtn");
      this.cancelBtn  = document.getElementById("ragGenCancelBtn");
      this.status     = document.getElementById("ragGenStatus");

      this._hidden = [];
    },

    init() {
      this.cacheDom();
      if (!this.btn || !this.zone) return; // panneau absent : on ne fait rien

      // 1) Synchronisation de l'etat grise/actif sur les boutons IA.
      this.syncLock();
      if (this.correctBtn && "MutationObserver" in window) {
        this._obs = new MutationObserver(() => this.syncLock());
        this._obs.observe(this.correctBtn, { attributes: true, attributeFilter: ["class"] });
      }

      // 2) Evenements.
      this.btn.addEventListener("click", () => this.onBtnClick());
      if (this.cancelBtn)  this.cancelBtn.addEventListener("click", () => this.closeZone());
      if (this.genererBtn) this.genererBtn.addEventListener("click", () => this.generer());
      if (this.slider) {
        this.slider.addEventListener("input", () => {
          if (this.sliderVal) this.sliderVal.textContent = this.slider.value;
        });
      }
    },

    /* ----- credentials lus dans IA.js (lecture seule) ----- */
    creds() {
      const s = (window.IAHelper && window.IAHelper.state) ? window.IAHelper.state : {};
      return { provider: s.provider || "", apiKey: s.apiKey || "" };
    },
    estDeverrouille() {
      return this.creds().apiKey !== "";
    },

    /* ----- synchro grise/actif : recopie l'etat du bouton "Corriger" ----- */
    syncLock() {
      if (!this.btn || !this.correctBtn) return;
      const locked = this.correctBtn.classList.contains("ia-tool-locked");
      this.btn.classList.toggle("ia-tool-locked", locked);
    },

    onBtnClick() {
      if (!this.estDeverrouille()) {
        // Meme comportement que les 3 boutons IA : on invite a valider une cle.
        if (window.IAHelper && typeof window.IAHelper.promptChoisirMoteur === "function") {
          window.IAHelper.promptChoisirMoteur();
        }
        return;
      }
      this.openZone();
    },

    /* ----- ouverture : masque tout le reste du corps du panneau IA ----- */
    openZone() {
      const body = this.zone.parentElement; // .ia-body
      this._hidden = [];
      Array.from(body.children).forEach((ch) => {
        if (ch !== this.zone) {
          this._hidden.push([ch, ch.style.display]);
          ch.style.display = "none";
        }
      });
      this.zone.style.display = "flex";
      if (this.status) { this.status.textContent = ""; this.status.className = "ia-status"; }
    },

    closeZone() {
      (this._hidden || []).forEach(([ch, disp]) => { ch.style.display = disp; });
      this._hidden = [];
      this.zone.style.display = "none";
    },

    setStatus(message, type) {
      if (!this.status) return;
      this.status.textContent = message;
      this.status.className = "ia-status " + (type || "info");
    },

    /* ----- collecte du formulaire ----- */
    collecter() {
      const themes = Array.from(document.querySelectorAll(".rag-theme-cb:checked"))
        .map((cb) => cb.value);
      return {
        themes: themes,
        niveau_max: parseInt(this.niveau ? this.niveau.value : "5", 10) || 5,
        nombre: parseInt(this.nombre ? this.nombre.value : "5", 10) || 5,
        pct_difficile: parseInt(this.slider ? this.slider.value : "50", 10) || 0,
      };
    },
    libelleTheme(cle) {
      const cb = document.querySelector('.rag-theme-cb[value="' + cle + '"]');
      if (cb && cb.parentElement) {
        return cb.parentElement.textContent.trim();
      }
      return cle;
    },
    /* ----- generation ----- */
    async generer() {
      if (!this.estDeverrouille()) {
        this.setStatus("Validez d'abord un moteur et une cle API.", "error");
        return;
      }

      const data = this.collecter();
      if (!data.themes.length) {
        this.setStatus("Cochez au moins un theme.", "error");
        return;
      }

      // Message de sauvegarde avant remplacement.
      const ok = confirm(
        "Le notebook actuel va etre remplace par le notebook genere.\n\n" +
        "Pense a le sauvegarder si tu veux le garder.\n\nContinuer ?"
      );
      if (!ok) return;

      if (typeof window.importNotebookObject !== "function") {
        this.setStatus("Import indisponible (fonction importNotebookObject absente).", "error");
        return;
      }

      const creds = this.creds();
      this.setStatus("Generation en cours...", "info");
      if (this.genererBtn) this.genererBtn.disabled = true;

      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: creds.provider,
            apiKey: creds.apiKey,
            themes: data.themes,
            niveau_max: data.niveau_max,
            nombre: data.nombre,
            pct_difficile: data.pct_difficile,
          }),
        });

        const rawText = await res.text();
        let j;
        try { j = JSON.parse(rawText); }
        catch (e) { throw new Error("Reponse serveur invalide."); }

        if (!j.ok) throw new Error(j.error || "Erreur de generation.");
        if (!j.notebook || !Array.isArray(j.notebook.cells)) {
          throw new Error("Notebook genere invalide.");
        }

       // Avertissement si des themes coches n'ont aucun exemple a ce niveau.
        if (Array.isArray(j.themes_absents) && j.themes_absents.length) {
          const libelles = j.themes_absents.map((cle) => this.libelleTheme(cle));
          const niveau = j.niveau_libelle || "ce niveau";
          alert(
            "Aucun exercice niveau " + niveau + " de la base ne traite ce ou ces themes : " +
            libelles.join(", ") + ".\n\n" +
            "Dariush a géneré des exercices mais ne peut pas certifier qu'ils sont du niveau " + niveau + "."
          );
        }

        // Import a la place du fichier actuel.
        await window.importNotebookObject(j.notebook);

        this.setStatus("Notebook genere.", "success");
        this.closeZone();

        // On ferme le panneau IA pour laisser voir le notebook.
        if (window.IAHelper && typeof window.IAHelper.hidePanel === "function") {
          window.IAHelper.hidePanel();
        }
      } catch (err) {
        this.setStatus(err.message || "Erreur inconnue.", "error");
      } finally {
        if (this.genererBtn) this.genererBtn.disabled = false;
      }
    },
  };

  document.addEventListener("DOMContentLoaded", function () {
    RAG.init();
  });

  window.RAGGen = RAG;
})();