# Atelier MEG — extension Chrome

Outils pour **Mon Expert en Gestion** (mon-expert-en-gestion.fr), diffusés sous forme d'**extension Chrome
installée en mode développeur**, avec **mise à jour automatique des modules** sans réinstallation.
Même mécanique que l'extension Atelier MyUnisoft.

## Fonctionnalités

| Module | Rôle |
|---|---|
| `achats-telechargement` | Page **Achats** : bouton **« ⬇ Télécharger les factures »**. Pour chaque facture *non réglée* (ou partiellement réglée) : télécharge le PDF dans `Téléchargements\<Société>\Fournisseur - JJ-MM-AAAA - N°.pdf` (suffixe ` (1)` si le nom existe déjà), puis la passe en **Réglé**, mode **Téléchargé**, date du jour. La facture n'est passée en réglé qu'une fois le fichier réellement écrit. |
| `socle` | Versions dans la console, fenêtre « mise à jour activée ». |

**Prérequis par dossier MEG** : le mode de règlement *Téléchargé* doit exister.
Paramètres → Listes par défaut → Modes de règlement → Ajouter : code `TELECHARGE`, libellé `Téléchargé`,
délai 0 jours, compte comptable `99999999`. Sans lui, le module s'arrête et l'indique.

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
l'appli) + `X-IdEntreprise`, cookies inclus.

| Appel | Usage |
|---|---|
| `GET /ac/rest/achats-simplifies?page&size&sort&filter=etat:in:NON_REGLE\|PARTIELLEMENT_REGLE` | Liste des achats (`data`, `totalPages`) |
| `GET /ac/rest/achats-simplifies/{id}` | Détail : `echeances`, `_links` (`url-document`, `modifier-achat-echeances`) |
| `GET /ac/rest/achats-simplifies/{id}/telecharger-document` | PDF de la facture |
| `GET /ac/rest/achats-simplifies/modes-reglement` | Modes de règlement (`id`, `code`, `libelle`) |
| `POST /ac/rest/achats-simplifies/{id}/modifier-echeances` | Corps : tableau d'échéances `{id, version, type, dateEcheance, montant, multiReglement, idModeReglement, statutPaiement: "REGLE", reglement: {dateReglement}}` |
| `GET /ac/rest/commun/utilisateur?withCompanies=true` | `listeEntreprises[{id, name}]` → nom de la société |

## Documentation

- [docs/INSTALLATION.md](docs/INSTALLATION.md) — installer l'extension
- [docs/PUBLIER.md](docs/PUBLIER.md) — faire évoluer et publier un module
