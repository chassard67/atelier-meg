// ==UserScript==
// @name         Compteurs de factures à télécharger dans la liste des dossiers
// @namespace    https://nicolas.chassard/meg
// @version      1.0.0
// @description  v1.0.0 (2026-11-24) : dans la liste déroulante des dossiers (en-tête MEG), affiche à côté de chaque
//               dossier le nombre de factures d'achat à télécharger, sans ouvrir les dossiers. Cache 15 min, ↻ pour
//               recompter. Affichage personnalisé LGA uniquement.
// @author       Nicolas
// @match        https://mon-expert-en-gestion.fr/*
// @run-at       document-start
// @noframes
// ==/UserScript==

// CHANGELOG
// 1.0.0 (2026-11-24) — première version.
//
// API : GET https://rest.mon-expert-en-gestion.fr/ac/rest/achats-simplifies/statistiques-liste-achats
//   avec X-IdEntreprise = identifiant du dossier (celui de la liste : id « navigation_select_entreprise_<id> »)
//   → { nombreFactureBonAPayer, nombreFactureTotal, montantTotalFacturesARegler, … }.
//   nombreFactureBonAPayer = onglet « À télécharger » (ex-« À régler »).
// Jeton : sessionStorage['0-meg-front'].authzData (client OIDC de MEG), à défaut celui capté sur les requêtes.

(function () {
  'use strict';
  if (window.__atmCompteurs) return;
  window.__atmCompteurs = true;

  const API = 'https://rest.mon-expert-en-gestion.fr';
  const ITEM_PREFIX = 'navigation_select_entreprise_';
  const CACHE_KEY = 'compteurs-dossiers';
  const MAX_AGE = 15 * 60e3;
  const PARALLELE = 6;
  const BADGE_CLASS = 'atm-compteur';
  const STATUS_ID = 'atm-compteurs-statut';

  const lga = () => {
    try {
      return localStorage.getItem('atm-meg-affichage') !== 'classique';
    } catch (e) {
      return true;
    }
  };

  // Jeton capté au vol (repli si le stockage du client OIDC change de forme).
  let headerToken = null;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (String(k).toLowerCase() === 'authorization' && /^Bearer /.test(v)) headerToken = v;
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

  function stats(idEntreprise) {
    return new Promise((resolve) => {
      const tok = token();
      if (!tok) return resolve(null);
      const x = new XMLHttpRequest();
      x.open('GET', API + '/ac/rest/achats-simplifies/statistiques-liste-achats');
      x.withCredentials = true;
      origSetHeader.call(x, 'Authorization', tok);
      origSetHeader.call(x, 'X-IdEntreprise', idEntreprise);
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

  // ---------------------------------------------------------------------------
  // Cache : { ts, counts: { idDossier: nombre | null } } (stockage de l'extension)
  // ---------------------------------------------------------------------------
  let cache = { ts: 0, counts: {} };
  let cacheLoaded = null;
  function loadCache() {
    if (!cacheLoaded) {
      cacheLoaded = ATM.getValue(CACHE_KEY, null)
        .then((c) => {
          if (c && c.counts) cache = c;
        })
        .catch(() => {});
    }
    return cacheLoaded;
  }

  let running = null;
  let progress = { done: 0, total: 0 };

  async function refresh(ids) {
    if (running) return running;
    running = (async () => {
      const counts = { ...cache.counts };
      progress = { done: 0, total: ids.length };
      let i = 0;
      await Promise.all(
        Array.from({ length: PARALLELE }, async () => {
          while (i < ids.length) {
            const id = ids[i++];
            const s = await stats(id);
            counts[id] = s ? Number(s.nombreFactureBonAPayer) || 0 : null;
            progress.done++;
            decorate();
          }
        })
      );
      cache = { ts: Date.now(), counts };
      decorate();
      ATM.setValue(CACHE_KEY, cache).catch(() => {});
    })().finally(() => {
      running = null;
      decorate();
    });
    return running;
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
      const n = cache.counts[idOf(b)];
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
      badge.title = `${n} facture(s) à télécharger`;
      const nom = (b.querySelector('.mdc-list-item__primary-text') || b).textContent.trim();
      b.title = `${nom} — ${n} facture(s) à télécharger`;
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
        refresh(listItems().map(idOf));
      });
      st.append(txt, btn);
      liste.parentElement.insertBefore(st, liste);
    }
    const txt = st.firstChild;
    const avec = Object.values(cache.counts).filter((n) => n > 0).length;
    const t = running
      ? `Atelier : comptage des factures à télécharger… ${progress.done}/${progress.total}`
      : cache.ts
      ? `Atelier : ${avec} dossier(s) avec des factures à télécharger · compté à ${new Date(cache.ts).toLocaleTimeString('fr-FR', {
          hour: '2-digit',
          minute: '2-digit',
        })}`
      : 'Atelier : comptage en attente';
    if (txt.textContent !== t) txt.textContent = t;
  }

  // Ouverture de la liste : affichage immédiat du cache, recomptage s'il a plus de 15 min.
  let wasOpen = false;
  async function onMutation() {
    if (!lga()) return;
    const items = listItems();
    const open = items.length > 0;
    if (open) decorate();
    if (open && !wasOpen) {
      await loadCache();
      decorate();
      if (Date.now() - cache.ts > MAX_AGE) refresh(listItems().map(idOf));
    }
    wasOpen = open;
  }

  ATM.onReady(() => {
    let t = null;
    new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(onMutation, 60);
    }).observe(document.body, { childList: true, subtree: true });
  });
})();
