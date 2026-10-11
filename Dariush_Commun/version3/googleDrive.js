/* =========================================================
   GOOGLE DRIVE : ouvrir / enregistrer directement sur le Drive
   =========================================================
   Fichier autonome. Expose window.DariushDrive :

     isAvailable()            -> false en mode portable / hors http(s)
     isEnabled()              -> case "Google Drive" cochée (mémorisée)
     attachCheckbox(titleEl)  -> ajoute la case à côté du titre d'une fenêtre
     pickFile(accept)         -> choix d'un fichier du Drive, renvoie un File
     saveText(contenu, opts)  -> enregistre un fichier texte sur le Drive

   Droit demandé : drive.file uniquement (Dariush ne voit que les fichiers
   qu'il a créés ou que l'utilisateur choisit lui-même dans le sélecteur).
   À l'enregistrement, l'utilisateur choisit le dossier du Drive (le
   dernier dossier choisi est mémorisé) ; aucun dossier n'est créé.

   Les valeurs ci-dessous ne sont pas secrètes (elles sont faites pour
   figurer dans la page) ; l'ID client est restreint au domaine du site
   dans la console Google Cloud. Le sélecteur de fichiers s'appuie sur la
   connexion de l'utilisateur : pas de clé API.
   ========================================================= */
(function () {
  "use strict";

  const DRIVE_CLIENT_ID = "588136460041-2smo68b1sn4k9rm3k8n7v2qjq40cluum.apps.googleusercontent.com";
  const DRIVE_APP_ID    = "588136460041"; // numéro du projet Google Cloud
  const DRIVE_SCOPE     = "https://www.googleapis.com/auth/drive.file";

  const DRIVE_FOLDER_MIME  = "application/vnd.google-apps.folder";
  const STORAGE_KEY        = "dariush_google_drive_v1";
  const FOLDER_STORAGE_KEY = "dariush_google_drive_dossier_v1";

  let accessToken = null;
  let accessTokenExpiry = 0;
  const scriptPromises = {};

  /* ---------- Disponibilité / case mémorisée ---------- */

  function isAvailable() {
    if (window.MODE_PORTABLE === true) return false;
    return location.protocol === "https:" || location.protocol === "http:";
  }

  function isEnabled() {
    if (!isAvailable()) return false;
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch (e) {
      return false;
    }
  }

  function setEnabled(value) {
    try {
      localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
    } catch (e) { /* stockage indisponible : la case ne sera pas mémorisée */ }
  }

  /* ---------- Chargement des bibliothèques Google ---------- */

  function loadScript(src) {
    if (!scriptPromises[src]) {
      scriptPromises[src] = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = src;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => {
          delete scriptPromises[src];
          reject(new Error("Impossible de charger les outils Google (connexion Internet ?)."));
        };
        document.head.appendChild(s);
      });
    }
    return scriptPromises[src];
  }

  function loadGis() {
    return loadScript("https://accounts.google.com/gsi/client");
  }

  function loadPicker() {
    return loadScript("https://apis.google.com/js/api.js").then(() => {
      if (window.google && window.google.picker) return;
      return new Promise((resolve, reject) => {
        window.gapi.load("picker", {
          callback: resolve,
          onerror: () => reject(new Error("Impossible de charger le sélecteur Google Drive."))
        });
      });
    });
  }

  // Chargé à l'avance pour que la fenêtre de connexion s'ouvre tout de suite
  // après le clic (sinon le navigateur peut la bloquer).
  function preload() {
    loadGis().catch(() => {});
    loadPicker().catch(() => {});
  }

  /* ---------- Connexion (jeton d'accès, valable 1 h) ---------- */

  function cancelError(message) {
    const err = new Error(message || "Annulé.");
    err.annule = true;
    return err;
  }

  async function getToken() {
    if (accessToken && Date.now() < accessTokenExpiry - 60000) return accessToken;

    await loadGis();

    return new Promise((resolve, reject) => {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: DRIVE_CLIENT_ID,
        scope: DRIVE_SCOPE,
        callback: (resp) => {
          if (!resp || resp.error) {
            if (resp && resp.error === "access_denied") {
              reject(cancelError("Connexion à Google refusée."));
            } else {
              reject(new Error("Connexion à Google impossible : " +
                ((resp && (resp.error_description || resp.error)) || "erreur inconnue")));
            }
            return;
          }
          if (!window.google.accounts.oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE)) {
            reject(new Error("L'accès à Google Drive n'a pas été autorisé."));
            return;
          }
          accessToken = resp.access_token;
          accessTokenExpiry = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
          resolve(accessToken);
        },
        error_callback: (err) => {
          if (err && err.type === "popup_closed") {
            reject(cancelError("Connexion à Google annulée."));
          } else if (err && err.type === "popup_failed_to_open") {
            reject(new Error("Le navigateur a bloqué la fenêtre de connexion Google. " +
              "Autorise les fenêtres pop-up pour ce site puis recommence."));
          } else {
            reject(new Error("Connexion à Google impossible" +
              (err && err.message ? " : " + err.message : ".")));
          }
        }
      });
      client.requestAccessToken({ prompt: "" });
    });
  }

  /* ---------- Appels à l'API Drive ---------- */

  async function driveFetch(url, options) {
    const token = await getToken();
    const opts = Object.assign({}, options || {});
    opts.headers = Object.assign({}, opts.headers || {}, { Authorization: "Bearer " + token });

    const res = await fetch(url, opts);
    if (res.status === 401) {
      accessToken = null;
      throw new Error("La connexion à Google a expiré. Recommence l'opération.");
    }
    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.json();
        detail = body && body.error && body.error.message ? body.error.message : "";
      } catch (e) { /* réponse non JSON */ }
      const err = new Error("Google Drive a refusé l'opération (" + res.status + ")" +
        (detail ? " : " + detail : "."));
      err.status = res.status;
      throw err;
    }
    return res;
  }

  function quoteForQuery(value) {
    return "'" + String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
  }

  async function findFirst(query) {
    const url = "https://www.googleapis.com/drive/v3/files?spaces=drive&pageSize=1" +
      "&fields=" + encodeURIComponent("files(id,name)") +
      "&q=" + encodeURIComponent(query);
    const data = await (await driveFetch(url)).json();
    return data.files && data.files[0] ? data.files[0] : null;
  }

  // Dernier dossier d'enregistrement choisi : { id, name } ou null.
  function getLastFolder() {
    try {
      const folder = JSON.parse(localStorage.getItem(FOLDER_STORAGE_KEY) || "null");
      return folder && folder.id && folder.name ? folder : null;
    } catch (e) {
      return null;
    }
  }

  function setLastFolder(folder) {
    try {
      if (folder) {
        localStorage.setItem(FOLDER_STORAGE_KEY, JSON.stringify({ id: folder.id, name: folder.name }));
      } else {
        localStorage.removeItem(FOLDER_STORAGE_KEY);
      }
    } catch (e) { /* stockage indisponible : le dossier ne sera pas mémorisé */ }
  }

  /* ---------- OUVRIR : sélecteur de fichiers Google ---------- */

  function acceptedExtensions(accept) {
    return String(accept || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.startsWith("."));
  }

  // choisirDossier = true : on ne montre que les dossiers et on en choisit un.
  function showPicker(token, choisirDossier) {
    return new Promise((resolve) => {
      const picker = window.google.picker;

      const monDrive = new picker.DocsView(choisirDossier ? picker.ViewId.FOLDERS : picker.ViewId.DOCS)
        .setParent("root")
        .setIncludeFolders(true)
        .setSelectFolderEnabled(!!choisirDossier)
        .setMode(picker.DocsViewMode.LIST);
      if (choisirDossier) monDrive.setMimeTypes(DRIVE_FOLDER_MIME);

      const built = new picker.PickerBuilder()
        .setAppId(DRIVE_APP_ID)
        .setOAuthToken(token)
        .setOrigin(location.protocol + "//" + location.host)
        .setLocale("fr")
        .setTitle(choisirDossier
          ? "Choisir le dossier où enregistrer (clique sur le dossier puis « Sélectionner »)"
          : "Choisir un fichier sur Google Drive")
        .addView(monDrive)
        .setCallback((data) => {
          if (data.action === picker.Action.PICKED) {
            resolve(data.docs && data.docs[0] ? data.docs[0] : null);
          } else if (data.action === picker.Action.CANCEL) {
            resolve(null);
          }
        })
        .build();

      built.setVisible(true);
    });
  }

  /**
   * Fait choisir un fichier sur le Drive et le renvoie sous forme de File
   * (même objet que celui d'un <input type="file">), ou null si annulé.
   */
  async function pickFile(accept) {
    try {
      const token = await getToken();
      await loadPicker();

      const doc = await showPicker(token);
      if (!doc) return null;

      const extensions = acceptedExtensions(accept);
      const name = doc.name || "fichier";
      if (extensions.length && !extensions.some((ext) => name.toLowerCase().endsWith(ext))) {
        alert("Ce fichier n'est pas du type attendu (" + extensions.join(", ") + ") : " + name);
        return null;
      }

      if (String(doc.mimeType || "").startsWith("application/vnd.google-apps")) {
        alert("Les documents Google (Docs, Sheets…) ne peuvent pas être ouverts ici : " + name);
        return null;
      }

      const res = await driveFetch(
        "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(doc.id) + "?alt=media"
      );
      const blob = await res.blob();
      return new File([blob], name, { type: blob.type || doc.mimeType || "" });
    } catch (err) {
      if (!err || !err.annule) {
        console.error("[DariushDrive] Erreur ouverture :", err);
        alert("Google Drive : " + (err && err.message ? err.message : String(err)));
      }
      return null;
    }
  }

  /* ---------- ENREGISTRER ---------- */

  // Petite fenêtre "Où enregistrer ?" : renvoie "last", "pick", "root" ou null.
  function askDestination(lastFolder) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;background:rgba(0,0,0,0.35);display:flex;" +
        "align-items:center;justify-content:center;z-index:99999;";

      const panel = document.createElement("div");
      panel.style.cssText =
        "background:white;padding:16px;border-radius:10px;min-width:340px;max-width:90vw;" +
        "box-shadow:0 10px 30px rgba(0,0,0,0.25);font-family:system-ui,sans-serif;";
      overlay.appendChild(panel);

      const title = document.createElement("div");
      title.textContent = "Où enregistrer sur Google Drive ?";
      title.style.cssText = "font-weight:bold;margin-bottom:12px;color:#111;";
      panel.appendChild(title);

      function close(value) {
        overlay.remove();
        resolve(value);
      }

      function addButton(label, value, alignRight) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.className = "nav-item";
        btn.style.cssText = alignRight
          ? "display:block;margin:12px 0 0 auto;"
          : "display:block;width:100%;text-align:left;margin:0 0 8px;";
        btn.addEventListener("click", () => close(value));
        panel.appendChild(btn);
      }

      if (lastFolder) addButton("Dans le dossier « " + lastFolder.name + " » (dernier utilisé)", "last");
      addButton(lastFolder ? "Choisir un autre dossier…" : "Choisir un dossier…", "pick");
      addButton("À la racine de « Mon Drive »", "root");
      addButton("Annuler", null, true);

      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) close(null);
      });

      document.body.appendChild(overlay);
    });
  }

  /**
   * Enregistre un fichier texte sur le Drive, dans le dossier choisi par
   * l'utilisateur (aucun dossier n'est créé).
   * Mêmes paramètres que saveTextFileAs (outils.js) : `contenu` peut être
   * une fonction (async), appelée seulement après la connexion.
   * Renvoie true si le fichier a été enregistré, false si annulé ou erreur.
   */
  async function saveText(contenu, { defaultName, extension, promptLabel }) {
    let folder = null; // null = racine de "Mon Drive"
    let reusedLastFolder = false;

    try {
      const token = await getToken();

      const text = typeof contenu === "function" ? await contenu() : contenu;
      if (text == null) return false;

      // 1. Où ?
      const lastFolder = getLastFolder();
      const destination = await askDestination(lastFolder);
      if (!destination) return false;

      if (destination === "last") {
        folder = lastFolder;
        reusedLastFolder = true;
      } else if (destination === "pick") {
        await loadPicker();
        const doc = await showPicker(token, true);
        if (!doc) return false;
        folder = { id: doc.id, name: doc.name || "dossier" };
      }
      const folderLabel = folder ? "dossier « " + folder.name + " »" : "racine de « Mon Drive »";

      // 2. Sous quel nom ?
      const saisie = prompt(
        (promptLabel || "Nom du fichier :") + "\n(Google Drive, " + folderLabel + ")",
        defaultName
      );
      if (saisie === null) return false;
      const filename = saisie.trim() || defaultName;
      const finalName = filename.toLowerCase().endsWith(extension.toLowerCase())
        ? filename
        : (filename + extension);

      // 3. Envoi (remplacement si Dariush a déjà créé ce fichier à cet endroit)
      const parentId = folder ? folder.id : "root";
      const existing = await findFirst(
        "name = " + quoteForQuery(finalName) +
        " and " + quoteForQuery(parentId) + " in parents and trashed = false"
      );

      if (existing) {
        if (!confirm("Le fichier « " + finalName + " » existe déjà à cet endroit. Le remplacer ?")) {
          return false;
        }
        await driveFetch(
          "https://www.googleapis.com/upload/drive/v3/files/" + encodeURIComponent(existing.id) + "?uploadType=media",
          { method: "PATCH", headers: { "Content-Type": "text/plain" }, body: text }
        );
      } else {
        const metadata = { name: finalName };
        if (folder) metadata.parents = [folder.id];

        const form = new FormData();
        form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
        form.append("file", new Blob([text], { type: "text/plain" }));
        await driveFetch(
          "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
          { method: "POST", body: form }
        );
      }

      if (folder) setLastFolder(folder);
      alert("Fichier enregistré sur Google Drive, " + folderLabel + " :\n" + finalName);
      return true;
    } catch (err) {
      if (err && err.annule) return false;

      console.error("[DariushDrive] Erreur enregistrement :", err);

      // Dossier mémorisé supprimé ou devenu inaccessible : on l'oublie.
      if (reusedLastFolder && err && (err.status === 404 || err.status === 403)) {
        setLastFolder(null);
        alert("Le dossier « " + folder.name + " » n'est plus accessible sur ton Drive. " +
          "Recommence l'enregistrement et choisis un dossier.");
        return false;
      }

      alert("Google Drive : " + (err && err.message ? err.message : String(err)));
      return false;
    }
  }

  /* ---------- Case à cocher près du titre des fenêtres ---------- */

  function attachCheckbox(titleEl) {
    if (!titleEl || !isAvailable()) return;

    titleEl.style.display = "flex";
    titleEl.style.alignItems = "center";
    titleEl.style.justifyContent = "space-between";
    titleEl.style.gap = "16px";

    const label = document.createElement("label");
    label.style.cssText =
      "display:inline-flex;align-items:center;gap:6px;font-weight:normal;" +
      "font-size:13px;color:#111;cursor:pointer;white-space:nowrap;";
    label.title = "Ouvrir / enregistrer directement sur ton Google Drive";

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = isEnabled();
    box.addEventListener("change", () => {
      setEnabled(box.checked);
      if (box.checked) preload();
    });

    label.appendChild(box);
    label.appendChild(document.createTextNode("☁ Google Drive"));
    titleEl.appendChild(label);

    if (box.checked) preload();
  }

  window.DariushDrive = { isAvailable, isEnabled, attachCheckbox, pickFile, saveText };
})();
