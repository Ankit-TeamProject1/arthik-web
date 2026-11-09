// Settings for this deployment. The App key is public by design (it is not a secret).
export const APP_VERSION = '0.5.0';
export const DROPBOX_APP_KEY = 'n1uf7sh1f66bm3u';
// Sign-in comes back to the folder this app is served from.
export const REDIRECT_URI = location.origin + location.pathname.replace(/index\.html$/, '');
export const DATA_PATH = '/arthik-data.json';   // inside Dropbox > Apps > Arthik
export const AUTO_LOCK_MS = 5 * 60 * 1000;
