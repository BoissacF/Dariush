/* linuxAdmin.js — Administrateur de classe pour Dariush Linux

   Tant qu'une classe n'a pas d'administrateur, chaque personne qui y ouvre un
   terminal reçoit la question « Êtes-vous le professeur de cette classe ? ».
   Celle qui répond avec un code utilisateur valide (table prof_autorise)
   devient l'administrateur ; plus personne n'est interrogé ensuite.

   L'administrateur peut supprimer les dossiers de SA classe, et rien d'autre :
   - son terminal reste celui d'un élève (mêmes droits, même confinement) : il
     ne lit donc aucun fichier protégé par un élève ;
   - la suppression est faite par le serveur, uniquement dans la classe où il
     est connecté, et passe par la corbeille de linuxNettoyage.js (7 jours).

   Le rôle est noté dans serveur_eleves/.admins/<classe>.json, hors de portée
   des élèves, avec l'empreinte du mot de passe du compte. Si ce compte
   disparaît, ou est recréé par quelqu'un d'autre avec un autre mot de passe,
   la classe n'a plus d'administrateur et la question est de nouveau posée.

   Fichier autonome : server.js appelle init() une fois, puis apresConnexion()
   à chaque ouverture de terminal.
*/

const fs = require("fs");
const path = require("path");
const nettoyage = require("./linuxNettoyage");

// Le point est interdit dans un code classe : ce dossier ne peut pas en être un
const NOM_ADMINS = ".admins";

const MAX_DOSSIERS_AFFICHES = 500;
const MAX_DOSSIERS_PAR_CLASSE = 5000;
const TAILLE_MAX_EMPREINTE = 256;         // mot_de_passe.txt contient 64 caractères

let io = null;
let pool = null;
let baseDir = nettoyage.BASE_DIR;

/* ────────────────────────────────────────────
   REGISTRE DES ADMINISTRATEURS
──────────────────────────────────────────── */

function fichierAdmin(classe) {
  return path.join(baseDir, NOM_ADMINS, classe + ".json");
}

/* Contenu de mot_de_passe.txt du compte, ou null. Le fichier appartient à
   l'élève : on refuse tout ce qui n'est pas un petit fichier ordinaire (un
   lien symbolique vers /dev/zero bloquerait le serveur). */
function lireEmpreinte(classe, pseudo) {
  let fd = null;
  try {
    const compteDir = path.join(baseDir, classe, pseudo);
    if (!fs.lstatSync(compteDir).isDirectory()) return null;

    fd = fs.openSync(
      path.join(compteDir, "mot_de_passe.txt"),
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0)
    );
    const infos = fs.fstatSync(fd);
    if (!infos.isFile() || infos.size === 0 || infos.size > TAILLE_MAX_EMPREINTE) return null;

    const tampon = Buffer.alloc(infos.size);
    fs.readSync(fd, tampon, 0, infos.size, 0);
    return tampon.toString("utf8").trim() || null;
  } catch (err) {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (err) { /* déjà fermé */ }
    }
  }
}

/* Administrateur actuel de la classe, ou null. Une fiche qui ne correspond
   plus à un compte existant, avec le même mot de passe, est supprimée. */
function adminDeLaClasse(classe) {
  if (!nettoyage.NOM_VALIDE.test(classe)) return null;

  let fiche;
  try {
    fiche = JSON.parse(fs.readFileSync(fichierAdmin(classe), "utf8"));
  } catch (err) {
    return null;   // pas de fiche : pas d'administrateur
  }

  const valide = fiche
    && typeof fiche.pseudo === "string"
    && nettoyage.NOM_VALIDE.test(fiche.pseudo)
    && typeof fiche.empreinte === "string"
    && fiche.empreinte !== ""
    && lireEmpreinte(classe, fiche.pseudo) === fiche.empreinte;

  if (!valide) {
    try { fs.unlinkSync(fichierAdmin(classe)); } catch (err) { /* déjà supprimée */ }
    console.log("[linux-admin] Classe", classe, ": le compte administrateur n'existe plus, place libérée");
    return null;
  }
  return fiche;
}

/* Écrit la fiche d'un seul geste (fichier temporaire puis renommage), dans un
   dossier lisible par root seul. */
function enregistrerAdmin(classe, fiche) {
  const dossier = path.join(baseDir, NOM_ADMINS);
  fs.mkdirSync(dossier, { recursive: true, mode: 0o700 });
  const provisoire = fichierAdmin(classe) + ".tmp";
  fs.writeFileSync(provisoire, JSON.stringify(fiche, null, 2), { mode: 0o600 });
  fs.renameSync(provisoire, fichierAdmin(classe));
}

/* ────────────────────────────────────────────
   SESSIONS
──────────────────────────────────────────── */

/* Classe et pseudo du terminal ouvert sur ce socket, ou null. La classe vient
   toujours d'ici, jamais d'un message du navigateur : c'est ce qui empêche un
   administrateur d'agir hors de sa classe. */
function sessionDe(socket) {
  const session = socket.linuxAdminSession;
  if (!session || !socket.linuxPty || session.pty !== socket.linuxPty) return null;
  return session;
}

function socketsOuverts() {
  if (!io || !io.sockets || !io.sockets.sockets) return [];
  return Array.from(io.sockets.sockets.values());
}

function estConnecte(classe, pseudo) {
  return socketsOuverts().some((s) => {
    const session = sessionDe(s);
    return session && session.classe === classe && session.pseudo === pseudo;
  });
}

/* Dit au navigateur quel est son rôle et s'il doit poser la question. */
function envoyerEtat(socket) {
  const session = sessionDe(socket);
  if (!session) return;

  const admin = adminDeLaClasse(session.classe);
  socket.emit("linux_admin_etat", {
    classe: session.classe,
    role: admin && admin.pseudo === session.pseudo ? "admin" : "eleve",
    question: !admin
  });
}

/* Appelé par server.js juste après "linux_ready". Ne lève jamais d'erreur :
   un problème ici ne doit pas empêcher le terminal de s'ouvrir. */
function apresConnexion(socket, classe, pseudo, pty) {
  try {
    const session = { classe, pseudo, pty };
    socket.linuxAdminSession = session;

    pty.onExit(() => {
      if (socket.linuxAdminSession === session) socket.linuxAdminSession = null;
    });

    envoyerEtat(socket);
  } catch (err) {
    console.warn("[linux-admin] apresConnexion :", err.message);
  }
}

/* ────────────────────────────────────────────
   DEVENIR ADMINISTRATEUR
──────────────────────────────────────────── */

/* Le nombre d'essais n'est volontairement pas limité : un blocage par classe
   permettrait à un élève d'empêcher son professeur de devenir administrateur. */
async function devenirAdmin(socket, donnees) {
  const repondre = (ok, message) => socket.emit("linux_admin_reponse", { ok, message });

  const session = sessionDe(socket);
  if (!session) return repondre(false, "Ouvrez d'abord votre terminal.");

  const { classe, pseudo } = session;
  const code = donnees && typeof donnees.code === "string" ? donnees.code.trim() : "";
  if (code === "" || code.length > 100) return repondre(false, "Entrez votre code utilisateur.");

  if (adminDeLaClasse(classe)) {
    envoyerEtat(socket);
    return repondre(false, "Cette classe a déjà un administrateur.");
  }

  let prof;
  try {
    const [lignes] = await pool.query(
      "SELECT id, nom, prenom FROM prof_autorise WHERE code_utilisateur = ? LIMIT 1",
      [code]
    );
    prof = lignes[0];
  } catch (err) {
    console.warn("[linux-admin] Vérification du code impossible :", err.message);
    return repondre(false, "Vérification impossible pour le moment. Réessayez plus tard.");
  }

  if (!prof) {
    console.log("[linux-admin] Code refusé dans la classe", classe, "par", pseudo);
    return repondre(false, "Code utilisateur non reconnu.");
  }

  // La base a répondu après un délai : la situation a pu changer entre-temps
  if (sessionDe(socket) !== session) return repondre(false, "Votre terminal s'est fermé. Reconnectez-vous.");
  if (adminDeLaClasse(classe)) {
    envoyerEtat(socket);
    return repondre(false, "Cette classe vient de recevoir un administrateur.");
  }

  const empreinte = lireEmpreinte(classe, pseudo);
  if (!empreinte) return repondre(false, "Compte introuvable. Déconnectez-vous puis reconnectez-vous.");

  try {
    enregistrerAdmin(classe, {
      pseudo,
      empreinte,
      profId: prof.id,
      profNom: ((prof.prenom || "") + " " + (prof.nom || "")).trim(),
      depuis: new Date().toISOString()
    });
  } catch (err) {
    console.warn("[linux-admin] Enregistrement impossible :", err.message);
    return repondre(false, "Enregistrement impossible. Réessayez plus tard.");
  }

  console.log("[linux-admin] Classe", classe, ": administrateur =", pseudo, "(professeur n°" + prof.id + ")");
  repondre(true, "Vous êtes l'administrateur de la classe " + classe + ".");

  // Toute la classe est prévenue : la question disparaît chez les autres
  for (const s of socketsOuverts()) {
    const autre = sessionDe(s);
    if (autre && autre.classe === classe) envoyerEtat(s);
  }
}

/* ────────────────────────────────────────────
   LISTER ET SUPPRIMER LES DOSSIERS DE LA CLASSE
──────────────────────────────────────────── */

/* Session du socket si c'est bien l'administrateur de sa classe, sinon null. */
function sessionAdmin(socket) {
  const session = sessionDe(socket);
  if (!session) return null;
  const admin = adminDeLaClasse(session.classe);
  return admin && admin.pseudo === session.pseudo ? session : null;
}

/* Tout ce que contient la classe, sauf le dossier de l'administrateur.
   Renvoie null si la classe est trop grosse pour être listée. */
function nomsDeLaClasse(session) {
  const noms = nettoyage.listerNoms(path.join(baseDir, session.classe), MAX_DOSSIERS_PAR_CLASSE);
  if (noms === null) return null;
  return noms.filter((nom) => nom !== session.pseudo);
}

function decrire(session, nom) {
  const chemin = path.join(baseDir, session.classe, nom);
  let type = "fichier";
  try {
    const infos = fs.lstatSync(chemin);
    if (infos.isDirectory()) {
      type = "dossier";
      try {
        if (fs.lstatSync(path.join(chemin, "mot_de_passe.txt")).isFile()) type = "compte";
      } catch (err) { /* pas de mot_de_passe.txt : simple dossier */ }
    } else if (infos.isSymbolicLink()) {
      type = "lien";
    }
  } catch (err) {
    return null;   // supprimé entre-temps
  }
  return { nom, type, connecte: type === "compte" && estConnecte(session.classe, nom) };
}

function lister(socket) {
  const session = sessionAdmin(socket);
  if (!session) return socket.emit("linux_admin_liste", { ok: false, message: "Réservé à l'administrateur de la classe." });

  let noms;
  try {
    noms = nomsDeLaClasse(session);
  } catch (err) {
    return socket.emit("linux_admin_liste", { ok: false, message: "Lecture de la classe impossible." });
  }
  if (noms === null) {
    return socket.emit("linux_admin_liste", { ok: false, message: "Cette classe contient trop d'éléments pour être affichée." });
  }

  const ordre = { compte: 0, dossier: 1, fichier: 2, lien: 3 };
  const dossiers = noms
    .slice(0, MAX_DOSSIERS_AFFICHES)
    .map((nom) => decrire(session, nom))
    .filter(Boolean)
    .sort((a, b) => ordre[a.type] - ordre[b.type] || a.nom.localeCompare(b.nom));

  socket.emit("linux_admin_liste", {
    ok: true,
    classe: session.classe,
    dossiers,
    total: noms.length
  });
}

/* Retire un élément de la classe : supprimé s'il est vide, sinon déplacé dans
   la corbeille. Le nom doit désigner un élément placé directement dans la
   classe : aucun chemin, aucun retour en arrière. */
function retirer(session, nom, maintenant) {
  if (typeof nom !== "string" || nom === "" || nom === "." || nom === ".."
      || nom.includes("\0") || path.basename(nom) !== nom || nom === session.pseudo) {
    return false;
  }

  const classeDir = path.join(baseDir, session.classe);
  const chemin = path.join(classeDir, nom);
  if (path.dirname(chemin) !== classeDir) return false;

  try {
    fs.lstatSync(chemin);
  } catch (err) {
    return false;   // déjà supprimé
  }

  const corbeille = path.join(baseDir, nettoyage.NOM_CORBEILLE);
  const etiquette = nettoyage.nomSur(session.classe) + "." + nettoyage.nomSur(nom);
  const retire = nettoyage.supprimerSiVide(chemin)
              || nettoyage.mettreALaCorbeille(chemin, etiquette, corbeille, maintenant);
  if (!retire) return false;

  // Le terminal d'un élève supprimé pendant qu'il travaille se ferme
  for (const s of socketsOuverts()) {
    const autre = sessionDe(s);
    if (autre && autre.classe === session.classe && autre.pseudo === nom) {
      try { s.linuxPty.kill(); } catch (err) { /* déjà fermé */ }
    }
  }
  return true;
}

function supprimer(socket, donnees) {
  const session = sessionAdmin(socket);
  if (!session) return socket.emit("linux_admin_suppression", { ok: false, message: "Réservé à l'administrateur de la classe." });

  let noms;
  try {
    if (donnees && donnees.tout === true) {
      noms = nomsDeLaClasse(session);
    } else if (donnees && Array.isArray(donnees.noms)) {
      noms = donnees.noms.slice(0, MAX_DOSSIERS_PAR_CLASSE);
    }
  } catch (err) {
    noms = undefined;
  }
  if (!noms) return socket.emit("linux_admin_suppression", { ok: false, message: "Suppression impossible." });

  const maintenant = Date.now();
  let supprimes = 0;
  let echecs = 0;
  for (const nom of noms) {
    if (retirer(session, nom, maintenant)) supprimes++; else echecs++;
  }

  console.log("[linux-admin] Classe", session.classe, ":", session.pseudo, "a supprimé", supprimes, "élément(s),", echecs, "échec(s)");
  socket.emit("linux_admin_suppression", { ok: true, supprimes, echecs });
  lister(socket);
}

/* ────────────────────────────────────────────
   BRANCHEMENT
──────────────────────────────────────────── */

/* options.baseDir n'est passé que par les tests. */
function init(options) {
  io = options.io;
  pool = options.pool;
  if (options.baseDir) baseDir = options.baseDir;

  // Bloc de connexion séparé, comme pour l'aide Linux : celui de server.js
  // n'est pas touché
  io.on("connection", (socket) => {
    const proteger = (nom, action) => {
      socket.on(nom, (donnees) => {
        Promise.resolve()
          .then(() => action(socket, donnees))
          .catch((err) => console.warn("[linux-admin]", nom, ":", err.message));
      });
    };

    proteger("linux_admin_devenir", devenirAdmin);
    proteger("linux_admin_lister", lister);
    proteger("linux_admin_supprimer", supprimer);
  });

  console.log("[linux-admin] Activé : un administrateur par classe, désigné par son code utilisateur");
}

module.exports = {
  init,
  apresConnexion
};
