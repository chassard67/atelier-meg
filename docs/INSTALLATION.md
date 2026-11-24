# Installer l'extension Atelier MEG

Durée : 3 minutes. Chrome à jour (version 120 minimum).

## 1. Télécharger

1. Télécharger **atelier-meg-extension.zip** depuis https://chassard67.github.io/atelier-meg/
2. Créer le dossier `C:\AtelierMEG\extension` et y **extraire** le zip.
   Garder toujours ce même dossier : les mises à jour de l'extension s'y feront.

## 2. Installer dans Chrome

1. Ouvrir `chrome://extensions`.
2. Activer **Mode développeur** (en haut à droite).
3. **Charger l'extension non empaquetée** → choisir `C:\AtelierMEG\extension`.
4. Sur la carte « Atelier MEG » → **Détails** → activer **Autoriser les scripts utilisateur**
   *(indispensable : sans ça, aucun module ne s'exécute)*.
5. Icône puzzle 🧩 → **épingler** Atelier MEG.
6. **Mise à jour automatique (une seule fois)** : dans `C:\AtelierMEG\extension\maj`, double-cliquer
   **`activer-maj-auto.cmd`**. Une tâche planifiée Windows (sans droits administrateur) vérifie toutes les 2 heures et à
   chaque ouverture de session ; l'extension se recharge ensuite d'elle-même. Journal : `maj\maj.log`.
   (`desactiver-maj-auto.cmd` pour arrêter.)

## 3. Préparer chaque dossier MEG (une fois)

Paramètres → Listes par défaut → Modes de règlement → Ajouter :
code `TELECHARGE`, libellé `Téléchargé`, délai `0` jours, compte comptable `99999999`.

## 4. Utiliser

MEG → Achats : bouton **« ⬇ Télécharger les factures »** à gauche de « Importer ».
Les PDF arrivent dans le dossier Téléchargements de Chrome, sous-dossier au nom de la société.
Conseil : dans Chrome → Paramètres → Téléchargements, désactiver « Toujours demander où enregistrer les fichiers ».

| Pastille sur l'icône | Signification |
|---|---|
| *(aucune)* | Tout fonctionne. |
| **!** rouge | « Autoriser les scripts utilisateur » n'est pas activé (étape 2.4). |
| **?** orange | Modules non téléchargés (réseau / VPN) — « Vérifier les mises à jour ». |
| **EXT** orange | Nouvelle version de l'extension requise : retélécharger le zip, l'extraire par-dessus, ↻ dans chrome://extensions. |

## Mises à jour

- **Modules (fonctionnalités)** : automatiques, sans rien faire (démarrage de Chrome, toutes les 30 min, ouverture de MEG).
- **Extension elle-même** : automatique si l'étape 2.6 a été faite. Sinon, quand MEG affiche « Nouvelle version de
  l'extension » : télécharger le zip, l'extraire par-dessus `C:\AtelierMEG\extension` — l'extension se recharge seule
  (plus besoin de ↻ dans chrome://extensions).
