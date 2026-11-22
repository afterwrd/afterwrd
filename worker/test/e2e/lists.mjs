// afterwrd 2's records and lists (docs/signed-conversations.md, section 2): src/records.js, src/lists.js and
// public/static/records.js, through the real code bundled by run.sh. Ann hosts a post; Bob and Cat write on it from
// their browsers (real browser keys, allowed by software passkeys). Then bad writers try their luck with the host, and a
// bad host tries its luck with readers.
import { pathToFileURL } from "node:url";
const { signed, readIdentity, makeRecord, checkRecord, Rules, checkList, signHead, checkHead, PER_AUTHOR, EDIT_SECONDS, takeRecord, readList, local, MemberRules }
  = await import(pathToFileURL(`${process.env.OUT}/bundle.mjs`).href);
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
const { b64url, concat, encode, fingerprintOf, fromB64url, newKeyPair, publicKeyText, recoveryKey, newRecoveryCode, sha256, signAs,
  statementsChallenge, utf8 } = signed;

let failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`); };
const NOW = 1_800_000_000;
const DAY = 86400;
const bytes = (a) => new Uint8Array(a);

// --- people: an identity each, a hosting key, and a browser key allowed by their passkey -----------------------------

function der(raw) {
  const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.subarray(i); return b[0] & 0x80 ? concat(bytes([0]), b) : b; };
  const r = int(raw.subarray(0, 32)), s = int(raw.subarray(32));
  const body = concat(bytes([0x02, r.length]), r, bytes([0x02, s.length]), s);
  return concat(bytes([0x30, body.length]), body);
}
async function softPasskey(origin) {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const cose = concat(bytes([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), fromB64url(jwk.x), bytes([0x22, 0x58, 0x20]), fromB64url(jwk.y));
  const id = b64url(crypto.getRandomValues(new Uint8Array(16)));
  return {
    passkey: { id, key: b64url(cose), origin },
    async sign(statements) {
      const n = b64url(crypto.getRandomValues(new Uint8Array(24)));
      const challenge = await statementsChallenge(n, statements);
      const clientData = utf8(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
      const authData = concat(await sha256(utf8(new URL(origin).hostname)), bytes([0x05]), bytes([0, 0, 0, 0]));
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, concat(authData, await sha256(clientData))));
      return { credential: id, nonce: n, statements, response: { authenticatorData: b64url(authData), clientDataJSON: b64url(clientData), signature: b64url(der(raw)) } };
    },
  };
}
const states = new Map();
const delegations = new Map();
async function person(origin) {
  const passkey = await softPasskey(origin);
  const hosting = await newKeyPair();
  const doc = encode({ v: 2, kind: "identity", seq: 0, prev: null, origin, passkeys: [passkey.passkey],
    recovery: (await recoveryKey(newRecoveryCode())).publicKey, hosting: await publicKeyText(hosting.publicKey) });
  const id = await fingerprintOf("identity", doc);
  const browser = await newKeyPair();
  const key = await publicKeyText(browser.publicKey);
  const delegation = encode({ v: 2, kind: "delegation", person: id, key, origin, expires: NOW + 30 * DAY });
  const proof = await passkey.sign([id, await fingerprintOf("delegation", delegation)]);
  const state = await readIdentity([{ bytes: doc, sig: { passkey: proof } }], () => 0, NOW);
  states.set(id, state);
  delegations.set(key, { bytes: b64url(delegation), proof });
  return { id, origin, hosting, browser: { privateKey: browser.privateKey, publicKey: key }, state };
}
const lookups = { identityOf: async (p) => states.get(p) ?? null, delegationOf: async (k) => delegations.get(k) ?? null };

const ann = await person("https://ann.example");
const bob = await person("https://bob.example");
const cat = await person("https://cat.example");

// --- Ann's site, hosting her post (what src/lists.js's Rules let a host take) -----------------------------------------

class Host {
  constructor(owner) { this.owner = owner; this.entries = []; this.rules = null; this.list = null; }
  async take(sent, taken = NOW) {
    const got = await checkRecord(sent, { ...lookups, at: taken });
    if (!got) return { refused: "doesn't check" };
    if (!this.rules) { this.list = got.fp; this.rules = new Rules({ host: this.owner.id, list: got.fp, owner: got.record.author }); }
    const why = this.rules.refuse(got, taken);
    if (why) return { refused: why };
    const head = await this.rules.add({ fp: got.fp, taken, record: got.record, byHost: got.byHost });
    const entry = { n: this.rules.n, fp: got.fp, taken, head, sent };
    this.entries.push(entry);
    // A delete or removal: the record it names keeps only its fingerprint.
    if (got.record.kind === "delete" || got.record.kind === "remove") {
      const target = this.entries.find((e) => e.fp === got.record.about);
      if (target) delete target.sent;
    }
    return { entry, receipt: await signHead(this.owner.hosting.privateKey, { host: this.owner.id, list: this.list, n: entry.n, head }) };
  }
  point() { const e = this.entries.at(-1); return { n: e.n, h: e.head }; }
  async signed(n = this.entries.length) {
    return signHead(this.owner.hosting.privateKey, { host: this.owner.id, list: this.list, n, head: this.entries[n - 1].head });
  }
}
const writes = new Map(); // post and person -> fp of their newest record on that post
const mineOn = (host, who) => `${host.list}:${who.id}`;
async function write(who, host, fields, content, { seen = host.point(), prev = writes.get(mineOn(host, who)) ?? null, key = who.browser } = {}) {
  const made = await makeRecord({ author: who.id, host: host.owner.id, item: host.list, seen, prev, ...fields }, content, key);
  return made;
}
async function writeAndTake(who, host, fields, content, opts = {}, taken = NOW) {
  const made = await write(who, host, fields, content, opts);
  const answer = await host.take(made.sent, taken);
  if (!answer.refused) writes.set(mineOn(host, who), made.fp);
  return { ...answer, fp: made.fp };
}
const read = async (host, { entries = host.entries, signedHead, from = null, hostingKey = host.owner.state.current.hosting } = {}) =>
  checkList({ host: host.owner.id, hostingKey, list: host.list, owner: host.owner.id, entries: structuredClone(entries),
    signedHead: signedHead ?? (await host.signed()), from, lookups });

// --- an honest conversation -----------------------------------------------------------------------------------------

const post = new Host(ann);
const item = await makeRecord({ kind: "item", author: ann.id, host: ann.id }, { text: "Walk on Saturday?" }, ann.browser);
const first = await post.take(item.sent);
check("Ann's site takes her post as the first entry, its id the record's fingerprint", first.entry?.n === 1 && post.list === item.fp);
const seenFirst = post.point();
const b1 = await writeAndTake(bob, post, { kind: "comment" }, { text: "Yes!" }, { seen: seenFirst });
const c1 = await writeAndTake(cat, post, { kind: "comment" }, { text: "Me too" }, { seen: seenFirst });
check("two people commenting at the same moment are both taken, neither asked to retry", b1.entry?.n === 2 && c1.entry?.n === 3, `${b1.refused} ${c1.refused}`);
check("…each given a receipt the host signed", (await checkHead(b1.receipt, { hostingKey: ann.state.current.hosting, host: ann.id, list: post.list }))?.n === 2);
const honest = await read(post);
check("a reader checks the whole list: every signature, every running fingerprint, the signed end",
  !honest.problem && honest.entries.length === 3 && honest.entries.every((e) => e.state === "ok") && honest.entries[1].content?.text === "Yes!",
  honest.problem);

// --- bad writers, at the host ----------------------------------------------------------------------------------------

const made = async (who, fields, content, opts) => (await post.take((await write(who, post, fields, content, opts)).sent)).refused;
check("a record saying it saw a list that never was is refused", (await made(bob, { kind: "comment" }, { text: "x" }, { seen: { n: 2, h: "x".repeat(43) } })) !== undefined);
check("…as is one claiming to have seen past the end", (await made(bob, { kind: "comment" }, { text: "x" }, { seen: { n: 9, h: post.point().h } })) !== undefined);
check("a record out of order (not following the writer's own last one) is refused", (await made(bob, { kind: "comment" }, { text: "x" }, { prev: null })) === "That's out of order.");
check("Bob can't write as Cat with his own key", (await made(cat, { kind: "comment" }, { text: "x" }, { key: bob.browser })) === "doesn't check");
const stranger = await newKeyPair();
check("…nor anyone with a key no one allowed", (await made(bob, { kind: "comment" }, { text: "x" }, { key: { privateKey: stranger.privateKey, publicKey: await publicKeyText(stranger.publicKey) } })) === "doesn't check");
const twice = await write(cat, post, { kind: "comment" }, { text: "again" });
await post.take(twice.sent); writes.set(mineOn(post, cat), twice.fp);
check("the same record sent twice is taken once", (await post.take(twice.sent)).refused === "duplicate");
const content = (await write(bob, post, { kind: "comment" }, { text: "original" })).sent;
content.content = b64url(encode({ text: "changed on the way" }));
check("content that isn't what the record signed is refused", (await post.take(content)).refused === "doesn't check");
// Bob edits his comment: fine within 15 minutes with no reply after it; not after Cat's, nor after 15 minutes.
const lone = new Host(ann);
await lone.take((await makeRecord({ kind: "item", author: ann.id, host: ann.id }, { text: "Edits" }, ann.browser)).sent);
const b2 = await writeAndTake(bob, lone, { kind: "comment" }, { text: "Teh walk" });
check("Bob can change his comment straight after", !(await writeAndTake(bob, lone, { kind: "edit", about: b2.fp }, { text: "The walk" }, {}, NOW + 60)).refused);
check("…but not after 15 minutes", (await writeAndTake(bob, lone, { kind: "edit", about: b2.fp }, { text: "The walks" }, {}, NOW + EDIT_SECONDS + 1)).refused === "It's too late to change that.");
await writeAndTake(cat, lone, { kind: "comment" }, { text: "Which walk?" }, {}, NOW + 120);
check("…nor once someone else has replied", (await writeAndTake(bob, lone, { kind: "edit", about: b2.fp }, { text: "The walk!" }, {}, NOW + 180)).refused === "Someone has replied since.");
check("nobody can change someone else's", (await writeAndTake(cat, lone, { kind: "edit", about: b2.fp }, { text: "Bob is wrong" }, {}, NOW + 200)).refused === "That isn't theirs.");
check("…or delete it", (await writeAndTake(cat, lone, { kind: "delete", about: b2.fp }, undefined, {}, NOW + 200)).refused === "That isn't theirs.");
check("…or remove it, unless it's their post or their site", (await writeAndTake(cat, lone, { kind: "remove", about: b2.fp }, undefined, {}, NOW + 200)).refused === "Only its owner or host can remove that.");
// Over the cap.
const capped = new Host(ann);
await capped.take((await makeRecord({ kind: "item", author: ann.id, host: ann.id }, { text: "Cap" }, ann.browser)).sent);
let refusedAt = null;
for (let i = 1; i <= PER_AUTHOR + 1 && !refusedAt; i++) {
  const r = await writeAndTake(bob, capped, { kind: "comment" }, { text: `${i}` });
  if (r.refused) refusedAt = i;
}
check(`one person can add ${PER_AUTHOR} entries to an item, not more`, refusedAt === PER_AUTHOR + 1, `refused at ${refusedAt}`);
const lastOfBob = writes.get(mineOn(capped, bob));
check("…but can always delete what's theirs, even then", !(await writeAndTake(bob, capped, { kind: "delete", about: lastOfBob }, undefined)).refused);
writes.set(mineOn(capped, ann), capped.list);
let ownRefused = null;
for (let i = 1; i <= PER_AUTHOR + 2 && !ownRefused; i++) ownRefused = (await writeAndTake(ann, capped, { kind: "change" }, { text: `Cap ${i}` })).refused ?? null;
check("…while the item's owner isn't held to it for changes to their own item", ownRefused === null, ownRefused);
check("…though their comments are", (await writeAndTake(ann, capped, { kind: "comment" }, { text: "One more" })).refused === "That's as many as anyone can add here.");

// --- a poll's voting ending (comments carry on) -------------------------------------------------------------------------

const poll = new Host(ann);
const asked = await makeRecord({ kind: "item", author: ann.id, host: ann.id }, { text: "Hills or canal?", poll: { options: ["Hills", "Canal"], multiple: 0 } }, ann.browser);
await poll.take(asked.sent);
writes.set(mineOn(poll, ann), asked.fp);
check("a vote is taken", !(await writeAndTake(bob, poll, { kind: "vote", version: asked.fp }, { choices: [0] })).refused);
check("only the poll's owner can end it", (await writeAndTake(bob, poll, { kind: "end" }, undefined)).refused === "Only its owner can end it.");
check("…which she does", !(await writeAndTake(ann, poll, { kind: "end" }, undefined)).refused);
check("then no more votes", (await writeAndTake(cat, poll, { kind: "vote", version: asked.fp }, { choices: [1] })).refused === "That poll has closed.");
check("…but comments carry on", !(await writeAndTake(cat, poll, { kind: "comment" }, { text: "Too late!" })).refused);
check("…and it can't end twice", (await writeAndTake(ann, poll, { kind: "end" }, undefined)).refused === "That's already ended.");
check("readers check it the same way", !(await read(poll)).problem);

// --- deleting, removing, closing --------------------------------------------------------------------------------------

const thread = new Host(ann);
const picnic = await makeRecord({ kind: "item", author: ann.id, host: ann.id }, { text: "Picnic" }, ann.browser);
await thread.take(picnic.sent);
writes.set(mineOn(thread, ann), picnic.fp); // her post is her first record on it
const t1 = await writeAndTake(bob, thread, { kind: "comment" }, { text: "Something I regret" });
const t2 = await writeAndTake(cat, thread, { kind: "comment" }, { text: "Something rude" });
const t3 = await writeAndTake(bob, thread, { kind: "delete", about: t1.fp }, undefined);
const t4 = await writeAndTake(ann, thread, { kind: "remove", about: t2.fp }, undefined);
check("Bob deletes his own; Ann removes Cat's from her post", !t3.refused && !t4.refused, `${t3.refused} ${t4.refused}`);
const after = await read(thread);
const stateOf = (fp) => after.entries.find((e) => e.fp === fp)?.state;
check("readers see one deleted and one removed by Ann, with their words gone for good, and the list still checks",
  !after.problem && stateOf(t1.fp) === "deleted" && stateOf(t2.fp) === "removed" && after.entries.find((e) => e.fp === t2.fp).removedBy === ann.id
  && !JSON.stringify(thread.entries).includes(b64url(utf8("regret"))), after.problem);
const hostRemoves = await makeRecord({ kind: "remove", author: ann.id, host: ann.id, item: thread.list, seen: thread.point(), prev: null, about: t3.fp },
  undefined, { privateKey: ann.hosting.privateKey, publicKey: ann.state.current.hosting });
check("Ann's site can remove with its own hosting key too", !(await thread.take(hostRemoves.sent)).refused);
const closing = await writeAndTake(ann, thread, { kind: "close" }, undefined);
check("Ann closes it", !closing.refused, closing.refused);
check("…and nothing more is taken", (await writeAndTake(cat, thread, { kind: "comment" }, { text: "Late" })).refused === "This is closed.");
check("…nor can anyone but Ann close one", (await writeAndTake(bob, lone, { kind: "close" }, undefined)).refused === "Only its owner can close it.");

// --- a bad host, as readers see it ------------------------------------------------------------------------------------

const without = post.entries.filter((e) => e.n !== 2);
check("a list with an entry quietly dropped doesn't add up", (await read(post, { entries: without })).problem === "broken");
const swapped = structuredClone(post.entries);
[swapped[1], swapped[2]] = [swapped[2], swapped[1]];
check("…nor does one shown in a different order", (await read(post, { entries: swapped })).problem === "broken");
const emptied = structuredClone(post.entries);
delete emptied[1].sent;
const left = await read(post, { entries: emptied });
check("a comment's words withheld, with nothing signed saying why, shows as left out (and the rest still checks)",
  !left.problem && left.entries[1].state === "left-out" && left.entries[2].state === "ok", left.problem);
const reworded = structuredClone(post.entries);
reworded[1].sent.content = b64url(encode({ text: "Bob never said this" }));
const rew = await read(post, { entries: reworded });
check("a comment's words changed fails its check, and is hidden", !rew.problem && rew.entries[1].state === "failed" && rew.entries[1].content === undefined, rew.problem);
const rebuilt = structuredClone(post.entries);
const forged = await makeRecord({ kind: "comment", author: bob.id, host: ann.id, item: post.list, seen: seenFirst, prev: null }, { text: "forged" }, ann.browser);
rebuilt[1].sent = forged.sent;
check("a different record put in an entry's place doesn't add up", (await read(post, { entries: rebuilt })).problem === "broken");
check("a head the host's key didn't sign doesn't add up", (await read(post, { signedHead: await signHead((await newKeyPair()).privateKey,
  { host: ann.id, list: post.list, n: post.entries.length, head: post.entries.at(-1).head }) })).problem === "broken");
check("…nor does a list cut short of its signed end", (await read(post, { entries: post.entries.slice(0, -1) })).problem === "broken");
const tail = await read(post, { entries: post.entries.slice(2), from: { n: 2, head: post.entries[1].head } });
check("a reader starting from a checkpoint checks only what's after it", !tail.problem && tail.entries.length === post.entries.length - 2, tail.problem);
check("…and one whose last point isn't in the list finds it doesn't add up",
  (await read(post, { entries: post.entries.slice(2), from: { n: 2, head: "y".repeat(43) } })).problem === "broken");
// A host taking something no honest host would: a comment after the post was closed.
const sneaked = structuredClone(thread.entries);
const late = await makeRecord({ kind: "comment", author: cat.id, host: ann.id, item: thread.list, seen: thread.point(), prev: t2.fp }, { text: "after close" }, cat.browser);
const lateFp = await fingerprintOf("record", fromB64url(late.sent.record));
const rules = new Rules({ host: ann.id, list: thread.list, owner: ann.id });
for (const e of thread.entries) await rules.add({ fp: e.fp, taken: e.taken, record: null });
const lateHead = await (await import(pathToFileURL(`${process.env.OUT}/bundle.mjs`).href)).headOf({ host: ann.id, list: thread.list,
  prev: thread.entries.at(-1).head, n: thread.entries.length + 1, fp: lateFp, taken: NOW });
sneaked.push({ n: thread.entries.length + 1, fp: lateFp, taken: NOW, head: lateHead, sent: late.sent });
const sneakRead = await read(thread, { entries: sneaked, signedHead: await signHead(ann.hosting.privateKey, { host: ann.id, list: thread.list, n: sneaked.length, head: lateHead }) });
check("a comment slipped in after closing is spotted, though the host signed it", sneakRead.problem === "unexpected", sneakRead.problem);

// --- a comment from a laptop whose passkey was removed later stays the writer's -------------------------------------

{
  const laptop = await softPasskey("https://dee.example");
  const phone = await softPasskey("https://dee.example");
  const hosting = await newKeyPair();
  const recovery = (await recoveryKey(newRecoveryCode())).publicKey;
  const doc = (seq, prev, passkeys) => encode({ v: 2, kind: "identity", seq, prev, origin: "https://dee.example", passkeys, recovery, hosting: ann.state.current.hosting });
  const g = doc(0, null, [laptop.passkey, phone.passkey]);
  const gFp = await fingerprintOf("identity", g);
  const browser = await newKeyPair();
  const key = await publicKeyText(browser.publicKey);
  const dBytes = encode({ v: 2, kind: "delegation", person: gFp, key, origin: "https://dee.example", expires: NOW + 30 * DAY });
  const chain = [{ bytes: g, sig: { passkey: await laptop.sign([gFp, await fingerprintOf("delegation", dBytes)]) } }];
  const proof = chain[0].sig.passkey;
  const removed = doc(1, gFp, [phone.passkey]);
  const removedFp = await fingerprintOf("identity", removed);
  chain.push({ bytes: removed, sig: { passkey: await phone.sign([removedFp]) } });
  // Removing the laptop was first seen on day 1, so it takes effect on day 8.
  const dee = await readIdentity(chain, (fp) => (fp === removedFp ? NOW + DAY : 0), NOW + 10 * DAY);
  states.set(gFp, dee);
  delegations.set(key, { bytes: b64url(dBytes), proof });
  const said = await makeRecord({ kind: "comment", author: gFp, host: ann.id, item: post.list, seen: seenFirst, prev: null }, { text: "From my laptop" },
    { privateKey: browser.privateKey, publicKey: key });
  check("a comment from a laptop, taken before its passkey was removed, still checks afterwards",
    (await checkRecord(said.sent, { ...lookups, at: NOW + 2 * DAY }))?.content.text === "From my laptop");
  check("…but anything that laptop signs after the removal took effect doesn't", (await checkRecord(said.sent, { ...lookups, at: NOW + 9 * DAY })) === null);
}

// --- the host's own storage (hosted.js), on real SQLite through the site's database layer --------------------------

{
  // A Durable Object's storage, as far as src/sqlite.js uses it, over Node's SQLite.
  const raw = new DatabaseSync(":memory:");
  const total = () => raw.prepare("SELECT total_changes() AS t").get().t;
  const storage = {
    sql: { exec(text, ...params) {
      const before = total();
      const rows = raw.prepare(text).all(...params);
      const written = total() - before;
      return { toArray: () => rows, one: () => rows[0], rowsRead: rows.length, rowsWritten: written, columnNames: rows[0] ? Object.keys(rows[0]) : [] };
    } },
    transactionSync(fn) { raw.exec("BEGIN"); try { const r = fn(); raw.exec("COMMIT"); return r; } catch (e) { raw.exec("ROLLBACK"); throw e; } },
  };
  for (const statement of readFileSync(new URL("../../migrations/0029_lists.sql", import.meta.url), "utf8").split(";").map((t) => t.trim()).filter((t) => t && !/^(--[^\n]*\n?)*$/.test(t))) {
    raw.exec(statement);
  }
  // The host's index of others' records (migration 0041: sentchecks.js), which taking a record writes to.
  raw.exec("CREATE TABLE authored (fp TEXT PRIMARY KEY, author TEXT, list TEXT NOT NULL, n INTEGER NOT NULL, taken INTEGER NOT NULL)");
  // …and the part of `items` it reads: whether an item brought over from afterwrd 1 takes comments yet (step 10b).
  raw.exec("CREATE TABLE items (id TEXT PRIMARY KEY, before_until INTEGER)");
  const db = local(storage);
  const host = { person: ann.id, privateKey: ann.hosting.privateKey };
  const itemRecord = await makeRecord({ kind: "item", author: ann.id, host: ann.id }, { text: "Big thread" }, ann.browser);
  const took = await takeRecord(db, { sent: itemRecord.sent, host, lookups, taken: NOW });
  check("the host takes a new post into its own storage", took.entry?.n === 1, took.refused);
  check("…once", (await takeRecord(db, { sent: itemRecord.sent, host, lookups, taken: NOW })).refused === "duplicate");
  // Step 10b: only what's brought over from afterwrd 1 may say when it was first written, and an item brought over takes
  // no new comments until those from before are in.
  const seenPost0 = () => ({ n: 1, h: took.entry.head });
  const backdated = await makeRecord({ kind: "item", author: ann.id, host: ann.id, before: 1_700_000_000 }, { text: "Old, says me" }, ann.browser);
  check("a post saying it was written earlier is refused, unless it's being brought over",
    /written earlier/.test((await takeRecord(db, { sent: backdated.sent, host, lookups, taken: NOW })).refused ?? "")
    && Boolean((await takeRecord(db, { sent: backdated.sent, host, lookups, taken: NOW, bringing: true })).entry));
  raw.prepare("INSERT INTO items (id, before_until) VALUES (?, ?)").run(backdated.fp, NOW + DAY);
  const tooSoon = await makeRecord({ kind: "comment", author: ann.id, host: ann.id, item: backdated.fp, seen: { n: 1, h: raw.prepare("SELECT head FROM lists WHERE id = ?").get(backdated.fp).head }, prev: backdated.fp },
    { text: "Too soon" }, ann.browser);
  const waits = await takeRecord(db, { sent: tooSoon.sent, host, lookups, taken: NOW });
  // Its 30 days up, but its old comments not in yet (before.js puts them in at the next chance): still not, so they
  // go first; once they're in, it's taken.
  const due = await takeRecord(db, { sent: tooSoon.sent, host, lookups, taken: NOW + DAY + 1 });
  raw.prepare("UPDATE items SET before_until = NULL WHERE id = ?").run(backdated.fp);
  const later = await takeRecord(db, { sent: tooSoon.sent, host, lookups, taken: NOW + DAY + 1 });
  check("…and nothing new on it until its old comments are in", /being brought over/.test(waits.refused ?? "") && /nearly in/.test(due.refused ?? "")
    && Boolean(later.entry), `${waits.refused} / ${due.refused} / ${later.refused}`);
  const vote = await makeRecord({ kind: "vote", author: ann.id, host: ann.id, item: itemRecord.fp, seen: seenPost0(), prev: itemRecord.fp, version: itemRecord.fp }, { choices: [0] }, ann.browser);
  raw.prepare("INSERT OR REPLACE INTO items (id, before_until) VALUES (?, ?)").run(itemRecord.fp, NOW + DAY);
  check("…not even a vote", /being brought over/.test((await takeRecord(db, { sent: vote.sent, host, lookups, taken: NOW })).refused ?? ""));
  raw.prepare("DELETE FROM items WHERE id = ?").run(itemRecord.fp);
  // Sixty people comment at the same moment, all having seen only the post.
  const crowd = await Promise.all(Array.from({ length: 60 }, (_, i) => person(`https://p${i}.example`)));
  const seenPost = { n: 1, h: took.entry.head };
  const made = await Promise.all(crowd.map((p) => makeRecord({ kind: "comment", author: p.id, host: ann.id, item: itemRecord.fp, seen: seenPost, prev: null },
    { text: `hello from ${p.origin}` }, p.browser)));
  const answers = await Promise.all(made.map((m) => takeRecord(db, { sent: m.sent, host, lookups, taken: NOW + 1 })));
  const numbers = answers.map((a) => a.entry?.n).filter(Boolean).sort((x, y) => x - y);
  check("sixty comments at once each get their own number, none lost", numbers.length === 60 && numbers.every((n, i) => n === i + 2),
    answers.filter((a) => a.refused).map((a) => a.refused).join("; "));
  check("…kept 50 to a row", raw.prepare("SELECT COUNT(*) AS n FROM list_pages WHERE list = ?").get(itemRecord.fp).n === 2);
  // Someone on the first page deletes theirs once the list runs onto the second.
  const first = answers.find((a) => a.entry.n === 2);
  const writer = crowd[made.findIndex((m) => m.fp === first.entry.fp)];
  const del = await makeRecord({ kind: "delete", author: writer.id, host: ann.id, item: itemRecord.fp, seen: { n: 61, h: answers.find((a) => a.entry.n === 61).entry.head },
    prev: first.entry.fp, about: first.entry.fp }, undefined, writer.browser);
  check("a delete on the second page", !(await takeRecord(db, { sent: del.sent, host, lookups, taken: NOW + 2 })).refused);
  const back = await readList(db, itemRecord.fp, { host });
  const seen = await checkList({ host: ann.id, hostingKey: ann.state.current.hosting, list: itemRecord.fp, owner: ann.id, entries: back.entries, signedHead: back.signedHead, lookups });
  check("…reaches back to the first: the whole list, read back, checks, with it deleted and its words gone",
    !seen.problem && seen.entries.length === 62 && seen.entries[1].state === "deleted" && seen.entries.filter((e) => e.state === "ok").length === 61
    && !JSON.stringify(back.entries).includes(b64url(encode({ text: `hello from ${writer.origin}` }))), seen.problem);
  const since = await readList(db, itemRecord.fp, { host, after: 60 });
  check("a reader that has checked up to 60 reads only what's after", since.entries.length === 2 && since.entries[0].n === 61);

  // A long list: 520 entries, from 26 people writing 20 each, in turn.
  const longItem = await makeRecord({ kind: "item", author: ann.id, host: ann.id }, { text: "Long" }, ann.browser);
  let point = { n: 1, h: (await takeRecord(db, { sent: longItem.sent, host, lookups, taken: NOW })).entry.head };
  const writers = crowd.slice(0, 26);
  const lastOf = new Map();
  for (let round = 0; round < 20; round++) {
    for (const w of writers) {
      const m = await makeRecord({ kind: "comment", author: w.id, host: ann.id, item: longItem.fp, seen: point, prev: lastOf.get(w.id) ?? null }, { text: `${round}` }, w.browser);
      const r = await takeRecord(db, { sent: m.sent, host, lookups, taken: NOW + round });
      if (r.entry) { point = { n: r.entry.n, h: r.entry.head }; lastOf.set(w.id, m.fp); }
    }
  }
  check("a long list fills: 521 entries", point.n === 521, `${point.n}`);
  const fresh = await readList(db, longItem.fp, { host });
  const fromCp = fresh.checkpoint && await checkHead(fresh.checkpoint, { hostingKey: ann.state.current.hosting, host: ann.id, list: longItem.fp });
  const longRead = fromCp && await checkList({ host: ann.id, hostingKey: ann.state.current.hosting, list: longItem.fp, owner: ann.id,
    entries: fresh.entries, signedHead: fresh.signedHead, from: fromCp, lookups });
  check("a new reader of it starts from the signed checkpoint at 500, and checks the rest", fromCp?.n === 500 && fresh.entries.length === 21
    && !longRead?.problem && longRead.upTo === 521, longRead?.problem);
  // A group's members list is read whole (groupmembers.js signedMembers): who's in follows from every join and approval.
  const whole = await readList(db, longItem.fp, { host, whole: true });
  check("…but read whole, as a group's members list is, it starts from the first entry", !whole.checkpoint && whole.entries.length === 521
    && whole.entries[0].n === 1, `${whole.entries.length}`);
  // Ann deletes the whole post: everything on it goes, and it can't be put back.
  const gone = await makeRecord({ kind: "delete", author: ann.id, host: ann.id, item: itemRecord.fp, seen: { n: 62, h: back.entries.at(-1).head },
    prev: itemRecord.fp, about: itemRecord.fp }, undefined, ann.browser);
  const deleted = await takeRecord(db, { sent: gone.sent, host, lookups, taken: NOW + 3 });
  check("Ann deletes her post: everything on it goes", deleted.deleted && (await readList(db, itemRecord.fp, { host })).deleted
    && raw.prepare("SELECT COUNT(*) AS n FROM list_pages WHERE list = ?").get(itemRecord.fp).n === 0, deleted.refused);
  check("…and it can't be put back, with or without its old comments", (await takeRecord(db, { sent: itemRecord.sent, host, lookups, taken: NOW + 4 })).refused === "That's been deleted."
    && (await takeRecord(db, { sent: made[5].sent, host, lookups, taken: NOW + 4 })).refused === "That's been deleted.");

  // A group's members list (its id is the group's own) hosted the same way: removing someone is about their `join`,
  // which stays (step 6e found it emptied, so nobody could check the list after anyone was removed).
  const group = await person("https://group.example");
  const gHost = { person: group.id, privateKey: group.hosting.privateKey };
  raw.prepare("INSERT INTO lists (id, owner, n, head, created_at) VALUES (?, ?, 0, '', ?)").run(group.id, ann.id, NOW);
  const memberAt = async () => { const r = await readList(db, group.id, { host: gHost }); const e = r.entries.at(-1); return e ? { n: e.n, h: e.head } : null; };
  const joined = await makeRecord({ kind: "join", author: cat.id, host: group.id, item: group.id, seen: null, prev: null }, { name: "Cat" }, cat.browser);
  const tookJoin = await takeRecord(db, { sent: joined.sent, host: gHost, lookups, taken: NOW + 5 });
  const letIn = await makeRecord({ kind: "approve", author: ann.id, host: group.id, item: group.id, seen: await memberAt(), prev: null, about: joined.fp }, undefined, ann.browser);
  const tookIn = await takeRecord(db, { sent: letIn.sent, host: gHost, lookups, taken: NOW + 6 });
  const out = await makeRecord({ kind: "remove", author: ann.id, host: group.id, item: group.id, seen: await memberAt(), prev: letIn.fp, about: joined.fp }, undefined, ann.browser);
  const tookOut = await takeRecord(db, { sent: out.sent, host: gHost, lookups, taken: NOW + 7 });
  const members = await readList(db, group.id, { host: gHost });
  const read = await checkList({ host: group.id, hostingKey: group.state.current.hosting, list: group.id, owner: ann.id, Kind: MemberRules,
    entries: members.entries, signedHead: members.signedHead, lookups });
  check("removing someone from a group keeps their join on its members list, which still checks", !tookJoin.refused && !tookIn.refused && !tookOut.refused
    && members.entries[0].sent && !read.problem && read.rules.roleOf(cat.id) === null, `${tookJoin.refused} ${tookIn.refused} ${tookOut.refused} ${read.problem}`);
}

// --- a group's members list (step 6b: src/members.js) ------------------------------------------------------------------
// The group G (its id is its members list's) is owned by Ann; Bob and Cat ask to join; Dave too, later.
{
  const dave = await person("https://dave.example");
  const G = "g".repeat(43);
  const rules = new MemberRules({ host: G, list: G, owner: ann.id });
  const last = new Map();
  const at = () => (rules.n ? { n: rules.n, h: rules.heads.get(rules.n) } : null);
  const sign = async (who, kind, extra = {}, content) => {
    const made = await makeRecord({ kind, author: who.id, host: G, item: G, seen: at(), prev: last.get(who.id) ?? null, ...extra }, content, who.browser);
    return { got: await checkRecord(made.sent, { ...lookups, at: NOW }), fp: made.fp, who };
  };
  const take = async ({ got, fp, who }) => {
    const why = rules.refuse(got, NOW);
    if (!why) { await rules.add({ fp, taken: NOW, record: got.record, content: got.content }); last.set(who.id, fp); }
    return why;
  };
  check("a group's owner is in, without joining", rules.roleOf(ann.id) === "owner" && (await take(await sign(ann, "join", {}, { name: "Ann" }))) === "The owner is in already.");
  const bobJoin = await sign(bob, "join", {}, { name: "Bob" });
  check("someone asks to join with their own signed join, and waits", !(await take(bobJoin)) && rules.roleOf(bob.id) === "waiting");
  const catJoin = await sign(cat, "join", {}, { name: "Cat" });
  await take(catJoin);
  check("someone waiting can't let anyone in", (await take(await sign(bob, "approve", { about: catJoin.fp, role_at: at() }))) === "Only the group's admins can do that.");
  check("the owner lets them in", !(await take(await sign(ann, "approve", { about: bobJoin.fp }))) && !(await take(await sign(ann, "approve", { about: catJoin.fp })))
    && rules.roleOf(bob.id) === "member" && rules.roleOf(cat.id) === "member");
  check("a member can't make admins", (await take(await sign(cat, "role", { about: bobJoin.fp, role_at: at() }, { role: "admin" }))) === "Only the group's admins can do that.");
  check("the owner makes Bob an admin", !(await take(await sign(ann, "role", { about: bobJoin.fp }, { role: "admin" }))) && rules.roleOf(bob.id) === "admin");
  const bobSaw = at();
  const daveJoin = await sign(dave, "join", {}, { name: "Dave" });
  await take(daveJoin);
  const early = await sign(bob, "approve", { about: daveJoin.fp, role_at: bobSaw });
  check("an admin lets someone in, saying when they held the role", !(await take(early)) && rules.roleOf(dave.id) === "member");
  check("an admin can't remove the owner, nor make admins", (await take(await sign(bob, "remove", { about: "x".repeat(43), role_at: at() }))) === "They aren't in this group, or asking."
    && (await take(await sign(bob, "role", { about: catJoin.fp, role_at: at() }, { role: "admin" }))) === "Only the group's owner can make admins.");
  const stale = at();
  check("the owner takes Bob's role back", !(await take(await sign(ann, "role", { about: bobJoin.fp }, { role: "member" }))) && rules.roleOf(bob.id) === "member");
  check("…and he can't act on what he saw as an admin before", (await take(await sign(bob, "remove", { about: daveJoin.fp, role_at: stale }))) === "Only the group's admins can do that.");
  check("a member leaves", !(await take(await sign(cat, "leave"))) && rules.roleOf(cat.id) === null);
  check("…and can't be approved again without joining again", (await take(await sign(ann, "approve", { about: catJoin.fp }))) === "They aren't in this group, or asking.");
  check("the owner can't leave", (await take(await sign(ann, "leave"))) === "The owner can't leave: close the group instead.");
  check("…and these kinds belong only in a members list", new Rules({ host: G, list: "i".repeat(43), owner: ann.id })
    .refuse({ ...(await sign(bob, "join", {}, { name: "Bob" })).got, record: { ...(await sign(bob, "join", {}, { name: "Bob" })).got.record, item: "i".repeat(43) } }, NOW)
    === "That belongs in a group's members list.");
}

// --- names (step 7b: src/names.js): look-alikes fold to the same ---------------------------------------------------
{
  const { fold } = await import(pathToFileURL(`${process.env.OUT}/bundle.mjs`).href);
  check("names fold case, accents, spaces and signs", fold("  Zoë   O'Brien ") === fold("zoe obrien"));
  check("…and look-alike letters: digits, Cyrillic, Greek, I and l", fold("B0b Ехаmple") === fold("Bob Example") && fold("Вill") === fold("BiII")
    && fold("Αnn") === fold("Ann") && fold("Mia") !== fold("Mi"), [fold("B0b Ехаmple"), fold("Bob Example")].join(" "));
  check("…but different names stay different", fold("Bob Example") !== fold("Rob Example") && fold("Ann") !== fold("Anne"));
}

process.exit(failed ? 1 : 0);
