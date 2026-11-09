// Dropbox sign-in (OAuth2 code + PKCE, no server) and one-file storage.
import { DROPBOX_APP_KEY, REDIRECT_URI, DATA_PATH } from './config.js';

const LS = 'arthik.dropbox';
const rand = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return a; };
const b64url = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function load() { try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch { return null; } }
function save(t) { try { localStorage.setItem(LS, JSON.stringify(t)); } catch {} }

export function isSignedIn() { return !!(load() && load().refresh_token); }
export function signOut() { try { localStorage.removeItem(LS); } catch {} }

export async function startSignIn() {
  const verifier = b64url(rand(48));
  const state = b64url(rand(12));
  sessionStorage.setItem('arthik.pkce', JSON.stringify({ verifier, state }));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const q = new URLSearchParams({
    client_id: DROPBOX_APP_KEY, response_type: 'code', redirect_uri: REDIRECT_URI,
    code_challenge: challenge, code_challenge_method: 'S256', token_access_type: 'offline', state,
  });
  location.href = 'https://www.dropbox.com/oauth2/authorize?' + q;
}

/** Call on page load. Returns true if it just completed a sign-in. */
export async function finishSignInIfReturning() {
  const p = new URLSearchParams(location.search);
  if (!p.has('code') && !p.has('error')) return false;
  const stored = JSON.parse(sessionStorage.getItem('arthik.pkce') || 'null');
  history.replaceState(null, '', location.pathname + location.hash);
  if (p.has('error')) throw new Error('Dropbox sign-in was cancelled or refused: ' + (p.get('error_description') || p.get('error')));
  if (!stored || stored.state !== p.get('state')) throw new Error('Sign-in could not be verified. Please try again.');
  sessionStorage.removeItem('arthik.pkce');
  const body = new URLSearchParams({
    code: p.get('code'), grant_type: 'authorization_code', client_id: DROPBOX_APP_KEY,
    redirect_uri: REDIRECT_URI, code_verifier: stored.verifier,
  });
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body });
  if (!r.ok) throw new Error('Dropbox did not accept the sign-in (' + r.status + ').');
  const j = await r.json();
  save({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in - 60) * 1000 });
  return true;
}

async function token() {
  const t = load();
  if (!t) throw new Error('NOT_SIGNED_IN');
  if (t.access_token && Date.now() < t.expires_at) return t.access_token;
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: DROPBOX_APP_KEY });
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body });
  if (!r.ok) { signOut(); throw new Error('NOT_SIGNED_IN'); }
  const j = await r.json();
  const n = { ...t, access_token: j.access_token, expires_at: Date.now() + (j.expires_in - 60) * 1000 };
  save(n);
  return n.access_token;
}

/** -> {text, rev, modified} or null when the file does not exist yet. */
export async function download() {
  const r = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST', headers: { Authorization: 'Bearer ' + await token(), 'Dropbox-API-Arg': JSON.stringify({ path: DATA_PATH }) },
  });
  if (r.status === 409) return null;
  if (!r.ok) throw new Error('Could not read your file from Dropbox (' + r.status + ').');
  let meta = {};
  try { meta = JSON.parse(r.headers.get('Dropbox-API-Result') || '{}'); } catch {}
  if (!meta.rev) {   // header not readable in this browser: ask for the file's details instead
    const m = await fetch('https://api.dropboxapi.com/2/files/get_metadata', {
      method: 'POST', headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json' }, body: JSON.stringify({ path: DATA_PATH }) });
    if (m.ok) meta = await m.json();
  }
  return { text: await r.text(), rev: meta.rev, modified: meta.server_modified };
}

/** Writes the file. rev=null creates it; otherwise it only overwrites that exact version.
 *  Throws Error('CONFLICT') if the file changed on another device meanwhile. */
export async function upload(text, rev) {
  const arg = { path: DATA_PATH, mode: rev ? { '.tag': 'update', update: rev } : 'add', autorename: false, mute: true };
  const r = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + await token(), 'Dropbox-API-Arg': JSON.stringify(arg), 'Content-Type': 'application/octet-stream' },
    body: new TextEncoder().encode(text),
  });
  if (r.status === 409) throw new Error('CONFLICT');
  if (!r.ok) throw new Error('Could not save to Dropbox (' + r.status + ').');
  const j = await r.json();
  return { rev: j.rev, modified: j.server_modified };
}
