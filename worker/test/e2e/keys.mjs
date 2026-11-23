// afterwrd 2's keys (docs/signed-conversations.md, section 1): the shared signing library (public/static/signed.js)
// and identity checks (src/identity.js), through the real code bundled by run.sh, with a software passkey standing in
// for a phone: it makes real WebAuthn assertions (P-256), as a browser would hand to the site.
import { pathToFileURL } from "node:url";
const { signed, checkDelegation, checkPasskeyProof, forked, readIdentity, SLOW_SECONDS, checkCall, signCall, CLOCK_SECONDS, checkProfile, parseChain } = await import(pathToFileURL(`${process.env.OUT}/bundle.mjs`).href);
const { b64url, checkAs, concat, encode, enrolKey, fingerprintOf, fromB64url, newKeyPair, newRecoveryCode, publicKeyText, recoveryKey, sha256,
  signAs, statementsChallenge, tidyRecoveryCode, utf8 } = signed;

let failed = 0;
const check = (name, ok) => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); };
const A = "https://ann.example";
const NOW = 1_800_000_000;
const DAY = 86400;
const nonce = () => b64url(crypto.getRandomValues(new Uint8Array(24)));
const bytes = (a) => new Uint8Array(a);

// --- a software passkey -------------------------------------------------------------------------------------------

/** DER for an ECDSA signature WebCrypto gives as r‖s. */
function der(raw) {
  const int = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.subarray(i); return b[0] & 0x80 ? concat(bytes([0]), b) : b; };
  const r = int(raw.subarray(0, 32)), s = int(raw.subarray(32));
  const body = concat(bytes([0x02, r.length]), r, bytes([0x02, s.length]), s);
  return concat(bytes([0x30, body.length]), body);
}

async function softPasskey(origin = A) {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const cose = concat(bytes([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), fromB64url(jwk.x), bytes([0x22, 0x58, 0x20]), fromB64url(jwk.y));
  const id = b64url(crypto.getRandomValues(new Uint8Array(16)));
  return {
    passkey: { id, key: b64url(cose), origin },
    /** Signs fingerprints in one prompt, as navigator.credentials.get would. */
    async sign(statements, { uv = true, at = origin, n = nonce(), framed = false } = {}) {
      const challenge = await statementsChallenge(n, statements);
      const clientData = utf8(JSON.stringify({ type: "webauthn.get", challenge, origin: at, crossOrigin: framed }));
      const authData = concat(await sha256(utf8(new URL(at).hostname)), bytes([uv ? 0x05 : 0x01]), bytes([0, 0, 0, 0]));
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, concat(authData, await sha256(clientData))));
      return { credential: id, nonce: n, statements, response: { authenticatorData: b64url(authData), clientDataJSON: b64url(clientData), signature: b64url(der(raw)) } };
    },
  };
}

// --- signed.js -----------------------------------------------------------------------------------------------------

{
  const kp = await newKeyPair();
  const pub = await publicKeyText(kp.publicKey);
  const rec = encode({ kind: "comment", text: "hello" });
  const sig = await signAs("record", kp.privateKey, rec);
  check("a record's signature checks", await checkAs("record", pub, rec, sig));
  check("…but not as another kind of thing", !(await checkAs("head", pub, rec, sig)) && !(await checkAs("delegation", pub, rec, sig)));
  check("…nor with one byte changed", !(await checkAs("record", pub, concat(rec.subarray(0, -1), utf8("!")), sig)));
  check("…nor by another key", !(await checkAs("record", await publicKeyText((await newKeyPair()).publicKey), rec, sig)));
  check("malformed keys and signatures simply don't check", !(await checkAs("record", "nope", rec, sig)) && !(await checkAs("record", pub, rec, "!!"))
    && !(await checkAs("record", pub, "not bytes", sig)));
  let threw = false; try { await crypto.subtle.exportKey("raw", kp.privateKey); } catch { threw = true; }
  check("a browser key can't be copied out", threw);
  check("the same bytes as two kinds have different fingerprints", (await fingerprintOf("record", rec)) !== (await fingerprintOf("profile", rec)));

  const code = newRecoveryCode();
  check("a recovery code is five groups of five", /^([0-9A-HJKMNP-TV-Z]{5}-){4}[0-9A-HJKMNP-TV-Z]{5}$/.test(code));
  check("…typed in lower case, with spaces, or O for 0, it's the same code",
    tidyRecoveryCode(code.toLowerCase().replace(/-/g, " ")) === code && tidyRecoveryCode(code.replace(/0/g, "O")) === code);
  check("…and anything else isn't one", tidyRecoveryCode("hello") === null && tidyRecoveryCode(code + "1") === null && tidyRecoveryCode("U".repeat(25)) === null);
  const r1 = await recoveryKey(code), r2 = await recoveryKey(code.toLowerCase());
  check("a recovery code always gives the same key", r1.publicKey === r2.publicKey && r1.publicKey !== (await recoveryKey(newRecoveryCode())).publicKey);
  check("…which signs", await checkAs("identity", r1.publicKey, rec, await signAs("identity", r2.privateKey, rec)));
  let refused = false; try { await statementsChallenge("short", ["x"]); } catch { refused = true; }
  check("a challenge needs a real nonce and fingerprints", refused);
}

// --- identities ----------------------------------------------------------------------------------------------------

const recovery = await recoveryKey(newRecoveryCode());
const hosting = await publicKeyText((await newKeyPair()).publicKey);
const doc = (seq, prev, passkeys, extra = {}) => encode({ v: 2, kind: "identity", seq, prev, origin: A, passkeys, recovery: recovery.publicKey, hosting, ...extra });
const seen = (map) => (fp) => map.get(fp) ?? NOW;

const phone = await softPasskey();
const laptop = await softPasskey();
const g = doc(0, null, [phone.passkey]);
const gFp = await fingerprintOf("identity", g);

// One prompt at setup signs the first identity document and the browser key's delegation together.
const browser = await newKeyPair();
const delegation = encode({ v: 2, kind: "delegation", person: gFp, key: await publicKeyText(browser.publicKey), origin: A, expires: NOW + 30 * DAY });
const dFp = await fingerprintOf("delegation", delegation);
const setupProof = await phone.sign([gFp, dFp]);
const genesis = { bytes: g, sig: { passkey: setupProof } };

const s0 = await readIdentity([genesis], seen(new Map()), NOW);
check("the first identity document, signed by its own passkey, gives the person's id: its fingerprint", s0?.id === gFp && s0.current.seq === 0 && !s0.problem);
check("a first document signed by a passkey it doesn't list isn't an identity",
  (await readIdentity([{ bytes: g, sig: { passkey: await laptop.sign([gFp]) } }], seen(new Map()), NOW)) === null);
check("one prompt signs both: the delegation checks too", (await checkDelegation(delegation, setupProof, s0, NOW)) === (await publicKeyText(browser.publicKey)));
check("a delegation is no good after it expires", (await checkDelegation(delegation, setupProof, s0, NOW + 31 * DAY)) === null);
check("…or signed by a passkey that isn't the person's", (await checkDelegation(delegation, await laptop.sign([dFp]), s0, NOW)) === null);
const other = encode({ v: 2, kind: "delegation", person: "x".repeat(43), key: await publicKeyText(browser.publicKey), origin: A, expires: NOW + DAY });
check("…or for someone else", (await checkDelegation(other, await phone.sign([await fingerprintOf("delegation", other)]), s0, NOW)) === null);

check("a passkey proof without checking it's you (no fingerprint or PIN) is refused", !(await checkPasskeyProof(await phone.sign([dFp], { uv: false }), phone.passkey, dFp)));
check("…as is one made at another site", !(await checkPasskeyProof(await phone.sign([dFp], { at: "https://evil.example" }), phone.passkey, dFp)));
check("…or in a page framed inside another site's", !(await checkPasskeyProof(await phone.sign([dFp], { framed: true }), phone.passkey, dFp)));
const swapped = await phone.sign([dFp]);
swapped.statements = [gFp];
check("…or with its list of statements changed", !(await checkPasskeyProof(swapped, phone.passkey, gFp)));
check("…or for a statement it didn't sign", !(await checkPasskeyProof(await phone.sign([dFp]), phone.passkey, gFp)));

// Adding the laptop takes effect at once.
const d1 = doc(1, gFp, [phone.passkey, laptop.passkey]);
const d1Fp = await fingerprintOf("identity", d1);
const c1 = [genesis, { bytes: d1, sig: { passkey: await phone.sign([d1Fp]) } }];
const s1 = await readIdentity(c1, seen(new Map()), NOW);
check("adding a passkey, signed by a current one, takes effect at once", s1.current.seq === 1 && !s1.pending && !s1.problem);
check("…but not signed by the new passkey alone", (await readIdentity([genesis, { bytes: d1, sig: { passkey: await laptop.sign([d1Fp]) } }], seen(new Map()), NOW)).problem === "unsigned");

// Removing the phone waits 7 days from when this reader first saw it.
const d2 = doc(2, d1Fp, [laptop.passkey]);
const d2Fp = await fingerprintOf("identity", d2);
const c2 = [...c1, { bytes: d2, sig: { passkey: await laptop.sign([d2Fp]) } }];
const firstSaw = new Map([[d2Fp, NOW + 2 * DAY]]);
const s2a = await readIdentity(c2, seen(firstSaw), NOW + 3 * DAY);
check("removing a passkey waits: the phone still counts meanwhile", s2a.current.seq === 1 && s2a.pending?.seq === 2 && s2a.effectiveAt === NOW + 2 * DAY + SLOW_SECONDS);
check("…the 7 days run from when this reader first saw it, not from anything written in it",
  (await readIdentity(c2, seen(firstSaw), NOW + 8 * DAY)).current.seq === 1 && (await readIdentity(c2, seen(firstSaw), NOW + 9 * DAY)).current.seq === 2);

// The owner (still holding the phone) cancels it.
const cancel = doc(3, d2Fp, [phone.passkey, laptop.passkey], { cancels: d2Fp });
const cancelFp = await fingerprintOf("identity", cancel);
const c3 = [...c2, { bytes: cancel, sig: { passkey: await phone.sign([cancelFp]) } }];
const s3 = await readIdentity(c3, seen(firstSaw), NOW + 4 * DAY);
check("a waiting change can be cancelled by a passkey from before it", s3.current.seq === 3 && !s3.pending && !s3.problem
  && s3.current.passkeys.some((p) => p.id === phone.passkey.id));
check("…and once cancelled it never takes effect", (await readIdentity(c3, seen(firstSaw), NOW + 30 * DAY)).current.passkeys.length === 2);
const badCancel = doc(3, d2Fp, [laptop.passkey], { cancels: d2Fp });
const badFp = await fingerprintOf("identity", badCancel);
check("a cancel that doesn't put things back as they were isn't one",
  (await readIdentity([...c2, { bytes: badCancel, sig: { passkey: await phone.sign([badFp]) } }], seen(firstSaw), NOW + 4 * DAY)).problem === "unexpected");
const sneak = doc(3, d2Fp, [laptop.passkey, (await softPasskey()).passkey]);
const sneakFp = await fingerprintOf("identity", sneak);
check("while a change waits, nothing but a cancel counts",
  (await readIdentity([...c2, { bytes: sneak, sig: { passkey: await laptop.sign([sneakFp]) } }], seen(firstSaw), NOW + 4 * DAY)).problem === "unexpected");

// Lost every device: the recovery code adds a new passkey, which waits 7 days.
const newPhone = await softPasskey();
const r2 = doc(2, d1Fp, [phone.passkey, laptop.passkey, newPhone.passkey]);
const r2Fp = await fingerprintOf("identity", r2);
const cr = [...c1, { bytes: r2, sig: { recovery: await signAs("identity", recovery.privateKey, r2) } }];
const sr = await readIdentity(cr, seen(new Map()), NOW + DAY);
check("the recovery code can add a passkey, but it waits 7 days", sr.current.seq === 1 && sr.pending?.seq === 2 && !sr.problem);
const thiefCancel = doc(3, r2Fp, [phone.passkey, laptop.passkey], { cancels: r2Fp });
const tcFp = await fingerprintOf("identity", thiefCancel);
check("…and someone holding a passkey can't cancel what the recovery code did",
  (await readIdentity([...cr, { bytes: thiefCancel, sig: { passkey: await phone.sign([tcFp]) } }], seen(new Map()), NOW + DAY)).problem === "unexpected");
check("…but the recovery code can",
  !(await readIdentity([...cr, { bytes: thiefCancel, sig: { recovery: await signAs("identity", recovery.privateKey, thiefCancel) } }], seen(new Map()), NOW + DAY)).problem);
const wrongCode = await recoveryKey(newRecoveryCode());
check("a different recovery code signs nothing", (await readIdentity([...c1, { bytes: r2, sig: { recovery: await signAs("identity", wrongCode.privateKey, r2) } }],
  seen(new Map()), NOW)).problem === "unsigned");

// A new device through a device link: the phone signs an enrolment naming the document it follows and the key the link's
// one-time token stands for; the new device signs the document adding itself with that key and with its new passkey.
const tablet = await softPasskey();
const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
const linkKey = await enrolKey(token);
const enrol = encode({ v: 2, kind: "enrol", person: gFp, prev: d1Fp, key: linkKey.publicKey });
const enrolProof = await phone.sign([await fingerprintOf("enrol", enrol)]);
const e2 = doc(2, d1Fp, [phone.passkey, laptop.passkey, tablet.passkey]);
const e2Fp = await fingerprintOf("identity", e2);
const enrolled = async (d, { by = tablet, proof = enrolProof, statement = enrol, key = linkKey } = {}) => ({ bytes: d,
  sig: { enrolment: { statement: b64url(statement), proof, signature: await signAs("identity", key.privateKey, d) },
    passkey: await by.sign([await fingerprintOf("identity", d)]) } });
const withTablet = async (d = e2, options = {}) => readIdentity([...c1, await enrolled(d, options)], seen(new Map()), NOW);
const se = await withTablet();
check("a device link adds the new device's passkey at once", se.current.seq === 2 && se.current.passkeys.length === 3 && !se.problem);
check("…not without the link's token", (await withTablet(e2, { key: await enrolKey(b64url(crypto.getRandomValues(new Uint8Array(32)))) })).problem === "unsigned");
check("…not with an enrolment signed by a passkey that isn't the person's", (await withTablet(e2, { proof: await tablet.sign([await fingerprintOf("enrol", enrol)]) })).problem === "unsigned");
check("…not signed by some other new passkey", (await withTablet(e2, { by: await softPasskey() })).problem === "unsigned");
const e2bad = doc(2, d1Fp, [tablet.passkey, laptop.passkey]);
check("…and it can't remove anyone while it's at it", (await withTablet(e2bad)).problem === "unsigned");
const mallory = await softPasskey("https://mallory.example");
const e2away = doc(2, d1Fp, [phone.passkey, laptop.passkey, mallory.passkey]);
check("…or add a passkey made for another site", (await withTablet(e2away, { by: mallory })).problem === "unsigned");
const e2host = doc(2, d1Fp, [phone.passkey, laptop.passkey, tablet.passkey], { hosting: await publicKeyText((await newKeyPair()).publicKey) });
check("…or change the hosting key", (await withTablet(e2host)).problem === "unsigned");
const late = encode({ v: 2, kind: "enrol", person: gFp, prev: gFp, key: linkKey.publicKey });
check("…or be used anywhere but straight after the document it names",
  (await withTablet(e2, { statement: late, proof: await phone.sign([await fingerprintOf("enrol", late)]) })).problem === "unsigned");
// Someone else copies the published enrolment onto a document of their own after it: nothing in the chain gives them the token.
const thief = await softPasskey();
const e3 = doc(3, e2Fp, [phone.passkey, laptop.passkey, tablet.passkey, thief.passkey], { hosting: await publicKeyText((await newKeyPair()).publicKey) });
const published = (await enrolled(e2)).sig.enrolment;
const replay = { bytes: e3, sig: { enrolment: published, passkey: await thief.sign([await fingerprintOf("identity", e3)]) } };
const sr3 = await readIdentity([...c1, await enrolled(e2), replay], seen(new Map()), NOW);
check("a published enrolment can't be used again to add someone else's passkey", sr3.problem === "unsigned" && sr3.current.seq === 2
  && !sr3.current.passkeys.some((p) => p.id === thief.passkey.id) && sr3.current.hosting === hosting);
check("…and nothing published carries the link's token", !JSON.stringify(published).includes(token));

// A broken chain counts up to the break.
const stray = doc(2, "z".repeat(43), [phone.passkey, laptop.passkey]);
const sb = await readIdentity([...c1, { bytes: stray, sig: { passkey: await phone.sign([await fingerprintOf("identity", stray)]) } }], seen(new Map()), NOW);
check("a document that doesn't follow on from the last stops the chain there", sb.problem === "broken" && sb.current.seq === 1);

// Two versions of the same identity: frozen.
check("two different documents at the same place are spotted", (await forked(c2, cr)) && !(await forked(c1, c2)));

// Closing is slow, and nothing follows it.
const closed = doc(2, d1Fp, [phone.passkey, laptop.passkey], { closed: true });
const closedFp = await fingerprintOf("identity", closed);
const cc = [...c1, { bytes: closed, sig: { passkey: await phone.sign([closedFp]) } }];
check("closing an identity waits 7 days too", (await readIdentity(cc, seen(new Map()), NOW + DAY)).pending?.closed === true);
const after = doc(3, closedFp, [phone.passkey, laptop.passkey]);
const afterFp = await fingerprintOf("identity", after);
check("…and nothing counts after it", (await readIdentity([...cc, { bytes: after, sig: { passkey: await phone.sign([afterFp]) } }],
  seen(new Map([[afterFp, NOW + 8 * DAY]])), NOW + 8 * DAY)).problem === "closed");

check("oversized or malformed documents aren't identities", (await readIdentity([{ bytes: utf8("x".repeat(5000)), sig: {} }], seen(new Map()), NOW)) === null
  && (await readIdentity([{ bytes: utf8("{}"), sig: {} }], seen(new Map()), NOW)) === null);

// --- signed calls between sites (signedcalls.js) ----------------------------------------------------------------

{
  const B = "https://bob.example";
  const bobPerson = "b".repeat(43);
  const bobHosting = await newKeyPair();
  const bobPublic = await publicKeyText(bobHosting.publicKey);
  const keyOf = async (person, from) => (person === bobPerson && from === B ? bobPublic : null);
  const call = async (method, url, body = null, { at = NOW, signedUrl = url, key = bobHosting.privateKey, from = B, person = bobPerson } = {}) => {
    const headers = new Headers(await signCall({ method, url: signedUrl, body, person, from, privateKey: key, at }));
    return { method, url, headers, body: body == null ? null : utf8(body) };
  };
  const ok = (c, opts = {}) => checkCall(c, { ownOrigin: new URL(c.url).origin, hostingKeyOf: keyOf, at: NOW, ...opts });
  check("a signed call says who's calling", (await ok(await call("GET", `${A}/_p/items`)))?.person === bobPerson);
  check("…with a body too", (await ok(await call("POST", `${A}/_p/records`, '{"a":1}')))?.from === B);
  check("a call signed for one site can't be replayed to another", (await ok(await call("GET", "https://cat.example/_p/items", null, { signedUrl: `${A}/_p/items` }))) === null);
  check("…nor to another address on the same site", (await ok(await call("GET", `${A}/_p/other`, null, { signedUrl: `${A}/_p/items` }))) === null);
  check("a call more than 5 minutes old (or ahead) is refused", (await ok(await call("GET", `${A}/_p/items`, null, { at: NOW - CLOCK_SECONDS - 1 }))) === null
    && (await ok(await call("GET", `${A}/_p/items`, null, { at: NOW + CLOCK_SECONDS + 1 }))) === null
    && (await ok(await call("GET", `${A}/_p/items`, null, { at: NOW - CLOCK_SECONDS + 5 })))?.person === bobPerson);
  const changed = await call("POST", `${A}/_p/records`, '{"a":1}');
  changed.body = utf8('{"a":2}');
  check("a changed body is refused", (await ok(changed)) === null);
  const dropped = await call("POST", `${A}/_p/records`, '{"a":1}');
  dropped.body = null;
  check("…and so is one with its body taken away", (await ok(dropped)) === null);
  check("a call signed with another key is refused", (await ok(await call("GET", `${A}/_p/items`, null, { key: (await newKeyPair()).privateKey }))) === null);
  const moved = await call("GET", `${A}/_p/items`);
  moved.headers.set("Afterwrd-From", "https://evil.example");
  check("…as is one claiming to come from somewhere else", (await ok(moved)) === null);
  check("…or from someone the receiver can't find", (await ok(await call("GET", `${A}/_p/items`, null, { person: "c".repeat(43) }))) === null);
  const bare = await call("GET", `${A}/_p/items`);
  bare.headers.delete("Signature");
  check("an unsigned call is refused", (await ok(bare)) === null && (await ok({ method: "GET", url: `${A}/_p/items`, headers: new Headers() })) === null);
}

// --- profiles (identities.js checkProfile) ------------------------------------------------------------------------

{
  const profile = (fields) => encode({ v: 2, kind: "profile", person: gFp, name: "Ann Example", at: NOW, ...fields });
  const envelope = async (bytes, key = browser) => ({ bytes: b64url(bytes), key: await publicKeyText(key.publicKey),
    signature: await signAs("profile", key.privateKey, bytes), delegation: { bytes: b64url(delegation), proof: setupProof } });
  check("a profile signed by a browser key the person allowed says their name", (await checkProfile(await envelope(profile()), s0))?.name === "Ann Example");
  check("…not if signed by any other key", (await checkProfile(await envelope(profile(), await newKeyPair()), s0)) === null);
  check("…nor after that browser key ran out", (await checkProfile(await envelope(profile({ at: NOW + 31 * DAY })), s0)) === null);
  check("…nor claiming to be someone else's", (await checkProfile(await envelope(profile({ person: "x".repeat(43) })), s0)) === null);
  const edited = await envelope(profile());
  edited.bytes = b64url(profile({ name: "Not Ann" }));
  check("…nor with its name changed", (await checkProfile(edited, s0)) === null);
  check("chains are read only in the right shape", parseChain([{ bytes: b64url(g), sig: {} }])?.length === 1 && parseChain("x") === null
    && parseChain([{ bytes: "!!", sig: {} }]) === null && parseChain(Array.from({ length: 201 }, () => ({ bytes: b64url(g), sig: {} }))) === null);
}

// --- a group's identity (step 6a): owned by the person who made it ----------------------------------------------------

{
  const G = "https://club.example";
  const groupHosting = await publicKeyText((await newKeyPair()).publicKey);
  const gdoc = (seq, prev, extra = {}) => encode({ v: 2, kind: "identity", seq, prev, origin: G, passkeys: [], hosting: groupHosting, owner: gFp, ...extra });
  const g0 = gdoc(0, null);
  const g0Fp = await fingerprintOf("identity", g0);
  const ann = await readIdentity([genesis], seen(new Map()), NOW);
  const first = { bytes: g0, sig: { passkey: await phone.sign([g0Fp]) } };
  const group = await readIdentity([first], seen(new Map()), NOW, { owner: ann });
  check("a group's identity is signed by its owner's passkey", group?.id === g0Fp && group.current.owner === gFp && !group.problem);
  check("…and can't be read without its owner's", (await readIdentity([first], seen(new Map()), NOW)) === null);
  const bob = await softPasskey();
  const bobG = encode({ v: 2, kind: "identity", seq: 0, prev: null, origin: "https://bob.example", passkeys: [bob.passkey], recovery: recovery.publicKey, hosting });
  const bobState = await readIdentity([{ bytes: bobG, sig: { passkey: await bob.sign([await fingerprintOf("identity", bobG)]) } }], seen(new Map()), NOW);
  check("…nor with someone else as its owner", (await readIdentity([first], seen(new Map()), NOW, { owner: bobState })) === null);
  check("…nor signed by someone else's passkey", (await readIdentity([{ bytes: g0, sig: { passkey: await bob.sign([g0Fp]) } }], seen(new Map()), NOW, { owner: ann })) === null);
  check("a group's document can't list passkeys or a recovery key of its own", (await readIdentity([{ bytes: gdoc(0, null, { passkeys: [bob.passkey] }), sig: { passkey: await phone.sign([await fingerprintOf("identity", gdoc(0, null, { passkeys: [bob.passkey] }))]) } }], seen(new Map()), NOW, { owner: ann })) === null);
  const moved = gdoc(1, g0Fp, { origin: "https://club2.example" });
  const movedFp = await fingerprintOf("identity", moved);
  const c = [first, { bytes: moved, sig: { passkey: await phone.sign([movedFp]) } }];
  const waiting = await readIdentity(c, seen(new Map([[movedFp, NOW]])), NOW + DAY, { owner: ann });
  const done = await readIdentity(c, seen(new Map([[movedFp, NOW]])), NOW + 8 * DAY, { owner: ann });
  check("moving a group waits 7 days, as a person's move does", waiting?.pending?.origin === "https://club2.example" && done?.current.origin === "https://club2.example");
  const newKey = gdoc(1, g0Fp, { hosting: await publicKeyText((await newKeyPair()).publicKey) });
  const newKeyFp = await fingerprintOf("identity", newKey);
  const rekeyed = await readIdentity([first, { bytes: newKey, sig: { passkey: await phone.sign([newKeyFp]) } }], seen(new Map()), NOW, { owner: ann });
  check("…and a new hosting key takes effect at once", rekeyed?.current.hosting !== groupHosting && !rekeyed.pending);
  const takeover = gdoc(1, g0Fp, { owner: await fingerprintOf("identity", bobG) });
  const takeoverFp = await fingerprintOf("identity", takeover);
  const taken = await readIdentity([first, { bytes: takeover, sig: { passkey: await phone.sign([takeoverFp]) } }], seen(new Map()), NOW, { owner: ann });
  check("a group's owner can't be changed", taken?.problem === "broken" && taken.current.owner === gFp);
  const byCode = gdoc(1, g0Fp, { closed: true });
  const byCodeFp = await fingerprintOf("identity", byCode);
  const closing = await readIdentity([first, { bytes: byCode, sig: { recovery: await signAs("identity", recovery.privateKey, byCode) } }], seen(new Map()), NOW, { owner: ann });
  check("its owner's recovery code can sign for it too (closing it, here, after 7 days)", closing?.pending?.closed === true && closing.pendingByRecovery);
}

process.exit(failed ? 1 : 0);
