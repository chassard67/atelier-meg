// Réglages par défaut de l'extension. Les choix de l'utilisateur (fenêtre de
// l'extension) sont stockés dans chrome.storage.local sous la clé "cfg" et
// ne contiennent que ce qu'il a modifié (le reste suit les valeurs par défaut
// publiées, qui peuvent donc évoluer sans réinstaller l'extension).

export const DEFAULTS = {
  // Publication des modules : GitHub Pages du dépôt chassard67/atelier-meg.
  baseUrl: 'https://chassard67.github.io/atelier-meg/',

  // Intervalle de vérification automatique des mises à jour, minutes.
  checkIntervalMin: 30,

  // Clé de licence (inutilisée tant que publish.json → licenceRequired = false).
  licenceKey: '',

  // Choix de l'utilisateur, par id : { "achats-telechargement": false, ... } — vide = défauts.
  modules: {},
  settings: {},
};

// Valeurs de repli des réglages si la publication ne les définit pas (le
// catalogue publié dans manifest.json fait foi).
export const FALLBACK_SETTINGS = {};

// Une licence validée reste utilisable hors ligne pendant ce délai.
export const LICENCE_GRACE_DAYS = 14;

// Notes affichées aux utilisateurs quand la COQUILLE elle-même est mise à jour.
export const EXTENSION_NOTES = {
  '1.2.0': ['Nouvelle icône « MEG ».'],
  '1.1.0': ['Les factures téléchargées portent bien le nom « Fournisseur - JJ-MM-AAAA - N°.pdf », dans le sous-dossier de la société.'],
  '1.0.0': ['Première version de l\'extension Atelier MEG.'],
};
