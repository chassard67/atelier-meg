// ==UserScript==
// @name         Compteurs de factures à télécharger dans la liste des dossiers
// @namespace    https://nicolas.chassard/meg
// @version      1.1.0
// @description  v1.1.0 (2026-11-24) : comptage du dossier ouvert en priorité à chaque page, puis de tous les autres en
//               arrière-plan (sans ouvrir la liste), avec reprise après changement de page.
//               v1.0.0 (2026-11-24) : dans la liste déroulante des dossiers (en-tête MEG), nombre de factures d'achat à
//               télécharger à côté de chaque dossier, sans ouvrir les dossiers. Affichage personnalisé LGA uniquement.
// @author       Nicolas
// @match        https://mon-expert-en-gestion.fr/*
// @run-at       document-start
// @noframes
// ==/UserScript==

// CHANGELOG
// 1.1.0 (2026-11-24) — dossier ouvert recompté en premier à chaque chargement de page ; les autres dossiers sont
//                      comptés en arrière-plan (3 requêtes en parallèle), dès l'arrivée sur MEG, sans ouvrir la liste ;
//                      chaque compteur a sa propre date (valable 15 min) : un comptage interrompu reprend où il en était ;
//                      un seul onglet compte à la fois.
// 1.0.0 (2026-11-24) — première version.
//
// API (hôte rest.mon-expert-en-gestion.fr, jeton : sessionStorage['0-meg-front'].authzData) :
//   GET /ac/rest/achats-simplifies/statistiques-liste-achats + X-IdEntreprise = dossier → { nombreFactureBonAPayer, … }
//       nombreFactureBonAPayer = onglet « À télécharger ».
//   GET /ac/rest/commun/utilisateur?withCompanies=true → listeEntreprises [{ id, name }] (tous les dossiers accessibles).
// Dossier ouvert : en-tête X-IdEntreprise des requêtes de l'appli, sinon nom affiché dans l'en-tête (bouton
// #navigation_select_entreprise_afficher) retrouvé dans listeEntreprises.

(function () {
  'use strict';
  if (window.__atmCompteurs) return;
  window.__atmCompteurs = true;

  const API = 'https://rest.mon-expert-en-gestion.fr';
  const ITEM_PREFIX = 'navigation_select_entreprise_';
  const HEADER_ID = 'navigation_select_entreprise_afficher';
  const CACHE_KEY = 'compteurs-dossiers-v2';
  const LOCK_KEY = 'compteurs-dossiers-verrou';
  const MAX_AGE = 15 * 60e3;
  const PARALLELE = 3; // arrière-plan : on ne ralentit pas MEG
  const SAVE_EVERY = 20;
  const BADGE_CLASS = 'atm-compteur';
  const STATUS_ID = 'atm-compteurs-statut';

  const lga = () => {
    try {
      return localStorage.getItem('atm-meg-affichage') !== 'classique';
    } catch (e) {
      return true;
    }
  };

  // En-têtes captés sur les requêtes de l'appli (jeton de repli + dossier ouvert).
  let headerToken = null;
  let headerEnt = null;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    const key = String(k).toLowerCase();
    if (!this.__atmCpt) {
      if (key === 'authorization' && /^Bearer /.test(v)) headerToken = v;
      else if (key === 'x-identreprise' && v) headerEnt = v;
    }
    return origSetHeader.apply(this, arguments);
  };
  function token() {
    try {
      const s = JSON.parse(sessionStorage.getItem('0-meg-front') || 'null');
      const t = s && (s.authzData || (s.authnResult && s.authnResult.access_token));
      if (t) return 'Bearer ' + t;
    } catch (e) {}
    return headerToken;
  }

  function get(path, ent) {
    return new Promise((resolve) => {
      const tok = token();
      if (!tok) return resolve(null);
      const x = new XMLHttpRequest();
      x.__atmCpt = true;
      x.open('GET', API + path);
      x.withCredentials = true;
      origSetHeader.call(x, 'Authorization', tok);
      if (ent) origSetHeader.call(x, 'X-IdEntreprise', ent);
      origSetHeader.call(x, 'Accept', 'application/json');
      x.timeout = 20000;
      x.onload = () => {
        if (x.status !== 200) return resolve(null);
        try {
          resolve(JSON.parse(x.responseText));
        } catch (e) {
          resolve(null);
        }
      };
      x.onerror = x.ontimeout = () => resolve(null);
      x.send();
    });
  }

  async function compter(id) {
    const s = await get('/ac/rest/achats-simplifies/statistiques-liste-achats', id);
    return s ? Number(s.nombreFactureBonAPayer) || 0 : null;
  }

  // ---------------------------------------------------------------------------
  // Cache : { counts: { idDossier: { n, t } } } — chaque compteur a sa date.
  // ---------------------------------------------------------------------------
  let counts = {};
  let cacheLoaded = null;
  const loadCache = () =>
    (cacheLoaded =
      cacheLoaded ||
      ATM.getValue(CACHE_KEY, null)
        .then((c) => {
          if (c && c.counts) counts = { ...c.counts, ...counts };
        })
        .catch(() => {}));
  const saveCache = () => ATM.setValue(CACHE_KEY, { counts }).catch(() => {});
  const fresh = (id) => counts[id] && Date.now() - counts[id].t < MAX_AGE;

  // Liste de tous les dossiers (API, sans ouvrir la liste déroulante).
  let dossiers = null;
  async function listeDossiers() {
    if (dossiers && dossiers.length) return dossiers;
    const u = await get('/ac/rest/commun/utilisateur?withCompanies=true');
    dossiers = ((u && u.listeEntreprises) || []).filter((e) => e && e.id);
    return dossiers;
  }

  async function dossierOuvert() {
    if (headerEnt) return headerEnt;
    const nom = ((document.getElementById(HEADER_ID) || {}).textContent || '').trim();
    if (!nom) return null;
    const d = (await listeDossiers()).find((e) => String(e.name).trim() === nom);
    return d ? d.id : null;
  }

  // Un seul onglet compte à la fois (verrou renouvelé pendant le comptage).
  const pageId = Math.random().toString(36).slice(2);
  async function prendreVerrou() {
    const v = await ATM.getValue(LOCK_KEY, null).catch(() => null);
    if (v && v.page !== pageId && Date.now() - v.t < 60e3) return false;
    await ATM.setValue(LOCK_KEY, { page: pageId, t: Date.now() }).catch(() => {});
    return true;
  }

  let running = false;
  let progress = { done: 0, total: 0 };

  async function comptageArrierePlan() {
    if (running || !lga()) return;
    running = true;
    try {
      await loadCache();
      // 1. Dossier ouvert : toujours recompté (il vient peut-être d'être traité).
      const courant = await dossierOuvert();
      if (courant) {
        const n = await compter(courant);
        if (n !== null) counts[courant] = { n, t: Date.now() };
        saveCache();
        decorate();
      }
      // 2. Les autres dossiers, s'ils ne sont pas à jour, en arrière-plan.
      const ids = (await listeDossiers()).map((d) => d.id).filter((id) => id !== courant && !fresh(id));
      if (!ids.length || !(await prendreVerrou())) return;
      progress = { done: 0, total: ids.length };
      let i = 0;
      let depuisSauvegarde = 0;
      await Promise.all(
        Array.from({ length: PARALLELE }, async () => {
          while (i < ids.length) {
            const id = ids[i++];
            const n = await compter(id);
            counts[id] = { n, t: Date.now() };
            progress.done++;
            if (++depuisSauvegarde >= SAVE_EVERY) {
              depuisSauvegarde = 0;
              saveCache();
              ATM.setValue(LOCK_KEY, { page: pageId, t: Date.now() }).catch(() => {});
            }
            decorate();
          }
        })
      );
      saveCache();
      ATM.setValue(LOCK_KEY, null).catch(() => {});
    } finally {
      running = false;
      progress = { done: 0, total: 0 };
      decorate();
    }
  }

  // ---------------------------------------------------------------------------
  // Affichage dans la liste déroulante des dossiers
  // ---------------------------------------------------------------------------
  function listItems() {
    return [...document.querySelectorAll(`.liste-entreprises button[id^="${ITEM_PREFIX}"]`)];
  }
  const idOf = (b) => b.id.slice(ITEM_PREFIX.length);

  function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }

  function decorate() {
    if (!lga()) return;
    const items = listItems();
    if (!items.length) return;
    for (const b of items) {
      const c = counts[idOf(b)];
      const n = c && c.n;
      let badge = b.querySelector('.' + BADGE_CLASS);
      if (!(n > 0)) {
        if (badge) badge.remove();
        continue;
      }
      if (!badge) {
        badge = el(
          'span',
          'position:absolute;right:8px;top:50%;transform:translateY(-50%);min-width:20px;padding:1px 7px;border-radius:10px;' +
            'background:#5b45f5;color:#fff;font:600 11px/16px system-ui,Segoe UI,Arial;text-align:center;pointer-events:none'
        );
        badge.className = BADGE_CLASS;
        if (getComputedStyle(b).position === 'static') b.style.position = 'relative';
        b.style.paddingRight = '44px';
        b.appendChild(badge);
      }
      const txt = String(n);
      if (badge.textContent !== txt) badge.textContent = txt;
      const nom = (b.querySelector('.mdc-list-item__primary-text') || b).textContent.trim();
      const title = `${nom} — ${n} facture(s) à télécharger`;
      if (b.title !== title) b.title = title;
    }
    statusLine(items);
  }

  function statusLine(items) {
    const liste = items[0].closest('.liste-entreprises');
    if (!liste) return;
    let st = document.getElementById(STATUS_ID);
    if (!st) {
      st = el('div', 'display:flex;align-items:center;gap:8px;padding:4px 8px 6px;font:11px system-ui,Segoe UI,Arial;color:#6b7280');
      st.id = STATUS_ID;
      const txt = el('span', 'flex:1');
      const btn = el('button', 'background:none;border:0;color:#5b45f5;cursor:pointer;font:600 13px system-ui;padding:0 4px', '↻');
      btn.type = 'button';
      btn.title = 'Recompter les factures à télécharger de tous les dossiers';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        for (const id of Object.keys(counts)) counts[id].t = 0;
        ATM.setValue(LOCK_KEY, null)
          .catch(() => {})
          .then(comptageArrierePlan);
        decorate();
      });
      st.append(txt, btn);
      liste.parentElement.insertBefore(st, liste);
    }
    const txt = st.firstChild;
    const vals = Object.values(counts);
    const avec = vals.filter((c) => c.n > 0).length;
    const dates = vals.filter((c) => c.t).map((c) => c.t);
    const plusAncien = dates.length ? Math.min(...dates) : 0;
    const heure = (t) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const t =
      running && progress.total
        ? `Atelier : comptage en arrière-plan… ${progress.done}/${progress.total} · ${avec} dossier(s) avec des factures à télécharger`
        : plusAncien
        ? `Atelier : ${avec} dossier(s) avec des factures à télécharger · compté depuis ${heure(plusAncien)}`
        : 'Atelier : comptage en cours…';
    if (txt.textContent !== t) txt.textContent = t;
  }

  ATM.onReady(() => {
    loadCache().then(decorate);
    // Laisse MEG se charger, puis compte (le jeton et le dossier ouvert sont alors connus).
    setTimeout(comptageArrierePlan, 2500);
    // Navigation interne (changement de page) : recompte le dossier ouvert, reprend l'arrière-plan.
    let lastPath = location.pathname;
    let t = null;
    new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        decorate();
        if (location.pathname !== lastPath) {
          lastPath = location.pathname;
          setTimeout(comptageArrierePlan, 1500);
        }
      }, 80);
    }).observe(document.body, { childList: true, subtree: true });
  });
})();
