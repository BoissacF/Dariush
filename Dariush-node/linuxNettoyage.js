/* linuxNettoyage.js — Suppression automatique des comptes Linux inactifs

   Une fois par jour :
   1. dans chaque classe, tout dossier où rien n'a bougé depuis 30 jours (ni
      connexion, ni fichier modifié) est déplacé dans la corbeille, ou
      supprimé directement s'il est vide ;
   2. une classe devenue vide est supprimée ;
   3. ce qui est dans la corbeille depuis 7 jours est supprimé définitivement.

   La règle est la même pour le dossier d'un compte (serveur_eleves/<classe>/
   <pseudo>/) et pour un dossier qu'un élève a créé lui-même dans sa classe.
   server.js inscrit la date de chaque connexion réussie sur le dossier du
   compte (handler "linux_connect") : c'est elle qui garde un compte en vie
   même si l'élève ne modifie aucun fichier.

   Rien n'est modifié dans ce qui est conservé : ni droits, ni propriétaires,
   ni dates de modification (seule la date d'accès d'un dossier parcouru peut
   bouger, comme après un ls). Les fichiers des élèves ne sont jamais ouverts,
   et aucun lien symbolique n'est suivi pour déplacer ou supprimer.

   Récupérer un compte dans les 7 jours, en SSH :
     cd /home/physalgo/htdocs/physalgo.fr/Dariush_Linux/serveur_eleves
     ls -a .corbeille
     mkdir -p 1234 && mv .corbeille/2026-10-06_21h30m00.1234.toto 1234/toto
*/

const fs = require("fs");
const path = require("path");
const execFile = require("util").promisify(require("child_process").execFile);

// Même chemin que baseDir dans server.js (handler "linux_connect")
const BASE_DIR = "/home/physalgo/htdocs/physalgo.fr/Dariush_Linux/serveur_eleves";

const JOUR_MS = 24 * 60 * 60 * 1000;
const DELAI_INACTIVITE_MS = 30 * JOUR_MS;  // rien n'a bougé depuis 30 jours → corbeille
const DELAI_CORBEILLE_MS  = 7 * JOUR_MS;   // 7 jours dans la corbeille → suppression définitive
const INTERVALLE_MS       = JOUR_MS;       // une passe par jour
const PREMIERE_PASSE_MS   = 60 * 1000;     // première passe 1 minute après le démarrage

// Le point est interdit dans un code classe : ce dossier ne peut pas en être un
const NOM_CORBEILLE = ".corbeille";
// Même règle que dans "linux_connect" pour le code classe
const NOM_VALIDE = /^[a-zA-Z0-9_-]+$/;
// Garde-fous : un dossier rempli de millions de fichiers ne doit ni bloquer
// ni faire tomber le serveur
const MAX_ENTREES_EXAMINEES = 20000;
const MAX_ENTREES_PAR_CLASSE = 50000;

let passeEnCours = false;

/* Noms contenus dans un dossier, sans jamais en charger plus de `max` en
   mémoire. Renvoie null s'il y en a davantage. */
function listerNoms(dossier, max) {
  const noms = [];
  const dir = fs.opendirSync(dossier);
  try {
    let entree;
    while ((entree = dir.readSync()) !== null) {
      if (noms.length >= max) return null;
      noms.push(entree.name);
    }
  } finally {
    dir.closeSync();
  }
  return noms;
}

/* Vrai si le dossier, ou n'importe quoi dedans, a été modifié depuis `seuil`.
   S'arrête à la première trace récente : un compte actif coûte une seule
   lecture. Une date dans le futur (touch -d) ne compte pas, sinon un élève
   rendrait son compte éternel. Ne lit que les dates : aucun fichier n'est
   ouvert, aucun lien symbolique n'est suivi. */
function contientDuRecent(racine, seuil, maintenant) {
  const aExaminer = [racine];
  let examinees = 0;

  while (aExaminer.length > 0) {
    const chemin = aExaminer.pop();

    let infos;
    try {
      infos = fs.lstatSync(chemin);
    } catch (err) {
      continue;  // supprimé entre-temps par l'élève
    }

    if (infos.mtimeMs >= seuil && infos.mtimeMs <= maintenant + JOUR_MS) return true;
    if (!infos.isDirectory()) continue;

    let noms;
    try {
      noms = listerNoms(chemin, MAX_ENTREES_EXAMINEES - examinees);
    } catch (err) {
      continue;
    }
    // Trop gros pour être examiné en entier : jugé sur ce qui est déjà en attente
    if (noms === null) continue;

    examinees += noms.length;
    for (const nom of noms) aExaminer.push(path.join(chemin, nom));
  }

  return false;
}

/* Nom rendu sûr pour la corbeille : dans sa classe, un élève peut créer un
   dossier au nom quelconque (espaces, accents, très long). */
function nomSur(nom) {
  return nom.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

/* Date et heure locales, lisibles dans un ls : 2026-10-06_21h30m00 */
function horodatage(ms) {
  const d = new Date(ms);
  const deux = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + deux(d.getMonth() + 1) + "-" + deux(d.getDate())
       + "_" + deux(d.getHours()) + "h" + deux(d.getMinutes()) + "m" + deux(d.getSeconds());
}

/* Date de mise à la corbeille, relue dans le nom. NaN si le nom n'a pas été
   fabriqué par ce fichier : l'entrée est alors laissée intacte. */
function dateDeMiseALaCorbeille(nom) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})h(\d{2})m(\d{2})\./.exec(nom);
  if (!m) return NaN;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

/* Déplace un dossier d'élève dans la corbeille, d'un seul geste : droits,
   propriétaires et dates sont conservés tels quels, ce qui permet de le
   remettre en place à l'identique. Un lien symbolique est déplacé lui-même,
   jamais sa cible. */
function mettreALaCorbeille(chemin, etiquette, corbeille, maintenant) {
  const destination = path.join(corbeille, horodatage(maintenant) + "." + etiquette);
  try {
    // 0700 : la corbeille n'est lisible que par root
    fs.mkdirSync(corbeille, { recursive: true, mode: 0o700 });
    fs.renameSync(chemin, destination);
    console.log("[linux-nettoyage] Mis à la corbeille :", etiquette);
    return true;
  } catch (err) {
    console.warn("[linux-nettoyage] Impossible de déplacer", etiquette, ":", err.message);
    return false;
  }
}

/* Supprime un dossier s'il est vide et renvoie vrai ; sinon ne touche à rien.
   rmdir refuse tout ce qui n'est pas un dossier vide (dossier rempli, fichier,
   lien symbolique) : rien ne peut être perdu ici. */
function supprimerSiVide(chemin) {
  try {
    fs.rmdirSync(chemin);
    return true;
  } catch (err) {
    return false;
  }
}

/* Traite une classe : tout ce qu'elle contient et où rien n'a bougé depuis
   30 jours est supprimé (dossier vide) ou part à la corbeille, puis la classe
   elle-même est supprimée si elle est vide. */
function nettoyerClasse(classe, baseDir, corbeille, maintenant, bilan) {
  const classeDir = path.join(baseDir, classe);
  const seuil = maintenant - DELAI_INACTIVITE_MS;

  const noms = listerNoms(classeDir, MAX_ENTREES_PAR_CLASSE);
  if (noms === null) {
    console.warn("[linux-nettoyage] Classe ignorée (trop d'entrées) :", classe);
    return;
  }

  let restants = 0;

  for (const nom of noms) {
    const chemin = path.join(classeDir, nom);
    const etiquette = nomSur(classe) + "." + nomSur(nom);

    if (contientDuRecent(chemin, seuil, maintenant)) {
      restants++;
      bilan.conserves++;
    } else if (supprimerSiVide(chemin)) {
      // Rien à récupérer dans un dossier vide : pas de passage par la corbeille
      bilan.videsSupprimes++;
    } else if (mettreALaCorbeille(chemin, etiquette, corbeille, maintenant)) {
      bilan.deplaces++;
    } else {
      restants++;
    }
  }

  if (restants > 0) return;

  if (supprimerSiVide(classeDir)) {
    bilan.classesSupprimees++;
    console.log("[linux-nettoyage] Classe vide supprimée :", classe);
  } else {
    console.warn("[linux-nettoyage] Classe non supprimée :", classe);
  }
}

/* Supprime définitivement ce qui est dans la corbeille depuis 7 jours.
   La commande rm du système ne suit aucun lien symbolique et tourne en
   dehors de Node : le serveur n'est pas bloqué pendant la suppression. */
async function viderCorbeille(corbeille, maintenant, bilan) {
  if (!fs.existsSync(corbeille)) return;

  const perimes = [];
  for (const nom of fs.readdirSync(corbeille)) {
    const date = dateDeMiseALaCorbeille(nom);
    if (isNaN(date) || maintenant - date < DELAI_CORBEILLE_MS) continue;
    perimes.push(path.join(corbeille, nom));
  }

  // Par lots, l'un après l'autre : une seule commande rm à la fois
  for (let i = 0; i < perimes.length; i += 100) {
    const lot = perimes.slice(i, i + 100);
    try {
      await execFile("rm", ["-rf", "--", ...lot]);
      bilan.supprimes += lot.length;
    } catch (err) {
      console.warn("[linux-nettoyage] Suppression définitive échouée :", err.message);
    }
  }
}

/* Une passe complète. `maintenant` et `baseDir` ne sont passés que par les
   tests ; le serveur appelle nettoyer() sans argument. */
async function nettoyer(maintenant = Date.now(), baseDir = BASE_DIR) {
  const bilan = { conserves: 0, deplaces: 0, videsSupprimes: 0, classesSupprimees: 0, supprimes: 0 };

  if (passeEnCours) return bilan;
  passeEnCours = true;

  try {
    if (!fs.existsSync(baseDir)) {
      console.log("[linux-nettoyage] Dossier absent, rien à nettoyer :", baseDir);
      return bilan;
    }

    const corbeille = path.join(baseDir, NOM_CORBEILLE);

    for (const classe of fs.readdirSync(baseDir)) {
      if (!NOM_VALIDE.test(classe)) continue;  // ignore la corbeille et tout fichier étranger
      try {
        if (!fs.lstatSync(path.join(baseDir, classe)).isDirectory()) continue;
        nettoyerClasse(classe, baseDir, corbeille, maintenant, bilan);
      } catch (err) {
        console.warn("[linux-nettoyage] Classe ignorée", classe, ":", err.message);
      }
    }

    await viderCorbeille(corbeille, maintenant, bilan);

    console.log(
      "[linux-nettoyage] Passe terminée :",
      bilan.conserves, "dossiers conservés,",
      bilan.deplaces, "mis à la corbeille,",
      bilan.videsSupprimes, "dossiers vides et", bilan.classesSupprimees, "classes vides supprimés,",
      bilan.supprimes, "éléments de la corbeille supprimés définitivement"
    );
    return bilan;
  } finally {
    passeEnCours = false;
  }
}

function init() {
  const passe = () => {
    nettoyer().catch((err) => {
      console.warn("[linux-nettoyage] Passe échouée :", err.message);
    });
  };

  setTimeout(passe, PREMIERE_PASSE_MS);
  setInterval(passe, INTERVALLE_MS);
  console.log("[linux-nettoyage] Activé : 30 jours sans activité → corbeille, vidée au bout de 7 jours");
}

module.exports = {
  init,
  nettoyer,
  // Réutilisés par linuxAdmin.js, pour qu'une suppression demandée par
  // l'administrateur d'une classe passe par la même corbeille
  BASE_DIR,
  NOM_CORBEILLE,
  NOM_VALIDE,
  listerNoms,
  nomSur,
  supprimerSiVide,
  mettreALaCorbeille
};
