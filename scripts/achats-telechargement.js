// ==UserScript==
// @name         Achats : téléchargement en lot des factures
// @namespace    https://nicolas.chassard/meg
// @version      1.6.1
// @description  v1.6.1 (2026-11-24) : CORRECTIF boucle de rechargement à la reconnexion (paramètres code/state).
//               v1.6.0 (2026-11-24) : « Télécharger et imprimer » ne passe les factures en Téléchargé qu'une fois tout
//               téléchargé, fusionné, imprimé et l'impression confirmée.
//               v1.5.0 (2026-11-24) : boutons « Télécharger et imprimer » : même traitement que Télécharger, puis les PDF
//               sont fusionnés (ordre du tableau) et la fenêtre d'impression s'ouvre.
//               v1.4.0 (2026-11-24) : colonne « Téléchargé par » (affichage LGA), tirée du journal des évènements MEG.
//               v1.3.0 (2026-11-24) : « Affichage personnalisé LGA » (page Achats épurée) / « Affichage classique » (MEG
//               d'origine) ; « Télécharger la sélection » dans le bandeau de sélection.
//               v1.2.0 (2026-11-24) : libellés « Non téléchargé / Téléchargé », onglets « À télécharger / Téléchargé »,
//               onglets « À traiter » et « À affecter » masqués ; bouton ✕ sur l'aperçu ; nom de fichier contrôlé.
//               v1.1.0 (2026-11-24) : aperçu du PDF au survol du nom de fichier ; seules les factures cochées sont
//               traitées s'il y en a ; création automatique du mode « Téléchargé » s'il manque (avec confirmation).
//               v1.0.0 (2026-11-24) : bouton « Télécharger les factures » sur Achats simplifiés. Télécharge le PDF de
//               chaque facture non réglée dans Téléchargements/<Société>/« Fournisseur - JJ-MM-AAAA - N°.pdf »,
//               puis la passe en Réglé, mode de règlement « Téléchargé » (code TELECHARGE), date du jour.
// @author       Nicolas
// @match        https://mon-expert-en-gestion.fr/*
// @run-at       document-start
// @noframes
// ==/UserScript==

// CHANGELOG
// 1.6.1 (2026-11-24) — CORRECTIF : à la reconnexion automatique de MEG (adresse avec ?code=…&state=…), le mode LGA
//                      prenait ces paramètres pour des filtres, les retirait et rechargeait → boucle de rechargement.
//                      Désormais seuls les filtres masqués connus sont retirés, jamais pendant une connexion, et au plus
//                      un rechargement par minute.
// 1.6.0 (2026-11-24) — Télécharger et imprimer : passage en Téléchargé seulement si TOUTES les factures ont été
//                      téléchargées, la fusion réussie, et l'impression confirmée (« L'impression s'est bien passée ? »).
//                      Sinon aucune facture n'est modifiée (les PDF déjà enregistrés restent dans le dossier).
// 1.5.0 (2026-11-24) — « 🖨 Télécharger et imprimer » (en haut : toutes les factures non téléchargées ; dans le bandeau :
//                      la sélection) : téléchargement + passage en Téléchargé comme d'habitude, puis fusion des PDF
//                      (pdf-lib, ordre du tableau) et impression ; la fusion n'est pas enregistrée. Liste complète triée
//                      comme le tableau de MEG (date d'import décroissante).
// 1.4.0 (2026-11-24) — colonne « Téléchargé par » après « Règlement » (affichage LGA) : utilisateur qui a passé
//                      la facture en Réglé en dernier (journal des évènements), date et heure en info-bulle.
// 1.3.0 (2026-11-24) — bascule « Affichage personnalisé LGA » / « Affichage classique » (mémorisée dans ce Chrome,
//                      LGA par défaut). LGA : colonnes Affectation, Liaison bancaire, Compte comptable, Source et
//                      Date d'import masquées ; boutons Exporter, Importer et ⋮ masqués ; cartes « Factures à régler »
//                      et « Suivi des règlements » masquées ; seul le filtre Rechercher reste (les autres filtres sont
//                      vidés en passant en LGA) ; bandeau de sélection : « Télécharger la sélection » à la place de
//                      la suppression ; bouton du haut = toutes les factures non téléchargées. Classique = MEG d'origine.
// 1.2.0 (2026-11-24) — statuts renommés (Non réglé → Non téléchargé, Réglé → Téléchargé), onglets renommés
//                      (À régler → À télécharger, Réglé → Téléchargé), onglets À traiter / À affecter masqués ;
//                      bouton ✕ pour fermer l'aperçu ; la facture n'est passée en réglé que si le fichier porte le bon nom
//                      (nécessite l'extension 1.1.0, qui impose le nom au téléchargement).
// 1.1.0 (2026-11-24) — aperçu PDF au survol de la colonne « Nom du fichier » ; factures cochées = seules traitées ;
//                      proposition de créer le mode TELECHARGE (Paramètres > Listes par défaut) s'il manque.
// 1.0.0 (2026-11-24) — première version.
//
// API MEG utilisée (relevée le 24/11/2026 sur DYNASTIE TRANSACTION) — hôte rest.mon-expert-en-gestion.fr,
// en-têtes Authorization: Bearer … + X-IdEntreprise, cookies (withCredentials) :
//   GET  /ac/rest/achats-simplifies?page&size&sort&filter=etat:in:NON_REGLE|…  → { data[], totalPages }
//   GET  /ac/rest/achats-simplifies/{id}                                    → détail, échéances, _links
//   GET  …/{id}/telecharger-document                                         → application/pdf
//   GET  /ac/rest/achats-simplifies/modes-reglement                          → [{ id, code, libelle }]
//   POST …/{id}/modifier-echeances   body = [échéances]                      → achat mis à jour
//        (lien HATEOAS _links['modifier-achat-echeances'] du détail ; '-' = interdit)
//   GET  /ac/rest/commun/utilisateur?withCompanies=true                      → listeEntreprises [{ id, name }]
//   POST /portail/rest/parametres/listes/reglement/update  body = { ordre, finMois, code, libelle, delai, compteComptable,
//        type, jourPrecis, parDefaut, idEntrepriseEncrypted }  → création d'un mode de règlement (portail, sans X-IdEntreprise)
//   GET  /portail/rest/parametres/listes/reglement/liste     → { personnalisee: [...] }
//   GET  /ac/rest/journalEvenements?dateDebut&dateFin → { listeEvenementsBean: [{ dateHeure, utilisateur, objet,
//        action, evenement: "Modification du statut de la facture N° qui passe de Non réglé à Réglé" }] }
// Le jeton n'est pas lisible ailleurs : on le capte au vol sur les requêtes de l'appli (XHR).

(function () {
  'use strict';
  if (window.__atmAchatsDl) return;
  window.__atmAchatsDl = true;

  const API = 'https://rest.mon-expert-en-gestion.fr';
  const PAGE_RE = /^\/ac\/achats-simplifies\/?$/;
  const MODE_CODE = 'TELECHARGE';
  const ETATS = 'NON_REGLE|PARTIELLEMENT_REGLE';
  const BTN_ID = 'atm-achats-dl-btn';

  // ---------------------------------------------------------------------------
  // Capture du jeton et de l'entreprise courante sur les requêtes de l'appli
  // ---------------------------------------------------------------------------
  const auth = { token: null, ent: null };
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  // Dernière liste d'achats chargée par l'appli (ordre = ordre des lignes du tableau).
  let lastList = [];
  const LIST_RE = /^https:\/\/rest\.mon-expert-en-gestion\.fr\/ac\/rest\/achats-simplifies(\?|$)/;
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (String(method).toUpperCase() === 'GET' && LIST_RE.test(String(url))) {
      this.addEventListener('load', () => {
        if (this.__atm || this.status !== 200) return;
        try {
          const j = typeof this.response === 'string' ? JSON.parse(this.response) : this.response;
          if (j && Array.isArray(j.data)) lastList = j.data;
        } catch (e) {}
      });
    }
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    const key = String(k).toLowerCase();
    if (key === 'authorization' && /^Bearer /.test(v)) auth.token = v;
    else if (key === 'x-identreprise' && v) auth.ent = v;
    return origSetHeader.apply(this, arguments);
  };

  // ---------------------------------------------------------------------------
  // Appels API
  // ---------------------------------------------------------------------------
  function api(method, path, { body, binary, noEnt } = {}) {
    return new Promise((resolve, reject) => {
      if (!auth.token || !auth.ent) {
        return reject(new Error('Session MEG pas encore détectée : rechargez la page (F5) puis réessayez.'));
      }
      const x = new XMLHttpRequest();
      x.__atm = true;
      x.open(method, /^https:/.test(path) ? path : API + path);
      x.withCredentials = true;
      if (binary) x.responseType = 'arraybuffer';
      origSetHeader.call(x, 'Authorization', auth.token);
      if (!noEnt) origSetHeader.call(x, 'X-IdEntreprise', auth.ent);
      origSetHeader.call(x, 'Accept', binary ? 'application/pdf, */*' : 'application/json, text/plain, */*');
      if (body !== undefined) origSetHeader.call(x, 'Content-Type', 'application/json');
      x.onload = () => {
        if (x.status === 401 || x.status === 403) {
          return reject(new Error(`Accès refusé par MEG (${x.status}) : session expirée ? Rechargez la page.`));
        }
        if (x.status < 200 || x.status >= 300) {
          let msg = '';
          try {
            const j = JSON.parse(x.responseText);
            msg = j.message || j.detail || j.title || '';
          } catch (e) {}
          return reject(new Error(`HTTP ${x.status} sur ${path.split('?')[0]}${msg ? ' — ' + msg : ''}`));
        }
        if (binary) return resolve({ buf: x.response, type: x.getResponseHeader('content-type') || '' });
        try {
          resolve(x.responseText ? JSON.parse(x.responseText) : null);
        } catch (e) {
          reject(new Error('Réponse illisible sur ' + path.split('?')[0]));
        }
      };
      x.onerror = () => reject(new Error('Erreur réseau sur ' + path.split('?')[0]));
      x.send(body === undefined ? null : JSON.stringify(body));
    });
  }

  const linkOk = (l) => l && l.href && l.href !== '-';

  async function listAchatsNonRegles() {
    const out = [];
    for (let page = 0; page < 100; page++) {
      const q = new URLSearchParams({ page: String(page), size: '50', sort: 'dateAjout,desc', filter: 'etat:in:' + ETATS });
      const r = await api('GET', '/ac/rest/achats-simplifies?' + q);
      out.push(...((r && r.data) || []));
      if (!r || page + 1 >= (r.totalPages || 1)) break;
    }
    return out;
  }

  async function nomSociete() {
    try {
      const u = await api('GET', '/ac/rest/commun/utilisateur?withCompanies=true');
      const e = (u.listeEntreprises || []).find((x) => x.id === auth.ent);
      if (e && e.name) return e.name;
    } catch (e) {}
    // Repli : le sélecteur de dossier dans l'en-tête de MEG.
    const btn = [...document.querySelectorAll('header button, button')].find((b) => /^[A-Z0-9][A-Z0-9 &'.-]{2,}$/.test(b.textContent.trim()));
    return btn ? btn.textContent.trim() : 'Dossier MEG';
  }

  const findMode = (modes) => (modes || []).find((m) => String(m.code).toUpperCase() === MODE_CODE && m.isActive !== false);

  // Création du mode « Téléchargé » dans Paramètres > Listes par défaut > Modes de règlement
  // (même appel que l'écran de MEG). Rien n'est créé s'il existe déjà côté paramétrage.
  async function creerModeTelecharge() {
    const liste = await api('GET', '/portail/rest/parametres/listes/reglement/liste', { noEnt: true });
    const perso = (liste && liste.personnalisee) || [];
    if (!perso.some((m) => String(m.code).toUpperCase() === MODE_CODE)) {
      await api('POST', '/portail/rest/parametres/listes/reglement/update', {
        noEnt: true,
        body: {
          ordre: perso.length,
          finMois: false,
          code: MODE_CODE,
          libelle: 'Téléchargé',
          delai: '0',
          compteComptable: '99999999',
          type: 'TYPE_VIREMENT',
          jourPrecis: '0',
          parDefaut: false,
          idEntrepriseEncrypted: auth.ent,
        },
      });
    }
    return findMode(await api('GET', '/ac/rest/achats-simplifies/modes-reglement'));
  }

  // Lignes du tableau → achats de la dernière liste chargée par l'appli.
  function rowsOfTable() {
    return [...document.querySelectorAll('achat-liste-achats tbody tr.mat-mdc-row, tbody tr.mat-mdc-row')];
  }
  const cellText = (tr, col) => {
    const td = tr.querySelector('td.cdk-column-' + col);
    return td ? td.textContent.trim() : '';
  };
  function achatOfRow(tr) {
    const rows = rowsOfTable();
    const i = rows.indexOf(tr);
    const nom = cellText(tr, 'nomFichier');
    const num = cellText(tr, 'numeroFacture');
    const same = (a) => a && (!nom || (a.document && a.document.nom) === nom) && (!num || a.numeroFacture === num);
    if (i >= 0 && same(lastList[i])) return lastList[i];
    return lastList.find(same) || null;
  }
  function selectedRows() {
    return rowsOfTable().filter((tr) => {
      const cb = tr.querySelector('td.cdk-column-selection input[type=checkbox]');
      return cb && cb.checked;
    });
  }

  // ---------------------------------------------------------------------------
  // Utilitaires
  // ---------------------------------------------------------------------------
  const pad = (n) => String(n).padStart(2, '0');
  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  const frDate = (iso) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : 'sans date');

  function cleanName(s) {
    return String(s || '')
      .replace(/[\u0000-\u001f<>:"/\\|?*~]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.]+|[\s.]+$/g, '')
      .slice(0, 120);
  }

  function fileName(achat) {
    const fournisseur = cleanName((achat.fournisseur && achat.fournisseur.nomComplet) || 'Fournisseur inconnu');
    const numero = cleanName(achat.numeroFacture || achat.numeroComptableAchat || 'sans numero');
    return `${fournisseur} - ${frDate(achat.dateEmission)} - ${numero}.pdf`;
  }

  function toDataUrl(buf, type) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return `data:${type || 'application/pdf'};base64,${btoa(bin)}`;
  }

  const isPdf = (buf) => {
    const b = new Uint8Array(buf, 0, Math.min(5, buf.byteLength));
    return String.fromCharCode(...b) === '%PDF-';
  };

  // Échéances renvoyées à MEG : celles déjà réglées restent telles quelles,
  // les autres passent en Réglé / Téléchargé / date du jour (même format que
  // l'écran Règlement de MEG).
  function echeancesReglees(detail, idMode, date) {
    return (detail.echeances || []).map((e) => {
      const base = {
        id: e.id,
        version: e.version,
        type: e.type,
        dateEcheance: e.dateEcheance,
        montant: e.montant,
        multiReglement: !!e.multiReglement,
      };
      if (e.statutPaiement === 'REGLE') {
        return { ...base, idModeReglement: e.idModeReglement, statutPaiement: 'REGLE', reglement: e.reglement };
      }
      return { ...base, idModeReglement: idMode, statutPaiement: 'REGLE', reglement: { dateReglement: date } };
    });
  }

  // ---------------------------------------------------------------------------
  // Fenêtre de progression
  // ---------------------------------------------------------------------------
  function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }

  function panel() {
    const overlay = el('div', 'position:fixed;inset:0;z-index:2147483640;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;font:13px/1.45 system-ui,Segoe UI,Arial,sans-serif');
    const box = el('div', 'background:#fff;border-radius:10px;width:min(760px,94vw);max-height:84vh;display:flex;flex-direction:column;box-shadow:0 18px 50px rgba(0,0,0,.35)');
    const head = el('div', 'background:#5b45f5;color:#fff;padding:12px 18px;border-radius:10px 10px 0 0;font-weight:600;font-size:15px', 'Téléchargement des factures d\'achat');
    const status = el('div', 'padding:10px 18px 4px;font-weight:600;color:#111827', 'Préparation…');
    const barWrap = el('div', 'margin:4px 18px 8px;height:6px;background:#eef2ff;border-radius:3px;overflow:hidden');
    const bar = el('div', 'height:100%;width:0;background:#5b45f5;transition:width .2s');
    barWrap.appendChild(bar);
    const log = el('div', 'padding:4px 18px;overflow:auto;flex:1;min-height:120px;font-size:12px;color:#374151');
    const foot = el('div', 'padding:10px 18px 14px;display:flex;gap:8px;justify-content:flex-end;border-top:1px solid #eee');
    const btnStop = el('button', 'background:#fff;color:#b91c1c;border:1px solid #fca5a5;border-radius:6px;padding:7px 14px;font:inherit;cursor:pointer', 'Arrêter');
    const btnClose = el('button', 'background:#5b45f5;color:#fff;border:0;border-radius:6px;padding:7px 16px;font:inherit;cursor:pointer', 'Fermer et actualiser');
    btnClose.hidden = true;
    const btnPdf = el('button', 'background:#fff;color:#5b45f5;border:1px solid #5b45f5;border-radius:6px;padding:7px 14px;font:inherit;cursor:pointer;margin-right:auto', '🖨 Réimprimer');
    btnPdf.hidden = true;
    foot.append(btnPdf, btnStop, btnClose);
    box.append(head, status, barWrap, log, foot);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const ui = {
      stopped: false,
      status: (t) => (status.textContent = t),
      progress: (i, n) => (bar.style.width = n ? Math.round((i / n) * 100) + '%' : '0'),
      line(text, kind) {
        const color = { ok: '#047857', err: '#b91c1c', warn: '#b45309' }[kind] || '#374151';
        const icon = { ok: '✔ ', err: '✖ ', warn: '⚠ ' }[kind] || '';
        const d = el('div', `padding:2px 0;color:${color};white-space:pre-wrap`, icon + text);
        log.appendChild(d);
        log.scrollTop = log.scrollHeight;
      },
      ask(question, okLabel) {
        return new Promise((resolve) => {
          const wrap = el('div', 'margin:8px 0;padding:10px 12px;background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;color:#78350f;white-space:pre-wrap');
          wrap.appendChild(el('div', 'margin-bottom:8px', question));
          const yes = el('button', 'background:#5b45f5;color:#fff;border:0;border-radius:6px;padding:6px 14px;font:inherit;cursor:pointer;margin-right:8px', okLabel);
          const no = el('button', 'background:#fff;color:#374151;border:1px solid #d1d5db;border-radius:6px;padding:6px 14px;font:inherit;cursor:pointer', 'Annuler');
          const done = (v) => {
            yes.disabled = no.disabled = true;
            resolve(v);
          };
          yes.onclick = () => done(true);
          no.onclick = () => done(false);
          wrap.append(yes, no);
          log.appendChild(wrap);
          yes.focus();
        });
      },
      offerPdf(onClick) {
        btnPdf.hidden = false;
        btnPdf.onclick = onClick;
      },
      finish() {
        btnStop.hidden = true;
        btnClose.hidden = false;
        btnClose.focus();
      },
    };
    btnStop.onclick = () => {
      ui.stopped = true;
      btnStop.disabled = true;
      btnStop.textContent = 'Arrêt après la facture en cours…';
    };
    btnClose.onclick = () => {
      overlay.remove();
      location.reload();
    };
    return ui;
  }

  // ---------------------------------------------------------------------------
  // Traitement
  // ---------------------------------------------------------------------------
  let running = false;

  async function run({ selection: parSelection = false, imprimer = false } = {}) {
    if (running) return;
    // Factures cochées (bandeau de sélection) : seules celles-là sont traitées (lues AVANT d'afficher la fenêtre).
    const coches = parSelection ? selectedRows() : [];
    if (parSelection && !coches.length) return;
    const selection = coches.map(achatOfRow);
    running = true;
    const ui = panel();
    let ok = 0;
    let ko = 0;
    const aImprimer = []; // PDF des factures traitées, dans l'ordre du tableau
    const aRegler = []; // mode impression : règlements faits seulement après impression confirmée
    try {
      if (coches.length && selection.some((a) => !a)) {
        throw new Error('Impossible de relier les lignes cochées aux factures : actualisez la page (F5) puis recochez.');
      }
      const [modes, societeBrut, achats] = await Promise.all([
        api('GET', '/ac/rest/achats-simplifies/modes-reglement'),
        nomSociete(),
        coches.length ? Promise.resolve(selection) : listAchatsNonRegles(),
      ]);
      let mode = findMode(modes);
      if (!mode) {
        ui.status('Mode de règlement « Téléchargé » absent de ce dossier');
        const ok = await ui.ask(
          'Ce dossier n\'a pas encore le mode de règlement « Téléchargé ».\n' +
            'Le créer maintenant dans Paramètres > Listes par défaut > Modes de règlement ?\n' +
            '  code TELECHARGE · libellé Téléchargé · délai 0 jour · type Virement · compte comptable 99999999',
          'Créer le mode et continuer'
        );
        if (!ok) {
          ui.line('Annulé : aucun fichier téléchargé.', 'warn');
          return;
        }
        mode = await creerModeTelecharge();
        if (!mode) throw new Error('Le mode TELECHARGE n\'a pas pu être créé (droits insuffisants ?). Créez-le à la main dans Paramètres.');
        ui.line('Mode de règlement « Téléchargé » créé dans ce dossier.', 'ok');
      }
      const societe = cleanName(societeBrut) || 'Dossier MEG';
      const date = today();
      if (!achats.length) {
        ui.status('Aucune facture non réglée : rien à télécharger.');
        return;
      }
      ui.status(
        `${achats.length} facture(s) ${coches.length ? 'cochée(s)' : 'non réglée(s)'} — dossier Téléchargements\\${societe}`
      );

      for (let i = 0; i < achats.length; i++) {
        if (ui.stopped) {
          ui.line(`Arrêt demandé : ${achats.length - i} facture(s) non traitée(s).`, 'warn');
          break;
        }
        const a = achats[i];
        const nom = fileName(a);
        ui.progress(i, achats.length);
        ui.status(`(${i + 1}/${achats.length}) ${nom}`);
        try {
          const detail = await api('GET', '/ac/rest/achats-simplifies/' + a.id);
          const links = detail._links || {};
          if (!linkOk(links['url-document'])) throw new Error('aucun document PDF attaché');
          if (!(detail.echeances || []).length) throw new Error('aucune échéance à régler');
          const dejaReglee = detail.echeances.every((e) => e.statutPaiement === 'REGLE');
          const lienRegl = links['modifier-achat-echeances'];
          if (!dejaReglee && !linkOk(lienRegl)) {
            throw new Error('MEG ne permet pas de modifier le règlement' + (lienRegl && lienRegl.title ? ' (' + lienRegl.title + ')' : ''));
          }

          // 1. Télécharger le PDF et l'enregistrer.
          const { buf, type } = await api('GET', links['url-document'].href, { binary: true });
          if (!isPdf(buf)) throw new Error('le document reçu n\'est pas un PDF (' + (type || 'type inconnu') + ')');
          if (imprimer) aImprimer.push(buf.slice(0));
          const saved = await ATM.download(toDataUrl(buf, 'application/pdf'), `${societe}/${nom}`, 'uniquify');

          // 2. Seulement une fois le fichier écrit : passer la facture en Réglé / Téléchargé.
          const chemin = String((saved && saved.filename) || '');
          const fichier = chemin.split(/[\\/]/).pop();
          // Le nom réel doit être celui demandé (au suffixe « (1) » près) : sinon on ne règle pas.
          const attendu = nom.replace(/\.pdf$/i, '').toLowerCase();
          const obtenu = fichier.replace(/\.pdf$/i, '').replace(/\s\(\d+\)$/, '').toLowerCase();
          if (obtenu !== attendu) {
            throw new Error(
              `fichier enregistré sous « ${fichier} » au lieu du nom demandé : facture laissée non réglée. ` +
                'Mettez à jour l\'extension (icône Atelier MEG → pastille EXT) puis relancez.'
            );
          }
          if (dejaReglee) {
            ok++;
            ui.line(`${fichier} — téléchargée (déjà réglée : règlement inchangé)`, 'ok');
            continue;
          }
          if (imprimer) {
            ok++;
            aRegler.push({ detail, lienRegl, fichier });
            ui.line(`${fichier} — téléchargée (passage en Téléchargé après impression)`, 'ok');
            continue;
          }
          await api('POST', lienRegl.href, {
            body: echeancesReglees(detail, mode.id, date),
          });
          ok++;
          ui.line(`${fichier} — réglée (Téléchargé, ${frDate(date)})`, 'ok');
        } catch (e) {
          ko++;
          if (imprimer && aImprimer.length > ok) aImprimer.length = ok; // facture en erreur : pas imprimée
          ui.line(`${nom} — ${e.message || e}`, 'err');
        }
      }
      ui.progress(1, 1);
      ui.status(`Terminé : ${ok} facture(s) téléchargée(s)` + (ko ? `, ${ko} en erreur` : '') + '.');
      if (imprimer) await imprimerPuisRegler(ui, { aImprimer, aRegler, ko, mode, date });
    } catch (e) {
      ui.status('Erreur');
      ui.line(e.message || String(e), 'err');
    } finally {
      ui.finish();
      running = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Fusion (pdf-lib, module « pdf-lib ») et impression
  // ---------------------------------------------------------------------------
  async function fusionner(buffers) {
    const PDFLib = window.PDFLib;
    if (!PDFLib || !PDFLib.PDFDocument) throw new Error('bibliothèque PDF non chargée : rechargez la page (F5)');
    const doc = await PDFLib.PDFDocument.create();
    for (const b of buffers) {
      const src = await PDFLib.PDFDocument.load(b, { ignoreEncryption: true });
      const pages = await doc.copyPages(src, src.getPageIndices());
      pages.forEach((p) => doc.addPage(p));
    }
    const bytes = await doc.save();
    return URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  }

  // Mode impression : tout téléchargé ? fusion OK ? impression confirmée ? → alors seulement, passage en Téléchargé.
  async function imprimerPuisRegler(ui, { aImprimer, aRegler, ko, mode, date }) {
    if (ui.stopped || ko) {
      ui.line(
        (ui.stopped ? 'Traitement arrêté' : `${ko} facture(s) en erreur`) +
          ' : rien n\'est imprimé et aucune facture n\'est passée en Téléchargé. Les PDF déjà enregistrés restent dans le dossier ; corrigez puis relancez.',
        'warn'
      );
      return;
    }
    if (!aImprimer.length) {
      ui.line('Rien à imprimer.', 'warn');
      return;
    }
    ui.status(`Fusion de ${aImprimer.length} PDF…`);
    let url;
    try {
      url = await fusionner(aImprimer);
    } catch (e) {
      ui.line(`Fusion impossible (${e.message || e}) : aucune facture n'est passée en Téléchargé.`, 'err');
      return;
    }
    ui.offerPdf(() => imprimerPdf(url));
    imprimerPdf(url);
    ui.status('Impression en cours…');
    if (!aRegler.length) {
      ui.line('Fenêtre d\'impression ouverte. Les factures étaient déjà en Téléchargé.', 'ok');
      return;
    }
    const okImpr = await ui.ask(
      `Fenêtre d'impression ouverte (${aImprimer.length} facture(s)).\n` +
        'Une fois l\'impression terminée : s\'est-elle bien passée ?\n' +
        `Les ${aRegler.length} facture(s) seront alors passées en Téléchargé. (Bouton « Réimprimer » en bas si besoin.)`,
      `Oui, passer ${aRegler.length} facture(s) en Téléchargé`
    );
    if (!okImpr) {
      ui.line('Impression non confirmée : aucune facture n\'est passée en Téléchargé (les PDF restent dans le dossier).', 'warn');
      ui.status('Terminé sans changement de statut.');
      return;
    }
    let faits = 0;
    for (const r of aRegler) {
      try {
        await api('POST', r.lienRegl.href, { body: echeancesReglees(r.detail, mode.id, date) });
        faits++;
        ui.line(`${r.fichier} — passée en Téléchargé (${frDate(date)})`, 'ok');
      } catch (e) {
        ui.line(`${r.fichier} — passage en Téléchargé impossible : ${e.message || e}`, 'err');
      }
    }
    ui.status(`Terminé : ${aImprimer.length} facture(s) imprimée(s), ${faits} passée(s) en Téléchargé.`);
  }

  function imprimerPdf(url) {
    const old = document.getElementById('atm-print-frame');
    if (old) old.remove();
    const f = el('iframe', 'position:fixed;right:0;bottom:0;width:2px;height:2px;border:0;opacity:0;pointer-events:none');
    f.id = 'atm-print-frame';
    f.onload = () =>
      setTimeout(() => {
        try {
          f.contentWindow.focus();
          f.contentWindow.print();
        } catch (e) {
          window.open(url, '_blank');
        }
      }, 600);
    f.src = url;
    document.body.appendChild(f);
  }

  // ---------------------------------------------------------------------------
  // Bouton dans la page Achats simplifiés (appli monopage : on surveille le DOM)
  // ---------------------------------------------------------------------------
  function findImporter() {
    return [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Importer');
  }

  const btnStyle = (h) =>
    'display:inline-flex;align-items:center;gap:6px;background:#fff;color:#5b45f5;border:1px solid #5b45f5;' +
    'border-radius:6px;padding:0 12px;height:' + (h || 32) + 'px;font:600 13px system-ui,Segoe UI,Arial;cursor:pointer;white-space:nowrap';

  function ensureButton() {
    const existing = document.getElementById(BTN_ID);
    if (!isLga()) {
      if (existing) existing.remove();
      const ep = document.getElementById(BTN_ID + '-print');
      if (ep) ep.remove();
      hidePreview(true);
      return;
    }
    if (existing) return;
    const importer = findImporter();
    if (!importer || !importer.parentElement) return;
    const b = el('button', btnStyle(importer.offsetHeight) + ';margin-right:8px', '⬇ Télécharger les factures');
    b.id = BTN_ID;
    b.type = 'button';
    b.title = 'Télécharge toutes les factures non téléchargées dans Téléchargements\\<Société>, puis les passe en Téléchargé';
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      run();
    });
    importer.parentElement.insertBefore(b, importer);
    const p = el('button', btnStyle(importer.offsetHeight) + ';margin-right:8px', '🖨 Télécharger et imprimer');
    p.id = BTN_ID + '-print';
    p.type = 'button';
    p.title = 'Télécharge toutes les factures non téléchargées, fusionne les PDF et ouvre l\'impression ; passage en Téléchargé après confirmation de l\'impression';
    p.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      run({ imprimer: true });
    });
    importer.parentElement.insertBefore(p, importer);
  }

  // Bandeau « n éléments sélectionnés » de MEG : la suppression est masquée (CSS),
  // on y met « Télécharger la sélection ».
  const MASS_BTN_ID = 'atm-mass-dl';
  function ensureMassButton() {
    if (!isLga()) return;
    const zone = document.getElementById('mass-action-buttons');
    if (!zone) return;
    let b = document.getElementById(MASS_BTN_ID);
    if (!b) {
      b = el('button', btnStyle(30) + ';border-color:#fff');
      b.id = MASS_BTN_ID;
      b.type = 'button';
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        run({ selection: true });
      });
      zone.appendChild(b);
    }
    let p = document.getElementById(MASS_BTN_ID + '-print');
    if (!p) {
      p = el('button', btnStyle(30) + ';border-color:#fff;margin-left:8px');
      p.id = MASS_BTN_ID + '-print';
      p.type = 'button';
      p.title = 'Télécharge la sélection, puis fusionne les PDF et ouvre l\'impression';
      p.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        run({ selection: true, imprimer: true });
      });
      zone.appendChild(p);
    }
    const n = selectedRows().length;
    const label = `⬇ Télécharger la sélection (${n})`;
    if (b.textContent !== label) b.textContent = label;
    const labelP = `🖨 Télécharger et imprimer (${n})`;
    if (p.textContent !== labelP) p.textContent = labelP;
  }

  // ---------------------------------------------------------------------------
  // Affichage personnalisé LGA / affichage classique
  // ---------------------------------------------------------------------------
  const MODE_KEY = 'atm-meg-affichage';
  const TOGGLE_ID = 'atm-affichage-toggle';
  const STYLE_ID = 'atm-lga-style';
  // Paramètres d'URL conservés en LGA (les filtres masqués sont dans l'URL : etat=…, etc.).
  // Filtres masqués en LGA (paramètres d'URL de MEG) : seuls ceux-ci sont retirés. Liste fermée : un paramètre
  // inconnu (connexion OIDC code/state, etc.) n'est JAMAIS touché.
  const URL_FILTRES_MASQUES = /^(etat|affectation|liaisonBancaire|source|comptes?(Comptables?)?|periode.*|date.*)$/i;
  const URL_CONNEXION = /^(code|state|session_state|iss|error|error_description)$/i;
  const RELOAD_GUARD = 'atm-lga-reload';
  function modeLga() {
    try {
      return localStorage.getItem(MODE_KEY) !== 'classique';
    } catch (e) {
      return true;
    }
  }
  const onPage = () => PAGE_RE.test(location.pathname);
  const isLga = () => onPage() && modeLga();

  const LGA_CSS = `
html.atm-lga achat-achats [id$="bouton-export-excel"],
html.atm-lga achat-achats [id$="bouton-import"],
html.atm-lga achat-achats [id$="bouton-menu-actions"],
html.atm-lga achat-statistiques-achats,
html.atm-lga achat-barre-filtres form > div > mat-form-field:not(:has(input[formcontrolname="recherche"])),
html.atm-lga achat-liste-achats .cdk-column-etatAffectation,
html.atm-lga achat-liste-achats .cdk-column-liaisonBancaire,
html.atm-lga achat-liste-achats .cdk-column-comptesComptables,
html.atm-lga achat-liste-achats .cdk-column-sourceAffichee,
html.atm-lga achat-liste-achats .cdk-column-dateAjout,
html.atm-lga #mass-action-buttons > :not([id^="${MASS_BTN_ID}"]) { display: none !important; }
`;

  function filtresMasquesDansUrl() {
    const keys = [...new URLSearchParams(location.search).keys()];
    if (keys.some((k) => URL_CONNEXION.test(k))) return false; // connexion en cours : ne rien toucher
    if (!keys.some((k) => URL_FILTRES_MASQUES.test(k))) return false;
    // Garde-fou : au plus un rechargement par minute.
    try {
      const last = Number(sessionStorage.getItem(RELOAD_GUARD) || 0);
      if (Date.now() - last < 60e3) return false;
    } catch (e) {
      return false;
    }
    return true;
  }
  function noteReload() {
    try {
      sessionStorage.setItem(RELOAD_GUARD, String(Date.now()));
    } catch (e) {}
  }
  function urlSansFiltresMasques() {
    const q = new URLSearchParams(location.search);
    for (const k of [...q.keys()]) if (URL_FILTRES_MASQUES.test(k)) q.delete(k);
    const qs = q.toString();
    return location.pathname + (qs ? '?' + qs : '') + location.hash;
  }

  function setMode(lga) {
    try {
      localStorage.setItem(MODE_KEY, lga ? 'lga' : 'classique');
    } catch (e) {}
    // Rechargement : l'affichage classique est le MEG d'origine, sans aucun reste de l'extension.
    if (lga && filtresMasquesDansUrl()) {
      noteReload();
      location.replace(urlSansFiltresMasques());
    }
    else location.reload();
  }

  function applyMode() {
    const lga = isLga();
    document.documentElement.classList.toggle('atm-lga', lga);
    if (lga && !document.getElementById(STYLE_ID)) {
      const st = el('style');
      st.id = STYLE_ID;
      st.textContent = LGA_CSS;
      (document.head || document.documentElement).appendChild(st);
    }
    // Arrivée sur la page en LGA avec des filtres masqués actifs (lien, historique…) : on les vide.
    if (lga && filtresMasquesDansUrl()) {
      noteReload();
      history.replaceState(history.state, '', urlSansFiltresMasques());
      location.reload();
      return;
    }
    ensureToggle();
  }

  function ensureToggle() {
    let box = document.getElementById(TOGGLE_ID);
    if (!onPage()) {
      if (box) box.remove();
      return;
    }
    const h2 = document.querySelector('achat-achats h2');
    if (!h2 || !h2.parentElement) return;
    const lga = modeLga();
    if (box && box.dataset.mode === (lga ? 'lga' : 'classique')) return;
    if (box) box.remove();
    box = el('div', 'display:flex;align-items:center;gap:10px;margin:0 auto 0 18px;font:13px system-ui,Segoe UI,Arial');
    box.id = TOGGLE_ID;
    box.dataset.mode = lga ? 'lga' : 'classique';
    if (lga) {
      box.appendChild(el('span', 'background:#ede9fe;color:#5b45f5;font-weight:600;border-radius:12px;padding:4px 12px', 'Affichage personnalisé LGA'));
      const b = el('button', 'background:none;border:0;color:#6b7280;text-decoration:underline;cursor:pointer;font:inherit;padding:0', 'Affichage classique');
      b.type = 'button';
      b.title = 'Revenir à l\'affichage MEG d\'origine';
      b.onclick = () => setMode(false);
      box.appendChild(b);
    } else {
      const b = el('button', btnStyle(28), 'Affichage personnalisé LGA');
      b.type = 'button';
      b.title = 'Page Achats épurée : téléchargement des factures, aperçu au survol';
      b.onclick = () => setMode(true);
      box.appendChild(b);
    }
    h2.insertAdjacentElement('afterend', box);
  }

  // ---------------------------------------------------------------------------
  // Aperçu du PDF au survol de la colonne « Nom du fichier »
  // ---------------------------------------------------------------------------
  const PREVIEW_ID = 'atm-achats-preview';
  const pdfCache = new Map(); // id → URL blob (les 20 derniers)
  let hoverTimer = null;
  let hideTimer = null;
  let currentId = null;

  async function pdfUrl(achat) {
    if (pdfCache.has(achat.id)) return pdfCache.get(achat.id);
    const { buf } = await api('GET', `/ac/rest/achats-simplifies/${achat.id}/telecharger-document`, { binary: true });
    if (!isPdf(buf)) throw new Error('document non PDF');
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/pdf' }));
    pdfCache.set(achat.id, url);
    if (pdfCache.size > 20) {
      const [k, u] = pdfCache.entries().next().value;
      URL.revokeObjectURL(u);
      pdfCache.delete(k);
    }
    return url;
  }

  function previewBox() {
    let box = document.getElementById(PREVIEW_ID);
    if (box) return box;
    box = el(
      'div',
      'position:fixed;z-index:2147483600;width:max(360px,34vw);height:88vh;background:#fff;border-radius:8px;' +
        'box-shadow:0 14px 40px rgba(0,0,0,.35);display:none;flex-direction:column;overflow:hidden;font:12px system-ui,Segoe UI,Arial'
    );
    box.id = PREVIEW_ID;
    const head = el('div', 'display:flex;align-items:center;gap:8px;padding:4px 6px 4px 10px;background:#5b45f5;color:#fff;font-weight:600');
    const title = el('span', 'flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis');
    const close = el('button', 'flex:none;width:26px;height:26px;border:0;border-radius:5px;background:rgba(255,255,255,.18);color:#fff;font:700 15px/1 system-ui;cursor:pointer', '✕');
    close.type = 'button';
    close.title = 'Fermer l\'aperçu (Échap)';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      hidePreview(true);
    });
    head.append(title, close);
    const body = el('div', 'flex:1;position:relative;background:#525659');
    box.append(head, body);
    box.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    box.addEventListener('mouseleave', () => hidePreview());
    document.body.appendChild(box);
    return box;
  }

  function placeBox(box, td) {
    const r = td.getBoundingClientRect();
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    // Colonne « Nom du fichier » à droite du tableau : aperçu à gauche de la cellule si possible.
    let left = r.left - w - 12;
    if (left < 8) left = Math.min(r.right + 12, window.innerWidth - w - 8);
    let top = Math.min(Math.max(8, r.top - h / 3), window.innerHeight - h - 8);
    box.style.left = Math.max(8, left) + 'px';
    box.style.top = Math.max(8, top) + 'px';
  }

  async function showPreview(td) {
    const tr = td.closest('tr');
    const achat = tr && achatOfRow(tr);
    if (!achat || !achat.document) return;
    const box = previewBox();
    const [head, body] = box.children;
    currentId = achat.id;
    head.firstChild.textContent = fileName(achat).replace(/\.pdf$/, '');
    body.replaceChildren(el('div', 'color:#fff;padding:16px', 'Chargement du PDF…'));
    box.style.display = 'flex';
    placeBox(box, td);
    try {
      const url = await pdfUrl(achat);
      if (currentId !== achat.id || box.style.display === 'none') return;
      const f = el('iframe', 'border:0;width:100%;height:100%;position:absolute;inset:0');
      f.src = url + '#toolbar=0&navpanes=0&view=FitH';
      body.replaceChildren(f);
    } catch (e) {
      if (currentId === achat.id) body.replaceChildren(el('div', 'color:#fecaca;padding:16px', 'Aperçu impossible : ' + (e.message || e)));
    }
  }

  function hidePreview(now) {
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    const go = () => {
      const box = document.getElementById(PREVIEW_ID);
      if (box) {
        box.style.display = 'none';
        box.children[1].replaceChildren();
      }
      currentId = null;
    };
    if (now) go();
    else hideTimer = setTimeout(go, 250);
  }

  function installHover() {
    document.addEventListener('mouseover', (e) => {
      if (!isLga()) return;
      const td = e.target.closest && e.target.closest('td.cdk-column-nomFichier');
      if (!td) return;
      clearTimeout(hideTimer);
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => showPreview(td), 350);
    });
    document.addEventListener('mouseout', (e) => {
      const td = e.target.closest && e.target.closest('td.cdk-column-nomFichier');
      if (!td || (e.relatedTarget && td.contains(e.relatedTarget))) return;
      clearTimeout(hoverTimer);
      hidePreview();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hidePreview(true);
    });
    // Cases à cocher : le libellé du bouton du bandeau suit la sélection.
    document.addEventListener('change', () => setTimeout(ensureMassButton, 0), true);
    document.addEventListener('click', () => setTimeout(ensureMassButton, 50), true);
  }

  // ---------------------------------------------------------------------------
  // Colonne « Téléchargé par » (journal des évènements MEG)
  // ---------------------------------------------------------------------------
  const COL_CLASS = 'atm-col-telecharge';
  let journal = null; // N° facture → { user, date } du dernier passage en Réglé
  let journalEnt = null;
  let journalLoading = false;
  const STATUT_RE = /statut de la facture (.+?) qui passe de (.+?) à (.+?)\.?\s*$/;

  async function loadJournal() {
    if (!isLga() || !auth.token || !auth.ent || journalLoading) return;
    if (journal && journalEnt === auth.ent) return;
    journalLoading = true;
    try {
      const d = new Date();
      const fin = new Date(d.getTime() + 86400e3);
      const debut = new Date(d.getFullYear() - 3, d.getMonth(), 1);
      const iso = (x) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
      const r = await api('GET', `/ac/rest/journalEvenements?dateDebut=${iso(debut)}&dateFin=${iso(fin)}`);
      const evts = ((r && r.listeEvenementsBean) || []).slice().sort((a, b) => String(a.dateHeure).localeCompare(String(b.dateHeure)));
      const map = new Map();
      for (const e of evts) {
        const m = STATUT_RE.exec(e.evenement || '');
        if (!m) continue;
        if (m[3].trim() === 'Réglé') map.set(m[1].trim(), { user: e.utilisateur || '?', date: e.dateHeure });
        else map.delete(m[1].trim());
      }
      journal = map;
      journalEnt = auth.ent;
      renderJournalColumn();
    } catch (e) {
      ATM.log('journal des évènements illisible :', e.message || e);
    } finally {
      journalLoading = false;
    }
  }

  function fmtDateHeure(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || '');
    return m ? `le ${m[3]}/${m[2]}/${m[1]} à ${m[4]}:${m[5]}` : '';
  }

  function renderJournalColumn() {
    if (!isLga()) return;
    const table = document.querySelector('achat-liste-achats table');
    if (!table) return;
    const anchorCol = (row, tag) =>
      row.querySelector(`${tag}.cdk-column-dateReglement`) || row.querySelector(`${tag}.cdk-column-etat`);
    const hr = table.querySelector('thead tr');
    if (hr && !hr.querySelector('th.' + COL_CLASS)) {
      const a = anchorCol(hr, 'th');
      if (a) {
        const th = el('th', 'white-space:nowrap', 'Téléchargé par');
        th.className = 'mat-mdc-header-cell mdc-data-table__header-cell cdk-header-cell ' + COL_CLASS;
        th.title = 'Utilisateur qui a passé la facture en Téléchargé (journal des évènements MEG)';
        a.insertAdjacentElement('afterend', th);
      }
    }
    for (const tr of table.querySelectorAll('tbody tr.mat-mdc-row')) {
      let td = tr.querySelector('td.' + COL_CLASS);
      if (!td) {
        const a = anchorCol(tr, 'td');
        if (!a) continue;
        td = el('td', 'white-space:nowrap');
        td.className = 'mat-mdc-cell mdc-data-table__cell cdk-cell ' + COL_CLASS;
        a.insertAdjacentElement('afterend', td);
      }
      const num = cellText(tr, 'numeroFacture');
      const info = journal && journal.get(num);
      const text = info ? info.user : journal ? '-' : '…';
      if (td.textContent !== text) td.textContent = text;
      const title = info ? `Téléchargée par ${info.user} ${fmtDateHeure(info.date)}` : '';
      if (td.title !== title) td.title = title;
    }
  }

  // ---------------------------------------------------------------------------
  // Libellés : « réglé » devient « téléchargé » ; onglets inutiles masqués
  // ---------------------------------------------------------------------------
  const CHIP_LABELS = { 'Non réglé': 'Non téléchargé', 'Réglé': 'Téléchargé' };
  const TAB_LABELS = [
    [/^À régler(\s*\(\d+\))?$/, 'À télécharger'],
    [/^Réglé(\s*\(\d+\))?$/, 'Téléchargé'],
  ];
  const HIDDEN_TABS = /^À (traiter|affecter)(\s*\(\d+\))?$/;

  function setText(node, text) {
    // Remplace le texte du premier nœud texte non vide (garde les commentaires Angular).
    const tn = [...node.childNodes].find((n) => n.nodeType === 3 && n.data.trim());
    if (tn && tn.data !== text) tn.data = text;
  }

  function relabel() {
    if (!isLga()) return;
    for (const c of document.querySelectorAll('rca-chips .chips-content')) {
      const t = c.textContent.trim();
      if (CHIP_LABELS[t]) setText(c, CHIP_LABELS[t] + ' ');
    }
    for (const lab of document.querySelectorAll('[role=tab] .mdc-tab__text-label')) {
      const t = lab.textContent.trim();
      const tab = lab.closest('[role=tab]');
      if (HIDDEN_TABS.test(t)) {
        if (tab.style.display !== 'none') tab.style.display = 'none';
        continue;
      }
      for (const [re, label] of TAB_LABELS) {
        const m = t.match(re);
        if (m) setText(lab, label + (m[1] || ''));
      }
    }
  }

  ATM.onReady(() => {
    let t = null;
    let lastPath = location.pathname;
    new MutationObserver(() => {
      if (location.pathname !== lastPath) {
        lastPath = location.pathname;
        applyMode();
      }
      relabel();
      ensureMassButton();
      renderJournalColumn();
      clearTimeout(t);
      t = setTimeout(() => {
        ensureToggle();
        ensureButton();
        loadJournal();
      }, 150);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    applyMode();
    relabel();
    installHover();
    ensureButton();
  });
})();
