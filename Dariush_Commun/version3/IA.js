(function () {
  const IA = {
    state: {
      provider: "",
      apiKey: "",
    },

    init() {
      this.cacheDom();
      this.bindEvents();
      this.adaptToSource();
    },

   cacheDom() {
      this.panel        = document.getElementById("iaPanel");
      this.toggleBtn    = document.getElementById("openIaPanel");
      this.closeBtn     = document.getElementById("closeIaPanel");

      this.connectZone  = document.getElementById("iaConnectZone");
      this.providerSelect = document.getElementById("iaProvider");
      this.apiKeyInput  = document.getElementById("iaApiKey");
      this.connectBtn   = document.getElementById("iaConnectBtn");
      this.cancelBtn    = document.getElementById("iaCancelBtn");
      this.status       = document.getElementById("iaStatus");

      this.historique   = document.getElementById("iaHistorique");
      this.coursInput   = document.getElementById("iaCoursInput");
      this.coursBtn     = document.getElementById("iaCoursBtn");

      this.correctBtn   = document.getElementById("iaCorrectBtn");
      this.generateBtn  = document.getElementById("iaGenerateBtn");
      this.explainBtn   = document.getElementById("iaExplainBtn");
    },
   adaptToSource() {
  const source = (typeof getDariushSource === "function") ? getDariushSource() : "python";

  if (source === "linux") {
    // Linux : les 4 boutons IA n'ont pas d'intérêt
    [this.correctBtn, this.generateBtn, this.explainBtn].forEach(b => {
      if (b) b.style.display = "none";
    });
    const notebookBtn = document.getElementById("iaNotebookBtn");
    if (notebookBtn) notebookBtn.style.display = "none";
  }

  if (source === "sql") {
    // SQL : le notebook n'a pas d'intérêt
    const notebookBtn = document.getElementById("iaNotebookBtn");
    if (notebookBtn) notebookBtn.style.display = "none";
  }
},
   bindEvents() {
      if (this.toggleBtn) this.toggleBtn.addEventListener("click", () => this.togglePanel());
      if (this.closeBtn)  this.closeBtn.addEventListener("click", () => this.hidePanel());

      /* Changement de moteur dans le select de l'en-tête */
      if (this.providerSelect) {
        this.providerSelect.addEventListener("change", () => this.onProviderChange());
      }

      /* Valider / annuler la clé */
      if (this.connectBtn) this.connectBtn.addEventListener("click", () => this.connect());
      if (this.cancelBtn)  this.cancelBtn.addEventListener("click", () => this.cancelConnect());

      /* Assistance cours (toujours disponible) */
      if (this.coursBtn)   this.coursBtn.addEventListener("click", () => this.assistanceCours());
      if (this.coursInput) {
        this.coursInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") this.assistanceCours();
        });
      }

      /* 3 boutons prof : actifs seulement si une clé est validée */
      if (this.correctBtn) {
        this.correctBtn.addEventListener("click", () => {
          if (this.state.apiKey) this.correctCode();
          else this.promptChoisirMoteur();
        });
      }
      if (this.generateBtn) {
        this.generateBtn.addEventListener("click", () => {
          if (this.state.apiKey) this.generateFunction();
          else this.promptChoisirMoteur();
        });
      }
      if (this.explainBtn) {
        this.explainBtn.addEventListener("click", () => {
          if (this.state.apiKey) this.explainError();
          else this.promptChoisirMoteur();
        });
      }
    },

    togglePanel() {
      this.panel.classList.toggle("ia-open");
    },

    hidePanel() {
      this.panel.classList.remove("ia-open");
    },

    setStatus(message, type = "info") {
      this.status.textContent = message;
      this.status.className = "ia-status " + type;
    },

    promptChoisirMoteur() {
      this.setStatus("Choisissez un moteur dans le menu en haut, puis validez votre clé API.", "info");
    },

    onProviderChange() {
      const provider = this.providerSelect.value;

      /* Option vide = Groq gratuit */
      if (!provider) {
        this.setFreeMode();
        return;
      }

      /* Moteur payant : a-t-il une clé ? */
      const aUneCle = confirm(
        "Pour utiliser ce moteur, vous devez avoir votre propre clé API.\n\nEn avez-vous une ?"
      );
      if (aUneCle) {
        this.connectZone.style.display = "flex";
        if (this.apiKeyInput) { this.apiKeyInput.value = ""; this.apiKeyInput.focus(); }
        this.setStatus("Entrez votre clé API puis validez.", "info");
      } else {
        this.setFreeMode();
      }
    },

    setFreeMode() {
      this.state.provider = "";
      this.state.apiKey   = "";
      if (this.providerSelect) this.providerSelect.value = "";
      if (this.connectZone)    this.connectZone.style.display = "none";
      if (this.apiKeyInput)    this.apiKeyInput.value = "";
      this.lockProfButtons();
      this.setStatus("Mode Groq gratuit. Assistance cours et Aide disponibles.", "info");
    },

    lockProfButtons() {
      [this.correctBtn, this.generateBtn, this.explainBtn]
        .forEach(b => b && b.classList.add("ia-tool-locked"));
    },

    unlockProfButtons() {
      [this.correctBtn, this.generateBtn, this.explainBtn]
        .forEach(b => b && b.classList.remove("ia-tool-locked"));
    },

    cancelConnect() {
      this.setFreeMode();
    },

   /* showConnectZone() {
  const reponse = confirm(
    "Pour utiliser cette fonctionnalité, vous devez avoir votre propre clé API.\n\nAvez-vous une clé API ?"
  );
  if (reponse && this.connectZone) {
    this.connectZone.style.display = "flex";
  }
},*/

    /* ------------------------------------------------
       Connexion clé API perso (3 boutons prof)
    ------------------------------------------------ */
    async connect() {
      const provider = this.providerSelect.value.trim();
      const apiKey   = this.apiKeyInput.value.trim();

      if (!provider) { this.setStatus("Choisis d'abord un moteur.", "error"); return; }
      if (!apiKey)   { this.setStatus("Entre ta clé API.", "error"); return; }

      this.setStatus("Vérification de la clé...", "info");

      try {
        const res = await fetch("https://physalgo.fr/Dariush_Commun/api/ia.php", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, apiKey, action: "ping" })
        });

        const rawText = await res.text();
        let data;
        try { data = JSON.parse(rawText); }
        catch (e) { throw new Error("Réponse serveur invalide"); }

        if (!data.ok) throw new Error(data.error || "Connexion échouée");

        this.state.provider = provider;
        this.state.apiKey   = apiKey;

        this.connectZone.style.display = "none";
        this.unlockProfButtons();
        this.setStatus("Clé validée — moteur actif pour cette session.", "success");
      } catch (err) {
        this.setStatus("Clé refusée : " + err.message, "error");
      }
    },

    /* ------------------------------------------------
       Assistance cours — Groq/Gemini gratuit
       ou clé perso du prof si connectée
    ------------------------------------------------ */
    async assistanceCours() {
      const question = this.coursInput ? this.coursInput.value.trim() : "";

      if (!question) {
        this.setStatus("Pose une question d'abord.", "info");
        return;
      }

      this.setStatus("Recherche en cours...", "info");
      this.coursBtn.disabled = true;

      /* Ajoute la question dans l'historique */
      this.ajouterHistorique("Q : " + question);

      try {
        const res = await fetch("https://physalgo.fr/Dariush_Commun/api/ia.php", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action:   "cours",
            question: question,
            /* Si le prof a connecté sa clé, on la passe — sinon vide */
            provider: this.state.provider || "",
            apiKey:   this.state.apiKey   || "",
            /* Source : permet au PHP d'adapter le prompt système selon l'app */
            source:   (typeof getDariushSource === "function") ? getDariushSource() : "python"
          })
        });

        const rawText = await res.text();
        console.log("Réponse brute assistance cours :", rawText);

        let data;
        try {
          data = JSON.parse(rawText);
        } catch (e) {
          throw new Error("Réponse serveur invalide");
        }

        if (data.error === "limite_atteinte") {
          this.ajouterHistorique("R : Le service est momentanément indisponible (limite quotidienne atteinte). Réessayez dans quelques heures.");
          this.setStatus("Service indisponible.", "error");
          return;
        }

        if (data.error) {
          throw new Error(data.error);
        }

        this.ajouterHistorique("R : " + data.result);
        this.setStatus("", "info");

        /* Vide l'input après envoi */
        if (this.coursInput) this.coursInput.value = "";

      } catch (err) {
        this.ajouterHistorique("R : Erreur — " + err.message);
        this.setStatus(err.message, "error");
      } finally {
        this.coursBtn.disabled = false;
      }
    },

    /* Ajoute un message dans le textarea historique */
 ajouterHistorique(texte) {
  if (!this.historique) return;
  const sep = this.historique.innerHTML ? "<hr style='border:none;border-top:1px solid #ddd;margin:8px 0'>" : "";
  
  let html;
  if (texte.startsWith("Q : ")) {
    // La question en texte simple
    const q = texte.replace("Q : ", "");
    html = `<div class="ia-hist-question"><strong>Q :</strong> ${q}</div>`;
  } else {
    // La réponse en Markdown rendu
    const r = texte.replace("R : ", "");
    const rendu = window.markdownit ? window.markdownit().render(r) : r;
    html = `<div class="ia-hist-reponse">${rendu}</div>`;
  }
  
  this.historique.innerHTML += sep + html;
  this.historique.scrollTop = this.historique.scrollHeight;
},

    /* ------------------------------------------------
       Utilitaires éditeur
    ------------------------------------------------ */
    getCurrentCode() {
      if (window.pythonEditor && typeof window.pythonEditor.getValue === "function") {
        return window.pythonEditor.getValue();
      }
      const textarea = document.getElementById("code");
      return textarea ? textarea.value : "";
    },

    setEditorCode(code) {
      if (window.pythonEditor && typeof window.pythonEditor.setValue === "function") {
        window.pythonEditor.setValue(code);
        return;
      }
      const textarea = document.getElementById("code");
      if (textarea) textarea.value = code;
    },

    /* ------------------------------------------------
       Appel IA générique (3 boutons prof)
    ------------------------------------------------ */
    async askAI(payload) {
      this.setStatus("Requête en cours...", "info");

      const res = await fetch("https://physalgo.fr/Dariush_Commun/api/ia.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: this.state.provider,
          apiKey:   this.state.apiKey,
          /* Source : permet au PHP d'adapter le prompt selon l'app */
          source:   (typeof getDariushSource === "function") ? getDariushSource() : "python",
          ...payload
        })
      });

      const rawText = await res.text();
      console.log("Réponse brute ia.php :", rawText);

      let data;
      try {
        data = JSON.parse(rawText);
      } catch (e) {
        throw new Error("Le serveur ne renvoie pas du JSON. Ouvre F12 > Console et regarde 'Réponse brute ia.php'.");
      }

      if (!res.ok || data.error) {
        throw new Error(data.error || "Erreur inconnue");
      }

      return data.result;
    },

    /* ------------------------------------------------
       3 boutons prof
    ------------------------------------------------ */
    async correctCode() {
      try {
        const code = this.getCurrentCode();
        if (!code.trim()) {
          this.setStatus("Aucun code à corriger.", "error");
          return;
        }
        let result = await this.askAI({ action: "correct", code });
        result = result.replace(/```python/g, "").replace(/```sql/gi, "").replace(/```/g, "").trim();
        this.setEditorCode(result);
        this.setStatus("Code corrigé.", "success");
      } catch (err) {
        this.setStatus(err.message, "error");
      }
    },

   async generateFunction() {
      try {
        const source = (typeof getDariushSource === "function") ? getDariushSource() : "python";
        const promptText = (source === "sql")
          ? "Décris la requête SQL à générer :"
          : "Décris la fonction Python à générer :";
        const question = prompt(promptText);
        if (!question || !question.trim()) {
          this.setStatus("Génération annulée.", "info");
          return;
        }
        let result = await this.askAI({ action: "generate", question: question.trim() });
        result = result.replace(/```python/g, "").replace(/```sql/gi, "").replace(/```/g, "").trim();
        this.setEditorCode(result);
        this.setStatus((source === "sql") ? "Requête générée." : "Fonction générée.", "success");
      } catch (err) {
        this.setStatus(err.message, "error");
      }
    },

    async explainError() {
      try {
        const code = this.getCurrentCode();
        if (!code.trim()) {
          this.setStatus("Aucun code à analyser.", "error");
          return;
        }
        let result = await this.askAI({ action: "explain", code });
        
        result = result.replace(/```python/g, "").replace(/```sql/gi, "").replace(/```/g, "").trim();
        this.setEditorCode(result);
        this.setStatus("Correction avec explications reçue.", "success");
      } catch (err) {
        this.setStatus(err.message, "error");
      }
    }
  };

  window.IAHelper = IA;

  document.addEventListener("DOMContentLoaded", function () {
    IA.init();
  });
})();