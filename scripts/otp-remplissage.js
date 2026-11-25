// ==UserScript==
// @name         Remplissage du code de sécurité MEG (OTP)
// @namespace    https://nicolas.chassard/meg
// @version      1.0.0
// @description  v1.0.0 (2026-11-25) : sur la page de connexion RCA/MEG, remplit automatiquement le code de sécurité à
//               6 chiffres à partir de la clé secrète enregistrée dans l'extension, et coche « se souvenir de cet
//               appareil ». Nécessite l'extension ≥ 2.1.0 et une clé saisie dans la fenêtre de l'extension.
// @author       Nicolas
// @match        https://connect.monespace.rca.fr/*
// @run-at       document-idle
// @noframes
// ==/UserScript==

// CHANGELOG
// 1.0.0 (2026-11-25) — première version. Le secret n'est jamais dans la page : l'extension (service worker) renvoie
//                      seulement les 6 chiffres via ATM.call('otp-code'). Ne valide pas le formulaire : l'utilisateur
//                      clique lui-même (réglage otpAutoSubmit pour valider automatiquement, désactivé par défaut).

(function () {
  'use strict';
  if (window.__atmOtp) return;
  window.__atmOtp = true;

  const TOAST_ID = 'atm-otp-toast';
  let lastFilled = ''; // dernier code que NOUS avons écrit (pour ne pas écraser la saisie de l'utilisateur)

  // Champ de saisie du code à 6 chiffres (heuristique tolérante : la page RCA n'est pas connue à l'avance).
  function champOtp() {
    const inputs = [...document.querySelectorAll('input')].filter((i) => {
      const t = (i.type || 'text').toLowerCase();
      if (['hidden', 'password', 'checkbox', 'radio', 'submit', 'button', 'email'].includes(t)) return false;
      if (i.disabled || i.readOnly || i.offsetParent === null) return false;
      const sign = `${i.name} ${i.id} ${i.getAttribute('autocomplete') || ''} ${i.getAttribute('aria-label') || ''} ${i.placeholder || ''}`.toLowerCase();
      if (/one-time-code|otp|totp|mfa|2fa|authentification|securit|verification|vérification|code/.test(sign)) return true;
      const ml = parseInt(i.getAttribute('maxlength') || '0', 10);
      if ((i.inputMode === 'numeric' || t === 'tel' || t === 'number') && ml >= 4 && ml <= 8) return true;
      return false;
    });
    // Cas « une case par chiffre » : plusieurs champs maxlength=1 → on ne gère pas (rare), on laisse l'utilisateur.
    const simple = inputs.filter((i) => (parseInt(i.getAttribute('maxlength') || '0', 10) || 9) > 1);
    return simple[0] || null;
  }

  function caseSouvenir() {
    for (const cb of document.querySelectorAll('input[type=checkbox]')) {
      if (cb.disabled || cb.offsetParent === null) continue;
      const lab =
        (cb.labels && cb.labels[0] && cb.labels[0].textContent) ||
        (cb.closest('label') && cb.closest('label').textContent) ||
        (cb.id && (document.querySelector(`label[for="${cb.id}"]`) || {}).textContent) ||
        cb.getAttribute('aria-label') ||
        '';
      if (/souvenir|confiance|cet appareil|ce navigateur|\bjours\b|remember|trust this/i.test(lab)) return cb;
    }
    return null;
  }

  function setValue(input, value) {
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }

  function toast(message, withButton) {
    let t = document.getElementById(TOAST_ID);
    if (!t) {
      t = el('div', 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;display:flex;gap:10px;align-items:center;' +
        'background:#5b45f5;color:#fff;padding:10px 14px;border-radius:8px;font:13px/1.4 system-ui,Segoe UI,Arial;box-shadow:0 6px 20px rgba(0,0,0,.3)');
      t.id = TOAST_ID;
      document.body.appendChild(t);
    }
    t.replaceChildren(el('span', 'flex:1', message));
    if (withButton) {
      const b = el('button', 'background:#fff;color:#5b45f5;border:0;border-radius:6px;padding:5px 10px;font:600 13px system-ui;cursor:pointer', 'Remplir le code');
      b.onclick = () => remplir(true);
      t.appendChild(b);
    }
    clearTimeout(t.__timer);
    t.__timer = setTimeout(() => t.remove(), 12000);
  }

  let enCours = false;
  async function remplir(forcer) {
    if (enCours) return;
    const input = champOtp();
    if (!input) return;
    // Ne pas écraser ce que l'utilisateur a tapé lui-même.
    if (!forcer && input.value && input.value !== lastFilled) return;
    if (!forcer && input.value === lastFilled && lastFilled) return;
    enCours = true;
    try {
      const r = await ATM.call('otp-code');
      if (!r || !r.hasSecret) {
        toast('Atelier MEG : aucun code de sécurité enregistré (cliquez sur l\'icône de l\'extension pour le configurer).');
        return;
      }
      setValue(input, r.code);
      lastFilled = r.code;
      try { input.focus(); } catch (e) {}
      const cb = caseSouvenir();
      if (cb && !cb.checked) {
        cb.click();
      }
      const autoSubmit = ATM.settings && ATM.settings.otpAutoSubmit;
      if (autoSubmit) {
        const form = input.closest('form');
        const btn = form && (form.querySelector('button[type=submit],input[type=submit]') ||
          [...form.querySelectorAll('button')].find((b) => /valider|connexion|continuer|vérifier|verifier/i.test(b.textContent)));
        if (btn) setTimeout(() => btn.click(), 150);
      }
      toast(`Atelier MEG : code rempli${cb ? ' · appareil mémorisé' : ''}. Vérifiez puis validez.`, true);
    } catch (e) {
      toast('Atelier MEG : code non rempli (' + (e.message || e) + ').', true);
    } finally {
      enCours = false;
    }
  }

  ATM.onReady(() => {
    let t = null;
    const planifier = () => {
      clearTimeout(t);
      t = setTimeout(() => remplir(false), 200);
    };
    new MutationObserver(planifier).observe(document.documentElement, { childList: true, subtree: true });
    planifier();
  });
})();
