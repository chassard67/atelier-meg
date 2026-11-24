# Atelier MEG — extension Chrome

Outils pour **Mon Expert en Gestion** (mon-expert-en-gestion.fr), diffusés sous forme d'**extension Chrome
installée en mode développeur**, avec **mise à jour automatique des modules** sans réinstallation.
Même mécanique que l'extension Atelier MyUnisoft.

## Fonctionnalités

| Module | Rôle |
|---|---|
| `achats-telechargement` | Page **Achats** : aperçu du PDF au survol de la colonne « Nom du fichier ». Bouton **« ⬇ Télécharger les factures »** (ou **« Télécharger la sélection (n) »** si des cases sont cochées : seules celles-là sont traitées). Pour chaque facture *non réglée* (ou partiellement réglée) : télécharge le PDF dans `Téléchargements\<Société>\Fournisseur - JJ-MM-AAAA - N°.pdf` (suffixe ` (1)` si le nom existe déjà), puis la passe en **Réglé**, mode **Téléchargé**, date du jour. La facture n'est passée en réglé qu'une fois le fichier réellement écrit. |
| (affichage) | Page Achats : **« Affichage personnalisé LGA »** (par défaut, mémorisé dans Chrome) — colonnes Affectation, Liaison bancaire, Compte comptable, Source, Date d'import masquées ; boutons Exporter / Importer / ⋮, cartes de statistiques et filtres (sauf Rechercher) masqués ; statuts « Non téléchargé / Téléchargé », onglets « À télécharger / Téléchargé », colonne **« Téléchargé par »** (dernier utilisateur ayant passé la facture en Réglé, d'après le journal des évènements). **« Affichage classique »** = MEG d'origine, sans aucun ajout. |
| `compteurs-dossiers` | Liste déroulante des dossiers (en-tête MEG) : nombre de factures à télécharger à côté de chaque dossier, sans les ouvrir (`statistiques-liste-achats` avec `X-IdEntreprise` du dossier, 6 en parallèle, cache 15 min, ↻ pour recompter). Affichage LGA uniquement. |
| `socle` | Versions dans la console, fenêtre « mise à jour activée ». |

**Mode de règlement *Téléchargé*** : s'il manque dans le dossier, le module propose de le créer
(Paramètres → Listes par défaut → Modes de règlement : code `TELECHARGE`, libellé `Téléchargé`, délai 0, type Virement,
compte comptable `99999999`).

Les factures **planifiées** (paiement programmé) ne sont pas traitées.

## Principe

```
push sur main ──► GitHub Actions (node tools/build.mjs --zip) ──► GitHub Pages
                   https://chassard67.github.io/atelier-meg/ : manifest.json + modules + zip
                                       │ au démarrage, toutes les 30 min, bouton « Vérifier »
                                       ▼
  Chrome : la coquille télécharge, vérifie (SHA-256), met en cache et injecte les modules
  via chrome.userScripts (contexte de la page).
```

- **Modifier un module** = éditer `scripts/xxx.js`, incrémenter `@version` + CHANGELOG, `git push`.
- **Modifier la coquille** (`extension/`) = rare ; les utilisateurs retéléchargent le zip.

## Mises à jour sans intervention (extension ≥ 2.0.0)

La coquille (`extension/`) est conçue pour ne plus changer : tout passe par les modules publiés.

- **Capacités génériques** offertes aux modules : `ATM.http` (tout hôte déclaré par `@connect`, réponses texte, JSON ou
  binaire base64, cookies en option), `ATM.download` (data: ou https:, nom et sous-dossier imposés), `ATM.chrome(api, …)`
  (downloads.*, tabs.*, windows.*, notifications.* — liste : `ATM.info()`), stockage, notes de version.
- **Nouveaux sites** : un `@match` dans un module suffit (droits d'hôte larges + pont injecté dynamiquement).
- **Réglages distants** (`publish.json → config`) : `checkIntervalMin`, `pageCheckMinutes`, `offlineGraceMinutes`
  (tolérance hors ligne, 0 = coupure immédiate). **Annonce** (`publish.json → announcement: {text, level}`) affichée dans la
  fenêtre de l'extension.
- **Coquille elle-même** : `extension/maj/activer-maj-auto.cmd` (une fois par poste) crée une tâche planifiée qui extrait le
  zip publié par-dessus le dossier quand sa version est plus récente ; l'extension détecte ses fichiers modifiés et se
  recharge seule (`chrome.runtime.reload()`). Ne monter `extension/manifest.json → version` que pour un vrai changement de
  coquille.

Reste manuel : la toute première installation (mode développeur + « Autoriser les scripts utilisateur ») et le
double-clic sur `activer-maj-auto.cmd`. Alternative 100 % automatique : extension empaquetée (.crx) déployée par stratégie
Chrome (GPO/Intune `ExtensionInstallForcelist`) si le cabinet gère ses postes.

## Dépendance à la publication GitHub (extension ≥ 1.4.0)

L'extension ne fonctionne **que si** https://chassard67.github.io/atelier-meg/manifest.json répond (vérifié au démarrage
de Chrome, toutes les 30 min et à l'ouverture d'une page MEG — au plus toutes les 5 min) :

| Situation | Effet |
|---|---|
| Publication joignable | Modules injectés normalement. |
| Injoignable (réseau, VPN, GitHub en panne) | Aucun module ; pastille **OFF** ; bandeau rouge dans MEG. Réactivation automatique dès qu'elle répond. |
| 404 — dépôt supprimé ou renommé, Pages désactivé | Aucun module ; code en cache effacé ; pastille **OFF** ; bandeau « publication supprimée ». |

## Arborescence

| Chemin | Rôle |
|---|---|
| `extension/` | Coquille Manifest V3 (clé publique incluse → ID stable `amkfkhcaodjjhifdgjfhgfpkilkgknlb`). Relais réseau, **téléchargements** (`chrome.downloads`), stockage. |
| `scripts/lib/atm-runtime.js` | API `window.ATM` (dont `ATM.download(dataUrl, chemin)`). |
| `scripts/*.js` | Un fichier = un module, en-tête `==UserScript==`. |
| `publish.json` | Catalogue, notes de version, `minExtensionVersion`. |
| `tools/` | `build.mjs`, `serve.mjs` (dev local http://localhost:8787/), `check.mjs`. |

## API MEG utilisée (relevée le 24/11/2026)

Hôte `https://rest.mon-expert-en-gestion.fr`, en-têtes `Authorization: Bearer …` (capté sur les requêtes de
l'appli, ou `sessionStorage['0-meg-front'].authzData`) + `X-IdEntreprise`, cookies inclus.

| Appel | Usage |
|---|---|
| `GET /ac/rest/achats-simplifies?page&size&sort&filter=etat:in:NON_REGLE\|PARTIELLEMENT_REGLE` | Liste des achats (`data`, `totalPages`) |
| `GET /ac/rest/achats-simplifies/{id}` | Détail : `echeances`, `_links` (`url-document`, `modifier-achat-echeances`) |
| `GET /ac/rest/achats-simplifies/{id}/telecharger-document` | PDF de la facture |
| `GET /ac/rest/achats-simplifies/modes-reglement` | Modes de règlement (`id`, `code`, `libelle`) |
| `POST /ac/rest/achats-simplifies/{id}/modifier-echeances` | Corps : tableau d'échéances `{id, version, type, dateEcheance, montant, multiReglement, idModeReglement, statutPaiement: "REGLE", reglement: {dateReglement}}` |
| `GET /ac/rest/commun/utilisateur?withCompanies=true` | `listeEntreprises[{id, name}]` → nom de la société |
| `GET /ac/rest/achats-simplifies/statistiques-liste-achats` (+ `X-IdEntreprise` de n'importe quel dossier accessible) | `nombreFactureBonAPayer` (= onglet À télécharger), `nombreFactureTotal`, … |
| `GET /ac/rest/journalEvenements?dateDebut&dateFin` | Journal des évènements (`listeEvenementsBean[{dateHeure, utilisateur, objet, action, evenement}]`) → colonne « Téléchargé par » |
| `GET /portail/rest/parametres/listes/reglement/liste` | Modes de règlement paramétrés (`personnalisee`) — sans `X-IdEntreprise` |
| `POST /portail/rest/parametres/listes/reglement/update` | Création d'un mode : `{ordre, finMois, code, libelle, delai, compteComptable, type, jourPrecis, parDefaut, idEntrepriseEncrypted}` (= valeur de `X-IdEntreprise`) |

La liste `modes-reglement` côté Achats renvoie aussi les versions supprimées (`isActive: false`) : toujours filtrer.

## Documentation

- [docs/INSTALLATION.md](docs/INSTALLATION.md) — installer l'extension
- [docs/PUBLIER.md](docs/PUBLIER.md) — faire évoluer et publier un module
