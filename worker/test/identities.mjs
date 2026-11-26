// An identity's address is only its own claim until this site fetches it from there (security review 2026-11 H1):
// learnt second-hand (a friend's or group's `people`, a comment note), an identity that names someone else's address
// mustn't make signed calls "from" that address check. Run with the repo's own code over node:sqlite, no network:
//   node --no-warnings test/identities.mjs
import { DatabaseSync } from "node:sqlite";
import * as signed from "../public/static/signed.js";
import * as records from "../public/static/records.js";
import * as identities from "../src/identities.js";
import * as signedcalls from "../src/signedcalls.js";

const { b64url, concat, encode, fingerprintOf, fromB64url, newKeyPair, publicKeyText, recoveryKey, newRecoveryCode, sha256, statementsChallenge, utf8 } = signed;
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`); };

// A tiny D1 stand-in: the tables these modules use, as the migrations make them.
class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.params = []; }
  bind(...p) { this.params = p.map((v) => (typeof v === "boolean" ? Number(v) : v)); return this; }
  async first() { const r = this.db.prepare(this.sql).get(...this.params); return r ? { ...r } : null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.params).map((r) => ({ ...r })) }; }
  async run() {
    if (/RETURNING/i.test(this.sql)) { const rows = this.db.prepare(this.sql).all(...this.params).map((r) => ({ ...r })); return { results: rows, meta: { changes: rows.length } }; }
    const r = this.db.prepare(this.sql).run(...this.params); return { results: [], meta: { changes: Number(r.changes) } };
  }
}
function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE identities (person TEXT PRIMARY KEY, origin TEXT NOT NULL, chain TEXT NOT NULL, origin_checked_at INTEGER, frozen_at INTEGER,
      profile TEXT, updated_at INTEGER NOT NULL, moving_to TEXT, moving_at INTEGER);
    CREATE TABLE identity_seen (fp TEXT PRIMARY KEY, first_seen INTEGER NOT NULL);
    CREATE TABLE learning (host TEXT, day INTEGER, n INTEGER, PRIMARY KEY (host, day));
    CREATE TABLE known_delegations (key TEXT, person TEXT, bytes TEXT, proof TEXT, expires_at INTEGER, learnt_at INTEGER, PRIMARY KEY (key, person));
  `);
  return { prepare: (sql) => new Stmt(db, sql), async batch(s) { const out = []; for (const x of s) out.push(await x.run()); return out; } };
}

// A software passkey made at `origin` (P-256), as test/e2e/keys.mjs makes one.
function der(raw) {
  const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.subarray(i); return b[0] & 0x80 ? concat(new Uint8Array([0]), b) : b; };
  const r = int(raw.subarray(0, 32)), s = int(raw.subarray(32));
  const body = concat(new Uint8Array([0x02, r.length]), r, new Uint8Array([0x02, s.length]), s);
  return concat(new Uint8Array([0x30, body.length]), body);
}
async function softPasskey(origin) {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const cose = concat(new Uint8Array([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), fromB64url(jwk.x), new Uint8Array([0x22, 0x58, 0x20]), fromB64url(jwk.y));
  const id = b64url(crypto.getRandomValues(new Uint8Array(16)));
  return {
    passkey: { id, key: b64url(cose), origin },
    async sign(statements) {
      const nonce = b64url(crypto.getRandomValues(new Uint8Array(24)));
      const clientData = utf8(JSON.stringify({ type: "webauthn.get", challenge: await statementsChallenge(nonce, statements), origin, crossOrigin: false }));
      const authData = concat(await sha256(utf8(new URL(origin).hostname)), new Uint8Array([0x05, 0, 0, 0, 0]));
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, concat(authData, await sha256(clientData))));
      return { credential: id, nonce, statements, response: { authenticatorData: b64url(authData), clientDataJSON: b64url(clientData), signature: b64url(der(raw)) } };
    },
  };
}
/** Someone whose identity says it's at `origin`, its passkey made at `passkeyOrigin`. */
async function person(origin, passkeyOrigin = origin) {
  const pk = await softPasskey(passkeyOrigin);
  const hosting = await newKeyPair(true);
  const doc0 = encode({ v: 2, kind: "identity", seq: 0, prev: null, origin, passkeys: [pk.passkey],
    recovery: (await recoveryKey(newRecoveryCode())).publicKey, hosting: await publicKeyText(hosting.publicKey) });
  const id = await fingerprintOf("identity", doc0);
  return { pk, hosting, chain: [{ bytes: doc0, sig: { passkey: await pk.sign([id]) } }], id };
}
const wire = (chain) => chain.map((d) => ({ bytes: b64url(d.bytes), sig: d.sig }));

const ANN = "https://ann.example", BOB = "https://bob.example", MAL = "https://mallory.example";
const env = { DB: d1() };
// The network: each site's /.well-known/afterwrd, as the real sites would answer; anything else fails.
const served = new Map();
let fetched = [];
globalThis.fetch = async (u) => {
  const url = new URL(String(u));
  fetched.push(url.origin);
  const chain = url.pathname === "/.well-known/afterwrd" && served.get(url.origin);
  if (!chain) throw new Error("no such site");
  return new Response(JSON.stringify({ chain: wire(chain) }), { headers: { "Content-Type": "application/json" } });
};
async function call(from, who) {
  const body = JSON.stringify({ via: { introduction: true } });
  const url = `${ANN}/_connect/ask`;
  const headers = new Headers(await signedcalls.signCall({ method: "POST", url, body, person: who.id, from, privateKey: who.hosting.privateKey }));
  fetched = [];
  return signedcalls.checkCall({ method: "POST", url, headers, body: new TextEncoder().encode(body) },
    { ownOrigin: ANN, hostingKeyOf: (p, s, o) => identities.hostingKeyFor(env, p, s, o) });
}

const bob = await person(BOB);
served.set(BOB, bob.chain);
// Mallory's identity names Bob's address; its passkey and browser key are Mallory's. It reaches Ann's site second-hand,
// with a comment it signed (a friend's or group's answer).
const m = await person(BOB, MAL);
const bk = await newKeyPair(false);
const bkPub = await publicKeyText(bk.publicKey);
const delegation = encode({ v: 2, kind: "delegation", person: m.id, key: bkPub, origin: MAL, expires: Math.floor(Date.now() / 1000) + 30 * 86400 });
const dProof = await m.pk.sign([await fingerprintOf("delegation", delegation)]);
const { sent } = await records.makeRecord({ kind: "comment", author: m.id, host: "A".repeat(43), item: "B".repeat(43), seen: null, prev: null },
  { text: "hi" }, { privateKey: bk.privateKey, publicKey: bkPub });
const entries = [{ n: 2, taken: Math.floor(Date.now() / 1000), sent }];
await identities.learnPeopleIn(env, { [m.id]: { chain: wire(m.chain) } }, identities.signersIn(entries),
  { delegations: { [bkPub]: { bytes: b64url(delegation), proof: dProof } }, from: MAL });
const kept = await env.DB.prepare("SELECT origin, origin_checked_at FROM identities WHERE person = ?").bind(m.id).first();
check("an identity learnt second-hand keeps its claimed address, unconfirmed", kept?.origin === BOB && kept.origin_checked_at === null, JSON.stringify(kept));

let caller = await call(BOB, m);
check("…and a call signed by it \"from\" that address doesn't check: the address is asked, and it's someone else's",
  caller === null && fetched.includes(BOB), `${JSON.stringify(caller)} fetched ${fetched}`);
caller = await call(BOB, bob);
check("the real site's call from its own address checks (its identity fetched from there)", caller?.person === bob.id && caller.from === BOB);
const bobRow = await env.DB.prepare("SELECT origin_checked_at FROM identities WHERE person = ?").bind(bob.id).first();
check("…and that address is now confirmed", Boolean(bobRow?.origin_checked_at));
caller = await call(BOB, bob);
check("…so its next call checks without fetching anything", caller?.person === bob.id && fetched.length === 0, `fetched ${fetched}`);
caller = await call(BOB, m);
check("Mallory's still doesn't, however often it tries", caller === null);
// A newer chain naming a different address forgets the confirmation: Bob moves to a new address (a slow change, in
// effect here once its 7 days have run from when this site first saw it).
const NEW = "https://bob-new.example";
const newHosting = await newKeyPair(true);
const doc0 = JSON.parse(new TextDecoder().decode(bob.chain[0].bytes));
const doc1 = encode({ ...doc0, seq: 1, prev: bob.id, origin: NEW, hosting: await publicKeyText(newHosting.publicKey) });
const fp1 = await fingerprintOf("identity", doc1);
await env.DB.prepare("INSERT INTO identity_seen (fp, first_seen) VALUES (?, ?)").bind(fp1, Math.floor(Date.now() / 1000) - 8 * 86400).run();
await identities.learnIdentity(env, [...bob.chain, { bytes: doc1, sig: { passkey: await bob.pk.sign([fp1]) } }]);
const after = await env.DB.prepare("SELECT origin, origin_checked_at FROM identities WHERE person = ?").bind(bob.id).first();
check("an identity that moves isn't confirmed at its new address until fetched from there", after.origin === NEW && after.origin_checked_at === null,
  JSON.stringify(after));

console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
