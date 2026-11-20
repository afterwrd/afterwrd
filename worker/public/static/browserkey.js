// This browser's key (afterwrd 2: docs/signed-conversations.md, section 1). It's made here at sign-in, kept in
// IndexedDB, and can never be copied out, not even by this page: the browser keeps the private half and only signs
// with it. One passkey prompt at sign-in lets it sign for the owner for 30 days (src/keys.js); everything it signs
// goes out through the owner's own site, which stops passing on what it signs as soon as the browser signs out.
//
// Without IndexedDB (some private windows) the key lasts only as long as the page: signing in again makes another.
import { newKeyPair, publicKeyText } from "./signed.js";

const DB = "afterwrd-keys";
const STORE = "keys";
const ID = "browser";

/** @typedef {{ privateKey: CryptoKey, publicKey: string, person: string | null, expires: number }} BrowserKey */

/** @returns {Promise<IDBDatabase>} */
function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** @param {IDBTransactionMode} mode @param {(store: IDBObjectStore) => IDBRequest} act */
async function use(mode, act) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const request = act(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

/** The key this browser has, if any. @returns {Promise<BrowserKey | null>} */
export async function savedKey() {
  try { return (await use("readonly", (s) => s.get(ID))) ?? null; } catch { return null; }
}

/** A new key for this browser, replacing any it had; not yet allowed to sign for anyone. @returns {Promise<BrowserKey>} */
export async function newBrowserKey() {
  const pair = await newKeyPair(false);
  const key = { privateKey: pair.privateKey, publicKey: await publicKeyText(pair.publicKey), person: null, expires: 0 };
  try { await use("readwrite", (s) => s.put(key, ID)); } catch {}
  return key;
}

/** Notes that `key` may now sign for `person` until `expires` (seconds), once the site has said so. @param {BrowserKey} key */
export async function keyAllowed(key, person, expires) {
  try { await use("readwrite", (s) => s.put({ ...key, person, expires }, ID)); } catch {}
}

/** Forgets this browser's key: on signing out, so a shared computer keeps nothing that signs. */
export async function forgetKey() {
  try { await use("readwrite", (s) => s.delete(ID)); } catch {}
}
