# Dariush

**Un environnement de programmation en ligne pour la classe : Python, SQL et Linux
dans le navigateur, sans rien installer.**

Dariush est une suite de trois applications web pensées pour l'enseignement de la
NSI, de la SNT et de l'informatique en BTS. L'élève ouvre une page, écrit son code
et l'exécute ; le professeur prépare des notebooks d'exercices, les partage par un
simple lien, suit le travail de la classe en direct et aide un élève à distance.

👉 **Utiliser Dariush : <https://physalgo.fr/Dariush/>**

| Application | Adresse | En bref |
|---|---|---|
| Dariush Python | <https://physalgo.fr/Dariush_Python/> | Notebook Python exécuté dans le navigateur |
| Dariush SQL | <https://physalgo.fr/Dariush_SQL/> | Notebook SQL sur une base SQLite locale |
| Dariush Linux | <https://physalgo.fr/Dariush_Linux/> | Vrai terminal Linux, isolé par élève |

L'usage est libre et gratuit. Aucun compte n'est nécessaire pour programmer.

---

## Sommaire

- [Ce que permet Dariush](#ce-que-permet-dariush)
- [Les trois applications](#les-trois-applications)
- [Pour le professeur](#pour-le-professeur)
- [Données personnelles](#données-personnelles)
- [Architecture technique](#architecture-technique)
- [Organisation du dépôt](#organisation-du-dépôt)
- [Installer sa propre instance](#installer-sa-propre-instance)
- [Auteur, contact et licence](#auteur-contact-et-licence)

---

## Ce que permet Dariush

- **Programmer sans installation.** Python tourne dans le navigateur de l'élève
  (Pyodide), SQL aussi (SQLite compilé en WebAssembly). Un poste du lycée, une
  tablette ou l'ordinateur de la maison suffisent.
- **Travailler en notebook.** Un document est une suite de pages ; chaque page
  associe un ou plusieurs blocs de texte (Markdown, formules LaTeX, images,
  schémas Mermaid) à une zone de code exécutable.
- **Partager par un lien.** Un notebook entier tient dans une adresse web, ou
  dans un lien court. On peut choisir la date à partir de laquelle le lien
  devient accessible.
- **Mutualiser des exercices.** Une banque d'exercices classés par niveau
  (débutant, première, terminale, sujets de bac, supérieur…) est alimentée par
  les professeurs et consultable par tous. Un corrigé peut être associé à un
  exercice et réservé aux enseignants.
- **Travailler en groupe en temps réel.** Le professeur et ses élèves partagent
  le même code, avec un tchat et une liaison audio ; le professeur décide qui
  peut écrire.
- **Aider un élève à distance.** L'élève demande de l'aide, entre dans une file
  d'attente, et le professeur prend la main sur son code ou son terminal.
- **S'appuyer sur une IA, de façon encadrée.** Un assistant explique le cours
  sans faire l'exercice à la place de l'élève. Le professeur peut utiliser sa
  propre clé (OpenAI, Anthropic, Mistral, Groq, DeepSeek…).

## Les trois applications

### Dariush Python

- Éditeur avec coloration syntaxique, exécution page par page ou de tout le
  notebook d'un coup. Maj+Entrée exécute la cellule active, comme dans Jupyter.
- **Débogueur pas à pas** : variables, pile d'appels, valeur renvoyée, retour en
  arrière.
- Correcteur des erreurs de syntaxe les plus fréquentes chez les débutants
  (deux-points oubliés, `=` à la place de `==`, indentation…).
- Graphiques et images produits par le code, affichés dans la page.
- Import de fichiers `.py`, `.ipynb` et **de sujets PDF**, découpés en cellules
  de texte et de code.
- Export du notebook en PDF.
- Éditeur de graphes (sommets et arêtes) pour illustrer un énoncé ou générer le
  code Python correspondant.
- **Version portable** sur clé USB, utilisable hors ligne.

### Dariush SQL

- Requêtes exécutées sur une base SQLite qui vit dans le navigateur.
- Les tables persistent d'une page à l'autre du notebook.
- Import et export d'une base `.db`.

### Dariush Linux

- Chaque élève obtient un vrai shell, dans un conteneur Docker isolé.
- Les élèves se connectent avec un code de classe, un prénom et un mot de passe
  qu'ils choisissent à la première connexion.
- Leurs fichiers sont conservés d'une séance à l'autre. Un compte resté inactif
  30 jours est supprimé automatiquement.
- Le professeur peut devenir administrateur de sa classe et supprimer les
  comptes qui n'ont plus lieu d'être.

## Pour le professeur

- **Déposer un exercice** dans la banque, le modifier, le supprimer, lui
  associer un corrigé.
- **Restreindre un lien** : accès réservé aux enseignants, ou aux élèves munis
  d'un mot de passe provisoire.
- **Générer un sujet** à partir des exercices existants, selon un thème, un
  niveau et une difficulté.
- **Ouvrir et enregistrer sur Google Drive** en plus du disque local.

Le dépôt d'exercices et les liens restreints demandent un code utilisateur,
attribué sur simple demande à l'auteur.

## Données personnelles

Dariush ne demande ni nom ni adresse électronique aux élèves. Le code et les
notebooks restent dans le navigateur tant qu'ils ne sont pas partagés
volontairement. Le détail figure dans la
[page de confidentialité](https://physalgo.fr/Dariush/confidentialite.html).

---

## Architecture technique

| Couche | Technologies |
|---|---|
| Interface | JavaScript sans framework, CodeMirror 5, markdown-it, KaTeX, Mermaid, pako |
| Exécution Python | Pyodide, dans un Web Worker |
| Exécution SQL | sql.js (SQLite en WebAssembly) |
| Terminal Linux | xterm.js côté navigateur, conteneurs Docker (Alpine) côté serveur |
| Serveur PHP | Banque d'exercices, liens courts, codes utilisateurs, relais vers les IA |
| Serveur Node.js | Express et Socket.IO : groupe, aide individuelle, audio WebRTC, terminaux |
| Base de données | MySQL |

Les trois applications partagent le même socle (`Dariush_Commun/version3/`) :
gestion des pages, Markdown, images, sauvegarde, partage, travail en groupe,
aide et panneau IA. Chacune n'ajoute que son moteur d'exécution.

Le code des élèves s'exécute sur leur propre machine pour Python et SQL : le
serveur ne reçoit que ce qui est partagé (liens, exercices, séances de groupe).
Seul Dariush Linux exécute des commandes côté serveur, dans des conteneurs
jetables dont le nombre est plafonné.

## Organisation du dépôt

| Dossier | Rôle |
|---|---|
| `Dariush/` | Page d'accueil et page de confidentialité |
| `Dariush_Python/` | Application Python (`cssjs45/` : interpréteur, worker, débogueur, correcteur) |
| `Dariush_SQL/` | Application SQL (`cssjs_sql/`) |
| `Dariush_Linux/` | Application Linux (`cssjs_linux3/`) |
| `Dariush_Code_Graphe/` | Éditeur de graphes, ouvert dans un cadre intégré |
| `Dariush_Commun/version3/` | JavaScript et CSS communs aux trois applications |
| `Dariush_Commun/*.php` | Points d'entrée PHP (exercices, liens courts, mots de passe) |
| `Dariush_Commun/api/` | Relais vers les fournisseurs d'IA et génération de sujets |
| `Dariush_Commun/fichiersannexes/` | Bibliothèques tierces embarquées |
| `Dariush-node/` | Serveur temps réel (`server.js`) et ses modules pour Dariush Linux : limiteur de conteneurs (`linuxLimiter.js`), suppression des comptes inactifs (`linuxNettoyage.js`), administrateur de classe (`linuxAdmin.js`), image des conteneurs (`Dockerfile`) |

Ne sont pas versionnés : les vidéos d'aide, la distribution Pyodide et
l'archive de la version portable (trop volumineuses), ainsi que les fichiers
`.env`.

Le générateur d'images de graphes `DariushGraphes`, appelé depuis le même
panneau que l'éditeur de graphes, est un outil distinct qui ne fait pas partie
de ce dépôt.

## Installer sa propre instance

Dariush est d'abord un service en ligne : l'utiliser ne demande aucune
installation. Les indications ci-dessous s'adressent à qui voudrait héberger sa
propre copie.

**Prérequis** : un serveur web avec PHP et MySQL, Node.js pour le temps réel,
et Docker pour Dariush Linux.

1. **Fichiers web.** Placer les dossiers `Dariush*` côte à côte à la racine du
   site. En ligne, Pyodide est chargé depuis un CDN ; une copie locale dans
   `Dariush_Commun/fichiersannexes/pyodide/` n'est nécessaire que pour la
   version portable, hors ligne.
2. **Secrets PHP.** Copier `.env.exemple` en `.env`, **un niveau au-dessus de la
   racine web**, et le compléter (accès MySQL, clés d'IA, jeton d'administration).
   `Dariush_Commun/secrets.php` le lit ; aucun identifiant n'est écrit dans le code.
3. **Serveur Node.**
   ```bash
   cd Dariush-node
   npm install
   node server.js
   ```
   Ses identifiants MySQL se lisent dans un `.env` placé à côté de `server.js`
   (les clés `DB_*` de `.env.exemple`). La dépendance `node-pty` se compile à
   l'installation : il faut Python, `make` et un compilateur C++ sur le serveur.
4. **Image Docker** de Dariush Linux :
   ```bash
   docker build -t dariush-linux Dariush-node/
   ```
5. **Adresses.** La bascule entre un serveur local et la production se fait par
   la variable `mode_Local`, en tête de
   `Dariush_Commun/version3/SOCKET_connexion.js`.

Deux limites à connaître avant de se lancer : le schéma de la base MySQL n'est
pas encore fourni dans le dépôt, et plusieurs adresses pointent en dur vers
`physalgo.fr` ; elles sont à adapter au nouveau domaine.

## Auteur, contact et licence

Dariush est développé par **Frédéric Boissac**, professeur.

- Contact : <prof.boissac@gmail.com>
- Un bogue, une idée, une demande de code utilisateur : ouvrir un ticket sur ce
  dépôt ou écrire à l'adresse ci-dessus.

### Licence

Copyright © 2026 Frédéric Boissac

Dariush est un logiciel libre, distribué sous la licence
[GNU Affero General Public License, version 3](LICENSE) (AGPL-3.0). Vous pouvez
l'utiliser, l'étudier, le modifier et le redistribuer. En contrepartie, toute
version modifiée, y compris proposée comme service en ligne, doit rester sous
cette même licence, avec son code source accessible à ses utilisateurs et la
mention de l'auteur conservée.

Les bibliothèques tierces embarquées restent sous leurs licences respectives.

Dariush s'appuie sur des logiciels libres, que leurs auteurs soient remerciés :
[Pyodide](https://pyodide.org), [CodeMirror](https://codemirror.net),
[sql.js](https://sql.js.org), [xterm.js](https://xtermjs.org),
[markdown-it](https://github.com/markdown-it/markdown-it),
[KaTeX](https://katex.org), [Mermaid](https://mermaid.js.org),
[pako](https://github.com/nodeca/pako), [Socket.IO](https://socket.io).
