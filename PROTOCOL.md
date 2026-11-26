# afterwrd protocol

Status: protocol version 2. This describes what afterwrd sites send each other and what they accept.
Where this document and the code disagree, the code is what runs, and the difference is a bug in one or the other.

afterwrd is a personal social network in which each person runs their own site, with one owner per site. A group is a
site of its own that nobody signs in to. Sites talk to each other over HTTPS with JSON. This document is the wire
contract: what one site may ask of another, what it gets back, what it signs, and what a receiving site checks. It is
written for anyone who wants to examine the design or build a compatible site in another language, and every signed
byte is pinned down exactly enough for a second implementation to make the same bytes, signatures and fingerprints.
It describes how afterwrd stores things only where that changes what goes over the wire.

References name files under `worker/` and the functions in them (`src/lists.js` `checkList`), not line numbers.
Examples marked as made by running the code are real output; anything shown as `<…>` is a placeholder.

## 1. Goals and non-goals

Goals:

- **Nobody's words can be changed, invented or quietly dropped by someone else.** Everything a person writes is a
  record signed in their own browser. The site that keeps a conversation (its host) numbers the records and signs where
  the list is up to, and every reader checks the whole list against the same rules the host used. A host can refuse a
  record, but it can't alter one, put words in someone's mouth, reorder what it took, or show two people different
  histories without that showing up to anyone who has seen both.
- **Identities, not addresses.** A person is a chain of signed identity documents, and their id never changes. An
  address is where to find them today. Moving a site keeps every friendship and group.
- **The site can't sign as its owner.** The owner's passkeys sign their identity, and allow a key in each browser
  they use to sign their records. The site itself holds only a hosting key, which signs calls and lists, never words.
  A stolen site, Cloudflare account or bad release can misbehave as a host, but it can't speak as the owner.
- **Private by default.** A site answers other sites only about what its owner shared with them. The only public thing
  is the identity document: keys and an address, with no name or picture.
- **Pull, mostly.** Friends' sites read each other when their owners look. Notes, the only push, are short and carry
  the signed things they're about, so a receiver can check them on the spot.
- **Groups can't speak for their members.** A group hosts its members' records like any host, and its members list is
  a signed list of their own joins and its admins' decisions.
- **Small enough for a free plan.** Lists are capped, each caller has a daily allowance, and notes go only to those
  they concern.

Non-goals: public discovery, search, followers, public profiles, and federation with ActivityPub servers. Hiding who
reads what from the host of a conversation (it answers every read). Deniability: signed words are provable, by
design. Protection from whoever runs the hardware (section 12).

## 2. Conventions

### 2.1 Transport

Sites talk to each other over HTTPS, with JSON both ways. Only two methods are used between sites: `GET` for a call
with no body and `POST` for a call with one. The calling site picks the method from whether it has a body
(`src/calls.js` `callFriend`).

| What | Value |
|---|---|
| Request body | UTF-8 JSON text, sent with `Content-Type: application/json`. Receivers don't check the content type; they parse the bytes. |
| Request body cap | 64 KiB (65,536 bytes) for every `POST` under `/_p/`, `/_member/` and `/_group/`, and for `/_connect/…/accept`, and `/_connect/ask`. Checked first from `Content-Length`, then from the bytes actually read. Over it: `413 {"error": "That's too big."}`, before any signature is looked at. `/_join/…/accept` reads at most 64 KiB too, but answers an oversized body with a `400`. The exceptions are `/_p/before` and `/_group/before`, which bring things over from afterwrd 1: 1,000,000 bytes. |
| Reply body | A JSON object. A reply that isn't valid JSON, or is JSON but not an object (`null`, a list, a number), counts as `{}`. A reply over the caller's cap counts as no answer at all (status `0`). |
| Reply size cap (caller side) | 2,000,000 bytes by default; 8,000,000 for a group's members lists; 524,288 bytes for `/.well-known/afterwrd`; 1,000 characters for `/_version`; under 65,536 characters for `/_p/reports/check`. |
| Timeouts (caller side) | 8 s by default. 25 s for a member's site calling its group and for asking to be friends; 5 s for a group's ping; 15 s for checking records; 5 s for notes (the outbox) and for check notices; 10 s for asking what became of reports; 20 s for ending a group. |
| Redirects | Never followed. A `3xx` reply is an error with that status, like any other non-`2xx`. |

A caller treats any non-`2xx` reply as a refusal. It takes the reply's `error` (cut to 300 characters) as the message
to show its owner, and the status as what the other site said. Status `0` means the other site couldn't be reached at
all (a network failure or a timeout).

Every reply a site makes carries these headers (`src/app.js` `HEADERS`, set in `handle`), apart from `GET /_version`,
which the front Worker answers itself. `<nonce>` is made fresh for each reply (`src/nonce.js`): a page's own inline
scripts carry it, so nothing else inline runs.

```http
Content-Security-Policy: script-src 'self' 'nonce-<nonce>'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'
Referrer-Policy: same-origin
X-Content-Type-Options: nosniff
X-Robots-Tag: noindex, nofollow
```

JSON replies also carry `Content-Type: application/json` and `Cache-Control: no-store` (`src/util.js` `json`). The one
exception is `GET /.well-known/afterwrd`, which is public: `Cache-Control: public, max-age=60` and
`Access-Control-Allow-Origin: *`. No other reply allows cross-origin reads.

Source: `src/calls.js` `callFriend`, `bodyBytes`; `src/sites.js` `callSite`, `readLimited`; `src/app.js` `route`,
`handle`; `src/identities.js` `fetchIdentity`, `handleIdentity`; `src/outbox.js`.

### 2.2 Site addresses

A site is known by its **address**: an origin, written the way the WHATWG URL parser writes `URL.origin`. That means a
lower-case host, no path, no trailing slash, and no port if the port is the default one. For example,
`https://sam.example.workers.dev`.

An address is accepted only if (`src/sites.js` `siteOrigin`):

- the scheme is `https:` (plain `http:` is allowed for `localhost` and `127.0.0.1` only on test sites, with
  `ALLOW_LOCAL_SITES`);
- it has no user name or password;
- the host doesn't end in a dot (`https://you.example.` and `https://you.example` are the same site, but wouldn't
  compare equal).

The result is always `URL.origin`, so addresses can be compared as plain text. Wherever an address appears in a signed
call or a signed document, it must already be in this form. Receivers check that `new URL(x).origin === x`.

A site's **own address** is the origin it is being served at: the origin of the request's URL as the platform hands it
over. On Cloudflare that is the Worker's own route. On a self-hosted server it is `https://<host>`, rebuilt by the
server's router for the hosts it serves and nothing else. A receiver never takes its own address from anything the
caller says.

Source: `src/sites.js` `siteOrigin`; `src/signedcalls.js` `checkCall`; `selfhost/router.js`.

### 2.3 Signed calls

Almost every call one site makes to another is signed with the calling site's **hosting key** (section 3.4). From the
signature, the receiver knows which identity is calling. Neither site holds a password or shared secret for the other.
The format is a fixed profile of RFC 9421 (HTTP Message Signatures) with Ed25519.

A site signs calls as one identity only: a person's site as its owner, and a group's site as the group (section 4). The
`keyid` is that identity's **person id** (the fingerprint of its first identity document, section 3.3), not a key id.

**Headers a signed call carries**

| Header | Value |
|---|---|
| `Afterwrd-From` | The caller's own address (section 2.2), at most 200 characters. This is where the receiver can fetch the caller's identity. |
| `Content-Digest` | Only when there is a body: `sha-256=:<SHA-256 of the body bytes, standard base64 with padding>:` (RFC 9530). No other algorithm, and only one digest. |
| `Signature-Input` | `sig1=` followed by the signature parameters below. |
| `Signature` | `sig1=:<64-byte Ed25519 signature, standard base64 with padding>:` |

**Signature parameters**, exactly in this form and this order:

```
("@method" "@target-uri" "afterwrd-from" "content-digest");created=<unix seconds>;keyid="<person id>";alg="ed25519";tag="afterwrd"
```

`"content-digest"` is listed only when there is a body. The label is always `sig1`.

**Covered components**

| Component | Value in the signature base |
|---|---|
| `@method` | The method in upper case: `GET` or `POST`. |
| `@target-uri` | The URL called, as `origin + pathname + search` from the WHATWG URL parser. No fragment and no user info. The query keeps its `?` when it isn't empty. |
| `afterwrd-from` | The `Afterwrd-From` value. |
| `content-digest` | The `Content-Digest` value (only with a body). |
| `@signature-params` | The parameters above, exactly as sent after `sig1=`. |

The **signature base** is those lines, in that order, joined with `\n`, with no newline at the end (RFC 9421 section
2.5). Each line is `"<name>": <value>`. The signature is Ed25519 over the base's UTF-8 bytes. It has **no**
`afterwrd <kind> 2\n` prefix: the `tag="afterwrd"` parameter does that job here.

**Worked example.** This was made by running `src/signedcalls.js` `signCall` with the fixed example key from section
3.5, `created=1795000000`, from `https://sam.example.workers.dev` to `https://ann.example.workers.dev`. The person id is
the real fingerprint of the example identity document in section 3.5. The body is the exact bytes sent:

```
{"points":[{"fp":"IMS_-99rTS21nxo3GUiPwa6pVpYgU0w08JqelWVCg8I","list":"Db-fjqtidPsE0Kw8j7iGpMrbgS3KhHR0b8xcyO7L_Lw"}]}
```

Signature base:

```
"@method": POST
"@target-uri": https://ann.example.workers.dev/_p/records/check
"afterwrd-from": https://sam.example.workers.dev
"content-digest": sha-256=:jI+2Df14Yl13Pp7tqCcCDWbRBWXNyknOM+VkvLXL3Tk=:
"@signature-params": ("@method" "@target-uri" "afterwrd-from" "content-digest");created=1795000000;keyid="Db-fjqtidPsE0Kw8j7iGpMrbgS3KhHR0b8xcyO7L_Lw";alg="ed25519";tag="afterwrd"
```

The call:

```http
POST /_p/records/check HTTP/1.1
Host: ann.example.workers.dev
Content-Type: application/json
Afterwrd-From: https://sam.example.workers.dev
Content-Digest: sha-256=:jI+2Df14Yl13Pp7tqCcCDWbRBWXNyknOM+VkvLXL3Tk=:
Signature-Input: sig1=("@method" "@target-uri" "afterwrd-from" "content-digest");created=1795000000;keyid="Db-fjqtidPsE0Kw8j7iGpMrbgS3KhHR0b8xcyO7L_Lw";alg="ed25519";tag="afterwrd"
Signature: sig1=:/ZpKnJI4IHFPe/1hq6Vul0JDPb7mrK88c1pOn778LHoU5Wgr+6AK42gU1zVTewtg0YNF6+4Clk0pvurVHN8CDw==:
```

The same caller's `GET https://ann.example.workers.dev/_p/items?since=0` at the same moment has no `Content-Digest`.
Its base has no `content-digest` line, its `@target-uri` is `https://ann.example.workers.dev/_p/items?since=0`, and its
signature is `sig1=:yFMfaQFvlh0ZulPCB00lMZJv/OXZQUJbjFZWOwnIJFmXCkfU6F7DygJXK2NI9kGhyMouOVnvONa+7Pkq85zDCA==:`.

**What the receiver checks** (`checkCall`). A call is refused if any of these fail:

1. The origin of the URL it was called at equals the receiver's own address. A call signed for one site can't be
   replayed to another.
2. `Signature-Input` matches the form above exactly: label `sig1`, the components in that order, `created` as 1 to 12
   digits, `keyid` as 43 base64url characters, then `alg="ed25519"` and `tag="afterwrd"`, in that order and nothing
   else.
3. `Signature` is `sig1=:` followed by exactly 86 standard-base64 characters and `==:`.
4. `Afterwrd-From` is present, at most 200 characters, and already in origin form.
5. `|now − created| ≤ 300` seconds, by the receiver's clock.
6. A body is covered exactly when there is one: a non-empty body needs `"content-digest"` in the parameters, and an
   empty or missing body must not have it. With a body, `Content-Digest` must equal the digest the receiver works out
   from the bytes it received, compared as text.
7. The receiver finds the hosting key that `keyid` signs with from `Afterwrd-From` (below), and the Ed25519 signature
   checks against the base it rebuilds from the call as received.

The result is `{person, from}`: who signed the call, and the address they signed it from.

**Finding the caller's hosting key** (`src/identities.js` `hostingKeyFor`). Given `person` and `from`:

- If the receiver already holds that person's identity, it isn't frozen, it reads with no problem, and the address in
  effect is `from`, the receiver uses the hosting key in effect (section 4) without fetching anything.
- Otherwise it fetches `GET <from>/.well-known/afterwrd` (8 s timeout, no redirects) and learns the chain (section 4),
  if it is `from`'s to give (4.6). It uses the hosting key only if the identity's id is `person`, it isn't frozen, and
  the address in effect is exactly `from`. What it learns is kept (the `identities` table) and used for later calls.

A frozen identity (one seen in two versions, section 4) can't make signed calls at all.

If the signature doesn't check with the hosting key the receiver knows, it fetches the identity again from
`Afterwrd-From`, at most once every 10 minutes for each identity. It does so after it has answered: the call is
refused, and a later call is checked with the new hosting key if it has changed. (Only where there is no request to
finish work after does it fetch at once and check once more.) So how long a refusal takes says nothing about whom the
receiver knows.

**Who may call, and what is refused.** Receivers never fetch anything for a caller they have no reason to hear from.
They look up `Afterwrd-From` among the sites they know first, and only then check the signature.

| Receiver path | Who it accepts | Refused with |
|---|---|---|
| Friends' calls (`src/calls.js` `friendCalling`): `/_p/items…`, `/_p/records…`, `/_p/report`, `/_p/notes`, the calls in `src/friendcalls.js` | A connected friend at `Afterwrd-From`, signing as the identity tied to that connection (it's tied at the first signed call if it wasn't already). Also a friend calling from the new address their identity is moving to, once that move is in effect here. | `401 {"error": "Not connected."}`. This is the same for a stranger, an unsigned call and a call signed by anyone else, so nobody can learn who the owner is friends with (the `409`s below come before the signature is checked). `403` if the owner hasn't approved the friend yet (except `POST /_p/disconnect`). `409 {"error": "Not moved here yet.", "moving": true}` for a move not yet in effect here. `410 {"error": "Moved.", "moved": "<new address>"}` once this site's owner has moved away; this is sent before any check. |
| Sites not yet known (`siteCalling`): asking to be friends, claiming a group and sending its identity, joining by invite link | Any identity whose address in effect is `Afterwrd-From`. Used only after the call has earned a fetch: a working link, a reason to ask, or a matching record. | Each handler's own answer: `400` or `403` when asking to be friends, `401` when joining a group. |
| Mention receipts (`knownCalling`): `POST /_p/mention` | An identity the receiver already holds, whose address in effect is `Afterwrd-From`. Nothing is fetched, so a stranger's call can't make the receiver reach out. | A quiet `202`, whatever happens. |
| A group's site (`src/groupmembers.js` `signedMember`) | A member at `Afterwrd-From` who joined with an identity, signing as that identity. | `401 {"error": "Not a member of this group."}` |
| A member's site called by a group (`src/groupjoin.js` `signedGroup`): `/_member/…`, `/_p/notes` | A joined group at `Afterwrd-From`, signing as the group's identity. | `401 {"error": "Not a member."}` |

> Note: the profile is deliberately narrow. A general RFC 9421 library that orders parameters differently, uses
> another label, adds `expires` or `nonce`, or sends two signatures will be refused.

Source: `src/signedcalls.js` `signCall`, `checkCall`; `src/calls.js` `friendCalling`, `siteCalling`, `knownCalling`;
`src/identities.js` `hostingKeyFor`, `knownHostingKey`, `fetchIdentity`; `src/later.js`; `src/groupmembers.js` `signedMember`, `callMember`;
`src/groupjoin.js` `signedGroup`.

### 2.4 Calls that aren't signed

A few calls carry no signature, because they aren't about anyone, or because the caller has no identity the receiver
could know yet:

| Call | What it's for |
|---|---|
| `GET /.well-known/afterwrd` | A site's identity: `{v: 2, chain, owner?}` (section 4). Public. |
| `GET /_version` | `{id}`: which uploaded version of the Worker is answering. With `?health=1`, also `ok`. Used to tell that a site is an afterwrd site, and by site checks (section 11). |
| `GET /_connect/<token>/info` | `{name}`: the owner's name, for the page a friend link opens on the friend's own site (section 8). |
| `GET /_join/<token>/info` | A group invite link's group: `{id, name, about, rules, owner, person, members}` (section 10). |
| `GET /_group/ping` | A group's site saying what it is: `{afterwrd: "group", version, protocol, hosting}` (section 10). |
| `GET /files/<sha256>?exp=…&sig=…` | One photo or video by a link the serving site made and signed for itself (section 8). |
| `POST /_p/reports/check` | What became of reports, asked by their secret ids alone, so asking doesn't say again who reported (8.15). On a person's site and a group's. |

`POST /_group/claim` is signed, and also carries the group's setup key (section 10).

Source: `src/app.js` `route`, `routeGroup`; `src/sites.js` `callSite`; `src/connect.js` `handleConnectLink`;
`src/groups.js` `handleJoinLink`, `handleGroupApi`; `src/reports.js` `handleReportCheck`.

### 2.5 Errors

A refusal is a non-`2xx` status with a JSON object body:

```json
{ "error": "That's a lot for one day here. Try again tomorrow." }
```

`error` is always a sentence in English, meant to be shown to the other site's owner. Callers must not depend on its
wording, with one exception: `409 {"error": "duplicate"}` means "already taken". A site that sent a record and gets
this treats it as delivered (`src/friendcopies.js`, `src/groupcopies.js`, `src/sentchecks.js`, `src/groupjoin.js`).
Some refusals carry more fields beside `error`:

| Field | With | Meaning |
|---|---|---|
| `retry` | `429` from the allowance (section 2.6) | Unix seconds when the caller may try again (the start of the next UTC day). |
| `moved` | `410` | The address the owner has moved to. |
| `moving` | `409` | `true`: a move isn't in effect here yet. Ask again later; it isn't a removal. |

Statuses used between sites:

| Status | Meaning |
|---|---|
| `200` | Done; the body is the answer. |
| `202` | `{"ok": true}`: taken, or quietly not taken. `POST /_p/mention` gives this whatever happens, so nobody can learn who the owner is friends with. |
| `400` | Malformed, or doesn't check (a bad record, signature or delegation). |
| `401` | The caller isn't recognised (section 2.3). |
| `403` | Recognised but not allowed: not approved yet, not an admin, not a friend. |
| `404` | No such thing, or not for this caller (an expired link, an item the caller may not see). |
| `409` | A conflict: `duplicate`, already done, not ready yet, or a move not yet in effect. |
| `410` | Gone: the owner has moved, or the group has closed. |
| `413` | The request body is over 64 KiB, or over a call's own smaller limit. |
| `429` | Too much: over an allowance or a cap (section 2.6). |
| `502` | This site couldn't reach a third site it needed. |
| `503` | The site is being updated. Comes with `Retry-After` (`120`, or `1` just after a new version starts; `60` while its database is being moved). |

How callers react: `401` from a friend's site means it no longer knows this one (the friend removed the owner).
`403`, `409`, `410` and `429` mean the site is there. Anything else, including `0`, counts as the site not answering.
Notes (section 9) are sent again on `0`, any `5xx`, `429` or `409`, and never on other statuses.

Source: `src/util.js` `json`, `Refusal`; `src/app.js` `handle`, `beingUpdated`; `src/index.js` `toSite`;
`src/friendcopies.js` `noteAnswer`; `src/outbox.js`.

### 2.6 Limits and allowances

**Daily allowance per calling identity.** Every signed call that passes its checks is counted against the caller's
identity (its person id), by UTC day (`floor(unix seconds / 86400)`). A caller may make **2,000 calls** a day, and have
**50,000 database rows read** for it. Rows are what the receiver's own database reports reading while answering. Once
either is reached, every further call that day is refused before it is handled:

```json
HTTP/1.1 429
{ "error": "This site has had a lot of requests from yours today. Try again tomorrow.", "retry": 1795046400 }
```

Counted: calls through `friendCalling`, `siteCalling`, `knownCalling`, `signedMember` and `signedGroup`. Not counted: a group's owner
calling their own group's site once it has an identity (claiming it and sending its identity are counted), a friend's
call refused because they aren't approved yet, unsigned calls, and calls refused before the signature checked.

The count is kept in memory. A caller's count is saved only once it is past a quarter of either limit, and then at most
every ten minutes. So a restart can lose up to ten minutes of counting. This holds back a buggy or greedy site, not a
determined one. A caller that gets `429` with `retry` doesn't ask that site again until `retry`.

**Caps on what a writer leaves** (sections 5 and 6 give the detail):

| Cap | Value | Answer |
|---|---|---|
| Records one writer may leave on one site, across every list, in the last 24 hours (rolling, not the UTC day). `delete`, `leave`, `remove` and `calloff` don't count, nor does a group's members list. | 200 | `429 {"error": "That's a lot for one day here. Try again tomorrow."}` |
| Records one writer may have on one list (`src/lists.js` `PER_AUTHOR`) | 20 | Refused (section 6) |
| Notices one writer may raise for the owner, across all friends' sites and groups, a day | 20 | Dropped quietly, not refused |
| Phone notifications one writer may set off, a day | 5 | Dropped quietly, not refused |

Other per-call caps (friend requests waiting, asks an hour, invite link uses) are given with their calls.

> Note: `429` replies carry `retry` in the body but no `Retry-After` header.

Source: `src/allowances.js` `admit`, `settle`, `OverAllowance`; `src/limits.js` `LIMITS`, `dayOf`, `nextDayAt`;
`src/hosted.js` `overDailyRecords`; `src/notes.js` `keepNotice`; `src/notify.js` `writerMayBuzz`.

### 2.7 Protocol version

This is protocol version **2**. There is no version header and no negotiation. The version appears in two places:

- every signed byte string is prefixed `afterwrd <kind> 2\n` (section 3.2);
- every signed or protocol JSON object carries `"v": 2`: identity documents, delegations, profiles, records, heads,
  move requests and notes, and also the reply of `/.well-known/afterwrd`. Readers refuse any other `v` in
  signed objects and notes; the `v` of that reply isn't read.

`tag="afterwrd"` in a signed call names the application, not a version. `/_version` gives the Worker's build id, not
the protocol. Section 13 covers how the version changes.

Source: `public/static/signed.js` `PROTOCOL`, `tagged`; `src/groups.js` `handleGroupApi`.

## 3. Signing

### 3.1 Encodings

- **base64url**: RFC 4648 section 5 alphabet, with no padding. Every key, signature, fingerprint and set of signed
  bytes inside a JSON body is written this way. Decoding (`fromB64url`) refuses `=` and any length that is 1 more than a
  multiple of 4. It ignores unused low bits in the last character (`"AA"` and `"AB"` both decode to `0x00`), so
  **ids and keys are always compared as text**, never as decoded bytes.
- **Standard base64 with padding** is used only in the HTTP signature headers (`Content-Digest`, `Signature`), as RFC
  9421 and RFC 9530 require.
- **Signed bytes** are UTF-8 JSON text, made once by the signer (`encode` is `JSON.stringify`). They are stored and
  passed on exactly as received, base64url-encoded, and never rebuilt from the parsed value. A reader parses them with
  a strict UTF-8 decoder and `JSON.parse` (`decode`). There is no canonical form: two byte strings with the same
  meaning are two different things, with different fingerprints.

> Note: `decode` accepts JSON that `JSON.stringify` would never make: a leading UTF-8 byte order mark (stripped),
> spaces between tokens, and repeated keys (the last one wins). A second implementation must read repeated keys the
> same way, or refuse them outright; otherwise two implementations could read the same signed bytes differently.

Source: `public/static/signed.js` `b64url`, `fromB64url`, `encode`, `decode`.

### 3.2 Tagged bytes and kinds

Every Ed25519 signature in the protocol except the HTTP call signature (section 2.3), and every fingerprint of
something signed, covers **tagged bytes**:

```
tagged(kind, bytes) = UTF-8("afterwrd " + kind + " 2\n") ‖ bytes
```

That is, the ASCII text `afterwrd`, a space, the kind, a space, the digit `2`, a line feed (`0x0a`), then the bytes,
with nothing in between. The tag means a signature or fingerprint for one kind can never be passed off as another. The
kinds (`KINDS`) are fixed:

| Kind | Used for | Signed by |
|---|---|---|
| `record` | Records (section 5): signatures, and their fingerprints, which are their ids | A browser key; a host's hosting key for its own `remove` and `close` |
| `head` | Signed heads and receipts (section 6), and the running head hash | A hosting key |
| `delegation` | A browser key's delegation (section 4): its fingerprint is a passkey statement | A passkey; also the browser key it names, as `possession`, for the owner's own site only (4.10) |
| `identity` | Identity documents (section 4): the fingerprint of the first is the person id; each fingerprint is a passkey statement | A passkey (by statement); the recovery key (signed directly as `identity`) |
| `profile` | A signed profile, the owner's name (section 4) | A browser key |
| `statements` | Making the WebAuthn challenge from a list of statements (section 3.6). Nothing is signed with it directly. | |
| `recovery` | Deriving the recovery key from the recovery code (section 3.7). Nothing is signed with it. | |
| `request` | Not used. Reserved. | |
| `audience` | The salted fingerprint of an invited audience (section 7). Never signed. | |
| `move` | A move request (section 4): its fingerprint is a passkey statement | The new site's passkey |

`tagged` throws for any kind not in the list.

Source: `public/static/signed.js` `KINDS`, `tagged`; callers of `signAs`, `checkAs` and `fingerprintOf` in
`public/static/records.js`, `src/records.js`, `src/lists.js`, `src/identity.js`, `src/keys.js`, `src/identities.js`,
`public/static/signprofile.js`.

### 3.3 Fingerprints

A fingerprint is SHA-256 written in base64url: always 43 characters. There are two functions:

- `fingerprintOf(kind, bytes) = base64url(SHA-256(tagged(kind, bytes)))`: the fingerprint of **something signed**. The
  same bytes as two different kinds give two different fingerprints. This gives a person id
  (`fingerprintOf("identity", <first identity document>)`), a record's id (`fingerprintOf("record", bytes)`), each
  identity document's `prev`, the statements a passkey signs, the running head of a list
  (`fingerprintOf("head", …)`), and an audience (`fingerprintOf("audience", salt ‖ sorted ids)`).
- `fingerprint(bytes) = base64url(SHA-256(bytes))`, with no tag: used for a record's content commitment
  (`bodyOf(salt, content) = fingerprint(salt ‖ content)`, section 5), and as the last step of `statementsChallenge`.

When this document says "fingerprint" without a kind, it means `fingerprintOf` with the kind of the thing named.

> Note: the content commitment `bodyOf` is the one hash of protocol data that isn't tagged. It is safe as long as
> content bytes are never compared with fingerprints of other kinds, which they aren't.

Source: `public/static/signed.js` `fingerprint`, `fingerprintOf`; `public/static/records.js` `bodyOf`, `audienceOf`;
`src/lists.js` `headOf`.

### 3.4 Ed25519 keys and signatures

All keys other than passkeys are Ed25519 (RFC 8032), used through WebCrypto (`{name: "Ed25519"}`).

- **Public key**: its 32 raw bytes, in base64url (43 characters). `importPublicKey` refuses anything else.
- **Signature**: `Ed25519(privateKey, tagged(kind, bytes))`, its 64 bytes in base64url (86 characters).
  `checkAs(kind, key, bytes, signature)` is true only if the key imports, the signature decodes to exactly 64 bytes,
  and the signature verifies over the tagged bytes. It never throws.

| Key | Made | Kept | Signs |
|---|---|---|---|
| **Hosting key** | By the site, on first use | In the site's database, as PKCS #8 in base64url | Signed calls (section 2.3); heads and receipts (`head`); the host's own `remove` and `close` records (`record`). Never anything as the owner. |
| **Browser key** | By the browser at sign-in (`newKeyPair(false)`: the private key can't be extracted, even by the page) | In IndexedDB (`afterwrd-keys`, store `keys`, entry `browser`). Forgotten at sign-out. | Records (`record`) and profiles (`profile`), for as long as a passkey's delegation allows (section 4) |
| **Recovery key** | Worked out from the recovery code wherever it's typed (section 3.7) | Nowhere: only its public key is stored, in the identity document | Identity documents, as `identity` (section 4) |

Source: `public/static/signed.js` `newKeyPair`, `publicKeyText`, `importPublicKey`, `signAs`, `checkAs`;
`public/static/browserkey.js`; `src/keys.js` `hostingKey`.

### 3.5 Worked example

This was made by running `public/static/signed.js` in Node 22. The private key's 32-byte seed is the bytes `00 01 02 …
1f`:

```
seed (hex)       000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
public key       A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg
                 (hex 03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8)
```

An example identity document. This is only for its fingerprint: its passkey entry is a placeholder, so it isn't a valid
document. It uses this key as its `hosting` and the recovery key from section 3.7. These are its exact bytes:

```
{"v":2,"kind":"identity","seq":0,"prev":null,"origin":"https://sam.example.workers.dev","passkeys":[{"id":"example-credential-id","key":"example-cose-key","origin":"https://sam.example.workers.dev"}],"recovery":"BW60Df5FDlb5Zkqxa-FHLq2qqrvqUysWQ_keViRnpq4","hosting":"A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg"}
```

`fingerprintOf("identity", …)` of it, the person id: `Db-fjqtidPsE0Kw8j7iGpMrbgS3KhHR0b8xcyO7L_Lw`.

A profile signed with the same key. In real use a profile is signed by a browser key; here one key plays both parts, to
keep the example short. The bytes (115 bytes):

```
{"v":2,"kind":"profile","person":"Db-fjqtidPsE0Kw8j7iGpMrbgS3KhHR0b8xcyO7L_Lw","name":"Sam Taylor","at":1795000000}
```

The tagged bytes are 134 bytes: the 19-byte prefix `61 66 74 65 72 77 72 64 20 70 72 6f 66 69 6c 65 20 32 0a`
(`afterwrd profile 2\n`), then the 115 bytes above.

```
signAs("profile", key, bytes)    obu3yfb5vr258ruc-J_V08UD5yN8MbbquAxcn93ClY_4zyUJ_HWI16Z9iMNYNZp47d2h63g3GyLNlKuxs6-DBw
fingerprintOf("profile", bytes)  IMS_-99rTS21nxo3GUiPwa6pVpYgU0w08JqelWVCg8I
fingerprint(bytes) (untagged)    xDB3oL2zOBaQzpNQmRdZImBdAOtN_r-fZh7g8PM540s
checkAs("profile", …)            true
checkAs("record", …)             false   (same key, bytes and signature, different kind)
```

Ed25519 is deterministic, so a second implementation must produce exactly these values.

### 3.6 Passkeys and statements

A passkey (WebAuthn) can't sign arbitrary bytes. It signs a challenge. afterwrd makes that challenge from a list of
**statements**, each the `fingerprintOf` of something signed (an identity document, a delegation, a move
request), so that one prompt can sign several things at once. Anyone given the nonce and the list can check any one
statement without the others' contents.

**The challenge** (`statementsChallenge(nonce, statements)`):

```
challenge = base64url(SHA-256(tagged("statements", UTF-8(nonce + "\n" + s1 + "\n" + s2 + … + "\n" + sN))))
```

The nonce comes first, then each statement on its own line, with no newline at the end. The nonce must be 16 to 128
base64url characters, there must be at least one statement, and each must be 43 base64url characters. The browser
passes the challenge's 32 decoded bytes to `navigator.credentials.get` as `challenge`, with
`userVerification: "required"` and, except at sign-in, `allowCredentials` listing the passkeys that may sign
(those made at this site). The authenticator's
`clientDataJSON.challenge` is then the base64url text above.

Example, run in Node. The statements are the fingerprints of two placeholder byte strings,
`{"v":2,"kind":"identity","example":1}` as `identity` and `{"v":2,"kind":"delegation","example":1}` as `delegation`:

```
nonce        AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8
statements   a-nYCWCh2kbNAanlqwFZ_tBdKD_UclQcf6RK4FamtL8
             dzl6ReQMveR7HEVWc_TgDlLnlFVlkEwwYYLi9eZ8OeU
hashed       "afterwrd statements 2\nAAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8\na-nYCWCh2kbNAanlqwFZ_tBdKD_UclQcf6RK4FamtL8\ndzl6ReQMveR7HEVWc_TgDlLnlFVlkEwwYYLi9eZ8OeU"
challenge    V9pG9CSclFn-fp4tANNJUtTAvn8QKfO1p3-DzduCp-g
```

**A passkey proof** is what's stored with, and sent alongside, what the passkey signed:

```json
{
  "credential": "<credential id, base64url>",
  "nonce": "<the nonce, base64url>",
  "statements": ["<fingerprint>", "<fingerprint>"],
  "response": {
    "authenticatorData": "<base64url>",
    "clientDataJSON": "<base64url>",
    "signature": "<base64url>",
    "userHandle": "<base64url, optional>"
  }
}
```

The passkey it is checked against comes from an identity document (section 4): `{id, key, origin}`. `key` is the
credential's COSE public key in base64url, as registered. Registration takes the WebAuthn library's default algorithms (EdDSA, ES256 and RS256),
and requires a discoverable credential and user verification.

**Checking a proof** (`src/identity.js` `checkPasskeyProof(proof, passkey, statement)`). It is true only if:

1. `proof.credential` equals `passkey.id`, and `statement` is one of `proof.statements`;
2. `authenticatorData`, `clientDataJSON` and `signature` are all base64url text;
3. WebAuthn assertion verification (`@simplewebauthn/server` 14 `verifyAuthenticationResponse`) passes, with:
   - `clientDataJSON.type` equal to `webauthn.get`;
   - `clientDataJSON.challenge` equal to `statementsChallenge(proof.nonce, proof.statements)`;
   - `clientDataJSON.origin` equal to `passkey.origin`, and neither `crossOrigin: true` nor a `topOrigin` in it
     (a page framed inside another site's can't sign);
   - the authenticator data's RP id hash equal to SHA-256 of the host name of `passkey.origin`;
   - the user-present and user-verified flags both set;
   - the signature verifying with `passkey.key` over `authenticatorData ‖ SHA-256(clientDataJSON)`.

The signature counter isn't tracked: every proof is checked as if the stored counter were 0. `userHandle` isn't
checked. The result of each proof is remembered in memory, up to 5,000 proofs, so the same proof is verified only once.

Freshness is the signing site's business, not the reader's. The site that asked for the prompt makes the nonce: 32
random bytes in base64url (`randomToken`, or `generateAuthenticationOptions` at sign-in). It keeps the nonce in a short
cookie it signs itself (5 minutes) and spends it once (`spendChallenge`). A reader checking a
stored proof later, such as one on an identity document or a delegation, checks only that the proof signs the statement.

Which statements are signed together:

| When | Statements |
|---|---|
| Setting up signing | the first identity document (`identity`), this browser's delegation (`delegation`) |
| Signing in | this browser's delegation (`delegation`) |
| A browser that can't sign yet | its delegation (`delegation`) |
| Changing the identity | the next identity document (`identity`) |
| Agreeing to a move, on the new site | the move request (`move`) |
| A group's identity | the group's identity document (`identity`), signed by its owner's passkey |

Source: `public/static/signed.js` `statementsChallenge`; `public/static/passkey.js` `passkeySigns`, `credentialJSON`;
`src/identity.js` `checkPasskeyProof`; `src/keys.js` `proofFrom`, `start`, `finish`; `src/auth.js` `loginOptions`,
`loginVerify`, `withChallenge`, `readChallenge`, `spendChallenge`, `registerOptions`.

### 3.7 The recovery code and recovery key

The **recovery code** is 25 characters from Crockford's base32 alphabet, `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (no I, L,
O or U), written as five groups of five joined by `-`. That's 125 random bits. It is made in the browser: 25 random
bytes, each taken `& 31` as an index into the alphabet. It's shown to the owner once, and never sent to the site.

**Tidying** a typed code (`tidyRecoveryCode`): make it upper case, remove all whitespace and `-`, change `O` to `0` and
`I` or `L` to `1`. It must then be exactly 25 characters from the alphabet, and is written again as `XXXXX-XXXXX-XXXXX-
XXXXX-XXXXX`.

**The recovery key** (`recoveryKey`):

```
seed       = SHA-256(tagged("recovery", UTF-8(tidied code, with its dashes)))
private    = the Ed25519 private key whose RFC 8032 seed is `seed`
             (WebCrypto: PKCS #8 = 302e020100300506032b657004220420 ‖ seed)
public     = its 32-byte public key, base64url
```

No slow hashing is used: 125 random bits don't need it. Only `public` is ever stored, as the identity document's
`recovery`. The recovery key signs identity documents directly, as kind `identity` (section 4).

Example, run in Node:

```
code       7K3QF-0M2WX-9ZB4C-HT6RN-P5D8E   ("7k3qf 0m2wx-9zb4c-ht6rn-p5d8e" and "7K3QF-OM2WX-…" tidy to it)
seed (hex) 7e85303a6b1fbed933b16d9bbaff4e7e72c58429c9c6249c30a3df326d4fbab1
public     BW60Df5FDlb5Zkqxa-FHLq2qqrvqUysWQ_keViRnpq4
```

Source: `public/static/signed.js` `newRecoveryCode`, `tidyRecoveryCode`, `recoveryKey`; `src/views/devices.js`.

## 4. Identity

An identity is who signs: a person, or a group. It is not an address. A person's identity is a chain of identity
documents, each signed by the owner's passkeys or recovery key. The first document's fingerprint is the identity's id,
for good, whatever changes later: new devices, a new recovery key, a new address.

Each document names one hosting key (the site's own key, which signs as host and never as the owner) and one address
(`origin`). Browser keys sign the owner's records; each is allowed to do so by a delegation that one of the identity's
passkeys signed. A group's identity has no keys of its own: the person who made it signs for it.

Every reader works out an identity for itself, from the chain and its own clock. Nobody's word about "the current
document" is taken.

### 4.1 The id

The id is the fingerprint of the first document (`seq` 0) as kind `identity` (section 3):

```
id = base64url( SHA-256( "afterwrd identity 2\n" || bytes of document 0 ) )      // 43 characters
```

Records, lists, delegations and profiles name a person by this id (their `person`, `author` or `host` fields). It never
changes, so a reader that has met a person once knows them at any later address.

Source: `src/identity.js` `readIdentity`; `public/static/signed.js` `fingerprintOf`.

### 4.2 The identity document

An identity document is UTF-8 JSON, made once by the site that composes it and signed as those exact bytes. Readers
keep and pass on the bytes as received and never rebuild them (section 3).

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | number | yes | `2`. |
| `kind` | string | yes | `"identity"`. |
| `seq` | integer | yes | 0 for the first document, then 1, 2, … with no gaps. |
| `prev` | string or null | yes | `null` when `seq` is 0; otherwise the fingerprint (kind `identity`) of the document before. |
| `origin` | string | yes | The site's address now: a URL origin, exactly as `new URL(o).origin` gives it (no path, no trailing slash). `https:`, or any scheme on `localhost` or `127.0.0.1`. |
| `passkeys` | array | yes | A person's: 1 to 20 `{id, key, origin}` (below). A group's: exactly `[]`. |
| `recovery` | string | a person's only | The recovery key's Ed25519 public key: 32 bytes, base64url (43 characters). Must be absent in a group's. |
| `hosting` | string | yes | The hosting key's Ed25519 public key: 32 bytes, base64url (43 characters). |
| `owner` | string | a group's only | The id of the person who owns the group (43 characters). Its presence is what makes a document a group's. |
| `closed` | `true` | no | The identity has closed. Any value other than `true` is refused. |
| `cancels` | string | no | The fingerprint of a pending document this one cancels (4.4). |

Each passkey entry:

| Field | Type | Limit | Meaning |
|---|---|---|---|
| `id` | string | base64url, 1–512 characters, unique in the list | The WebAuthn credential id. |
| `key` | string | base64url, 1–1024 characters | The credential's COSE public key, as WebAuthn gives it at registration. |
| `origin` | string | an origin, as above | The address the passkey was made at. A passkey only works there, so its proofs are checked against this origin and its hostname as RP ID. |

Limits and rules a reader enforces (`parseIdentity`): the whole document is at most 4,096 bytes; `v` is exactly 2;
`seq` is a non-negative safe integer; `prev` matches `seq` as above. Anything malformed makes the document not an
identity document at all. Keys are only checked for shape here; a `recovery` or `hosting` value that is not a valid
Ed25519 point simply never verifies anything. Fields not in the table are not refused, and are ignored.

The reference implementation writes the fields in this order: `v, kind, seq, prev, origin, passkeys, recovery, hosting`,
then `owner`, `closed` or `cancels` where present, and each passkey as `id, key, origin`. Order does not matter for
signatures (the bytes are signed as they are), but it does matter for one comparison: see the note in 4.4.

A real document 0, made by running the repo's own code (a software passkey stood in for a phone):

```
{"v":2,"kind":"identity","seq":0,"prev":null,"origin":"https://afterwrd.ann-example.workers.dev","passkeys":[{"id":"7vyQKVBDOp10Q88QEKyG6A","key":"pQECAyYgASFYIOB0_XI8qJmemmh9-vE1T-Qyw-lX2pv5eKWHNMrIQVnFIlggnSqhkS7YDzb1lE5NFYxMd-_MFc49q_BE5cpWExyqry0","origin":"https://afterwrd.ann-example.workers.dev"}],"recovery":"JEN8EN6-AE6aOvieGA9oJPSJZDiZI6lW2jKNU3FDoRc","hosting":"vZ74IGfBF_RsZKBdBvDutHTJvTyxdpJYLrXFgEkFY0g"}
```

Its id, `SHA-256("afterwrd identity 2\n" + those bytes)` in base64url, is `5ZlwuPHaLz8_MkVydNmRkhkDh_ca2f9LOgW7ciEBP0w`.

Source: `src/identity.js` `parseIdentity`; `src/keys.js` `start`, `nextDocument`.

### 4.3 How a document is signed

A document travels as `{bytes, sig}`: `bytes` is the document in base64url, `sig` one of three shapes.

**By a passkey.** `sig` is `{passkey: proof}`. A passkey cannot sign arbitrary bytes, so it signs a WebAuthn challenge
built from a list of fingerprints, the statements (section 3). The proof:

```json
{
  "credential": "7vyQKVBDOp10Q88QEKyG6A",
  "nonce": "nZ_Zl5T-7MjPNT4IvH0HiUuxGXGDIt1IWDIA7saWj-s",
  "statements": ["5ZlwuPHaLz8_MkVydNmRkhkDh_ca2f9LOgW7ciEBP0w", "BiKQBhUAUtPt-QG492GWkCGoadfaH-ed7Z3dRuOf1Vs"],
  "response": {
    "authenticatorData": "-BN79CtY60qajoM581a7OA9IBALxFA5TcVhIpTHf2EcFAAAAAA",
    "clientDataJSON": "eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoibzNXdXl5YjhPRFUyc0dIR2cyZ1NSLTltNkZPT01saGxJaXQ0ak1LNDlyayIsIm9yaWdpbiI6Imh0dHBzOi8vYWZ0ZXJ3cmQuYW5uLWV4YW1wbGUud29ya2Vycy5kZXYiLCJjcm9zc09yaWdpbiI6ZmFsc2V9",
    "signature": "MEYCIQCAPyL6Z3DI71vWmmtkdiQxEeq3zIxZth2BwtJX3faRKAIhAJTJYZ6311va4-2GAmJUaYeY04Hcd5ngU49LTM0Z4qLK"
  }
}
```

(`response.userHandle`, base64url, may also be present.) This is the real proof for the document in 4.2: its first
statement is the document's fingerprint, its second the fingerprint of a delegation signed in the same prompt (4.10).

A proof checks against passkey `p` for statement `s` when (`checkPasskeyProof`):

1. `proof.credential` equals `p.id`, and `proof.statements` includes `s`;
2. `authenticatorData`, `clientDataJSON` and `signature` are base64url strings;
3. it is a valid WebAuthn assertion (`@simplewebauthn/server` `verifyAuthenticationResponse`) with expected challenge
   `statementsChallenge(proof.nonce, proof.statements)`, expected origin `p.origin`, RP ID the hostname of `p.origin`,
   user verification required, and the public key `p.key`. The signature counter is not checked (it is given as 0).

The nonce must be 16–128 base64url characters and every statement a 43-character fingerprint, or the proof fails. A
reader does not check that a nonce was used once: that is the signing site's business when it hands out the challenge.
A proof is valid for every statement in its list, so one prompt can sign several things.

**By the recovery key.** `sig` is `{recovery: signature}`: an Ed25519 signature (64 bytes, base64url) by the key in
`recovery`, over `"afterwrd identity 2\n" + bytes` (section 3 `signAs("identity", …)`).

Source: `src/identity.js` `checkPasskeyProof`; `public/static/signed.js` `statementsChallenge`, `checkAs`.

### 4.4 Reading a chain

A reader reads a chain with `readIdentity(chain, firstSeen, at)`: `firstSeen(fp)` is when this reader first saw the
document with fingerprint `fp` (its own clock, seconds), `at` is now. The answer is the id, the document in effect
(`current`), any change still waiting (`pending`, and `effectiveAt`), the history of documents in effect and from when,
and `problem` if the chain stops being believable part-way. Everything before the problem still counts.

**Document 0** must parse, have `seq` 0, no `cancels` and no `closed`, and be signed by one of its own passkeys (a
group's: see 4.14). The recovery key cannot sign document 0. If any of this fails, there is no identity at all.

**Each later document `i`** must parse, have `seq` equal to `i`, `prev` equal to the fingerprint of document `i-1`,
and the same `owner` (or none) as document 0. Otherwise the problem is `"broken"` and reading stops.

Then the reader compares it with the document in effect (`before`) and classifies the change:

| Change | Signed by | Takes effect |
|---|---|---|
| Only adds passkeys | a passkey in `before` | at once ("fast") |
| Anything else: removes or alters a passkey, a new `recovery`, a new `hosting`, a new `origin`, `closed` | a passkey in `before`, or the recovery key | 7 days after the reader first saw it ("slow") |
| Anything at all | the recovery key | 7 days after the reader first saw it |

A passkey counts as removed if no passkey in the new list has the same `id` and the same JSON serialisation.

A document signed by none of these gives the problem `"unsigned"`. A document with `cancels` when nothing is pending
gives `"unexpected"`.

**The 7 days** run from `firstSeen` of the slow document, by this reader's clock, never from any time written in a
document, so a signer cannot backdate past them. `SLOW_SECONDS` is 604,800. (A test build may shorten it, on local test
sites only.)

**While a change is pending**, the only document that may follow is a cancel: a document whose `cancels` is the pending
document's fingerprint and whose content (`origin`, `passkeys`, `recovery`, `hosting`, `owner`, `closed`) is the same as
the document in effect before the pending one. Anything else gives `"unexpected"`. Who may cancel:

- a change signed by a passkey: any passkey in the document in effect before it, or the recovery key;
- a change signed by the recovery key: only the recovery key.

So someone holding a stolen passkey cannot stop the owner removing it with the recovery code. A cancel takes effect
at once, from when the reader first saw it.

**Settling.** A pending change takes effect at `effectiveAt` if nothing cancels it first. When a further document
follows, the pending one is judged at the moment the reader first saw that next document (or now, if earlier): a cancel
seen in time still cancels, however late the whole chain is read. After the last document, it is judged at `at`.

**Closed.** If the document in effect has `closed: true` and another document follows, the problem is `"closed"`.

**History.** Each document that came into effect is kept with the time it did so, so something signed in the past is
checked against the identity as it was then (`documentAt(state, t)`). A fast change counts from the same time as the
document before it, not from when the reader saw it. So a reader who learns an identity today still accepts yesterday's
record from the owner's second phone. A slow change counts from `effectiveAt`; a cancel from when it was first seen;
document 0 from time 0.

> Note: `classify` and the cancel check compare passkey entries and content with `JSON.stringify`. Two documents
> listing the same passkeys with fields in a different order, or the passkeys in a different order (for a cancel),
> are treated as different. Another implementation must copy `passkeys` entries exactly as they were, in the same
> order, or a "fast" change becomes "slow" and a cancel is refused.

> Note: a pending change blocks every other change, including fast ones, until it settles or is cancelled.

Source: `src/identity.js` `readIdentity`, `classify`, `documentAt`, `SLOW_SECONDS`.

### 4.5 GET /.well-known/afterwrd

Every site that has an identity publishes it here, to anyone, without a signed call.

```http
GET /.well-known/afterwrd HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: public, max-age=60
Access-Control-Allow-Origin: *

{"v":2,"chain":[{"bytes":"eyJ2IjoyLCJraW5kIjoiaWRlbnRpdHkiLCJzZXEiOjAs…","sig":{"passkey":{…}}}]}
```

- `chain`: every identity document, oldest first, each `{bytes, sig}` as in 4.3. Nothing else about the owner: no
  name, no picture.
- `owner`: a group's site only (4.14): its owner's chain, in the same form, as the group's site last learnt it.
- 404 `{"error":"Not found."}` when the site has no identity yet: before the owner has set up signing, or on a site
  that is taking a move (4.13) until the move completes there.
- Only `GET`. Answered on a person's site and on a group's site.

A site that has moved away keeps answering with the whole chain, whose last document names the new address.

Source: `src/identities.js` `handleIdentity`; `src/app.js` (both routers).

### 4.6 Learning, checking and remembering identities

**Fetching.** To learn the identity at an address, a site fetches `GET <origin>/.well-known/afterwrd` without following
redirects (a redirect is a failure), with an 8-second timeout, and refuses a reply over 512 KiB. The `chain` is decoded
(1–200 documents, each with base64url `bytes` and an object `sig`). The site first reads it without keeping anything,
and learns it (below) only if some document in it, in effect or waiting, names that `origin`: a site can't hand out
someone else's identity as if it were its own. A group's chain is read with the `owner` chain beside it. The site then
accepts it as the identity at that address only if it reads, is not frozen, and its document in effect names exactly
that `origin`. (An address someone has moved away from still gives their identity, so their friends can follow them.)

**Identities passed along.** Sites also hand each other identities they know: as `people: {<id>: {chain, profile?}}`
beside lists, notes and group pages (sections 6, 8, 9, 10). A reader learns each one the same way, and uses it only if
its id is the one it was given under. Whoever passes an identity along is not trusted for anything: the chain checks
or it does not. A reader learns only the people who signed a record in that same answer or note, and someone it
doesn't know yet only once one of their records there checks against the chain given (read first, keeping nothing).
It learns at most 1,100 new identities from one answer, and 3,000 a day (UTC) from one sending site. So a host can't
fill a reader with identities nobody signed anything with.

**An address is only confirmed by fetching it.** An identity learnt any way but by fetching it from its own address
(passed along, in a note, a group's owner beside its chain) says where it lives, but that is only its own claim: anyone
can make an identity whose document names someone else's address. So a site accepts a signed call "from" an address
with a known identity's hosting key only once it has fetched that identity from that very address itself
(`origin_checked_at`); otherwise it fetches `<origin>/.well-known/afterwrd` first, and what the real site there says
is what counts. Learning a chain that names a different address than before forgets the confirmation. A comment
note's writer is learnt only once their comment checks, within the limits above (since 2.3.2). The one exception is a
mention receipt (9.x), whose content is the writer's own signed comment and doesn't rely on where the call came from.

**First seen.** For every document in the clean part of a chain it is given (below), the reader notes the time it
first saw that document's fingerprint, once, in its own clock. These times are what the 7 days run from, and they are
never taken from the sender. A document that doesn't read cleanly isn't noted, so nobody can start a change's 7 days
early by handing a reader its bytes before they're signed.

**Keeping the longest clean chain.** The reader finds the longest start of the chain that reads with no problem (4.4),
dropping anything after the first problem. Then, against what it already knows for that id:

| Case | What the reader does |
|---|---|
| Nothing known | Keeps the clean chain. |
| The known chain and the new one differ at some `seq` they both have | **Fork.** The identity is frozen here, for good. |
| The known chain is as long or longer, and agrees | Keeps the known one. A shorter chain is never a rollback: it is simply older news. |
| The new chain is longer, and agrees | Keeps the new one. |

A frozen identity counts for nothing at that reader: records it signed are refused (section 5), it is not passed on in
`people`, its profile is not shown, and fetching it gives nothing. Two different documents at the same place mean
someone holding one of its keys is fighting the owner.

The reader also keeps, beside the identity, where it is moving or has moved (4.13).

Source: `src/identities.js` `fetchIdentity`, `learnIdentity`, `learnPeopleIn`, `signersIn`, `parseChain`, `cleanest`,
`seenTimes`; `src/identity.js` `forked`.

### 4.7 Changes the owner's site makes

The protocol is the chain and the rules in 4.4. How a site composes documents is up to it. For a reviewer, the
reference implementation makes these (all between the owner's browser and their own site, not between sites):

| Change | New document | Signed by | Speed |
|---|---|---|---|
| Set up signing | document 0: every passkey the owner has on the site, the recovery key the browser worked out from a new recovery code, this site's hosting key | one of those passkeys, in the same prompt as the browser's first delegation | – |
| `allow` | adds every passkey on the site that isn't listed | a listed passkey | fast |
| `remove` | drops one passkey (never the last) | a listed passkey | slow |
| `recovery` | a new recovery key | a listed passkey | slow |
| `move` | new `origin`, `hosting` and `passkeys` (4.13) | a listed passkey | slow |
| `devices` | `passkeys` replaced by those on the site now | the recovery key | slow |
| `cancel` | `cancels` the pending document, content as before it | a listed passkey (not for a recovery-signed change) or the recovery key | at once |

The next document copies `origin`, `passkeys`, `recovery` and `hosting` from the document in effect, then overrides
the changed fields. The site refuses a new change while one is pending. It appends a document only if the chain still
reads with no problem, and only if nobody else appended meanwhile. The owner's browser signs the bytes the site gives
it, with a passkey (`public/static/passkey.js` `passkeySigns`) or with the recovery key; it does not inspect them.

> Note: a new `hosting` key is slow (since 2.3.2). Whoever holds it signs every call the site makes, so someone with a
> stolen passkey mustn't be able to replace it at once. Every change a site makes (`allow`, `remove`, `recovery`,
> `devices`) carries the site's own hosting key while the identity is at the site's address, so removing a stolen
> passkey also puts back any key it set. A cancel keeps the content of the document before the pending one, as above.
> `change/finish` takes only the document `change/start` made: the nonce it hands out ends with that document's
> fingerprint. Nothing ever makes a document with `closed: true`.

Source: `src/keys.js` `start`, `finish`, `changeStart`, `changeFinish`, `recoverStart`, `recoverFinish`, `nextDocument`,
`appendDocument`; `src/views/devices.js`.

### 4.8 Recovery

**The recovery code** is 25 characters of Crockford base32 (no I, L, O or U), shown once as five groups of five
(`EA65F-0VPG0-MBPMQ-9J0GW-9T4HH`): 125 random bits. It is never sent to the site. In the browser, the typed code is
tidied (upper case, spaces and dashes removed, `O` read as `0`, `I` and `L` as `1`) and turned into a key:

```
tidy  = the 25 characters, in groups of five joined by "-"
seed  = SHA-256( "afterwrd recovery 2\n" || UTF-8(tidy) )          // 32 bytes
recovery key = the Ed25519 key whose 32-byte private seed is `seed`
```

Only its public key goes into the identity (`recovery`). No slow hash is used: 125 random bits need none.

**Using it.** The recovery key signs an identity document directly (`{recovery: signature}`, 4.3). Whatever it signs is
slow, and only the recovery key can cancel it. In practice it does two things: puts the site's current passkeys in
place of the listed ones (`devices`), after losing every device; or cancels a pending change, including one a stolen
passkey made.

**Getting back into the site without a passkey** (through the Cloudflare account the site runs in, `src/recover.js`) is
not part of the protocol. It ends with a new passkey on the site, which can sign in but does not sign for the owner. To
make it sign, the owner still needs the recovery code (`devices`). Without the code, a lost identity stays lost.

Source: `public/static/signed.js` `newRecoveryCode`, `tidyRecoveryCode`, `recoveryKey`; `src/keys.js` `recoverStart`,
`recoverFinish`.

### 4.9 Adding a device

A new device's passkey signs for the owner only once a passkey that already does says so. Nothing else can add one:
a new passkey can't add itself, however it came to be on the site.

1. On a device that signs, the owner makes a device link: a one-time link to make a passkey on the site.
   The new device opens it and makes its passkey. That passkey can sign in to the site, but isn't in the identity yet.
2. On the device that signs, the owner lets it: the `allow` change (4.7), one prompt, adds every passkey on the site
   that isn't in the identity. It's fast, so it counts at once.
3. On the new device, one prompt signs a delegation for its browser key (as for a browser that can't sign yet, 4.10).

The link is never part of the identity, so whoever later finds a used link learns nothing that lets them sign.

Source: `src/keys.js` `changeStart` (`allow`), `signingNow`, `browserStart`, `browserFinish`; `src/views/pages.js` `joinPage`.

### 4.10 Browser keys and delegations

**A browser key** is an Ed25519 key pair made in the browser at sign-in, with WebCrypto, not extractable, and kept in
IndexedDB. It signs the owner's records (section 5) and profile (4.12) without a prompt. Signing out deletes it from the
browser and stops the site accepting it.

**A delegation** lets a browser key sign for a person until a set time:

| Field | Type | Meaning |
|---|---|---|
| `v` | number | `2` |
| `kind` | string | `"delegation"` |
| `person` | string | The identity's id. |
| `key` | string | The browser key's Ed25519 public key, base64url, 43 characters. |
| `origin` | string | The site the browser signed in at (an origin, as in 4.2). |
| `expires` | integer | Unix seconds. The reference site sets now + 30 days (2,592,000 s). |

Real example (it is the second statement in the proof in 4.3):

```
{"v":2,"kind":"delegation","person":"5ZlwuPHaLz8_MkVydNmRkhkDh_ca2f9LOgW7ciEBP0w","key":"Od6KCNBZoRwXBR26jhsmsdkIQG_u4cMZ-OKCBOgipkU","origin":"https://afterwrd.ann-example.workers.dev","expires":1798019944}
```

It is signed by one of the identity's passkeys as a statement, `fingerprintOf("delegation", bytes)`, usually in the
sign-in prompt itself. Then the WebAuthn nonce is the sign-in challenge, so one prompt both signs in and delegates. It
travels as `{bytes: base64url, proof}`, in maps `delegations: {<browser key>: {bytes, proof}}` beside the records it
backs (sections 5, 6, 8, 9).

**Checking.** A delegation lets `key` sign for `state` at time `at` when (`checkDelegation`): the bytes are at most
1,024 bytes; `v`, `kind` and `person` are right; `key` is 43 base64url characters; `origin` is an origin; `expires` is a
safe integer and `at` is not after it; and the proof checks against a passkey of `documentAt(state, at)` (the identity
as it was at `at`) or of the document in effect now. For a record, `at` is the host's "taken at" time (section 6). So a
passkey removed since still vouches for what its keys signed before it went, and vouches for nothing after.

**Holding the key.** Before the owner's site keeps a delegation from its own browser (signing in, setting up signing,
a browser that can't sign yet), the browser signs the delegation's bytes with the browser key it names, as
`signAs("delegation", privateKey, bytes)`, and sends that signature as `possession`. The site refuses the delegation
unless `checkAs("delegation", key, bytes, possession)` holds (`holdsKey`), so a passkey only ever lets sign a key the
browser it's used in has. Readers don't see or need `possession`.

A site keeps every delegation of its owner's for good, so it can pass them on with what they signed. But it accepts new
records from a browser key only while that key's delegation is live there: not expired, not signed out.

> Note: readers enforce only `expires`. They do not cap a delegation's length, check `origin`, or have a start time: a
> delegation vouches for any `at` up to `expires`, including before it was made. The 30-day limit, and the address, are
> checked only by the owner's own site when it accepts a delegation from its browser (`sentDelegation`: expiry no more
> than 30 days and 10 minutes ahead, origin this site's). Only the owner's site can prompt for a delegation, and the
> host's "taken at" time (section 6) bounds what a key could sign before it existed.

Source: `src/identity.js` `checkDelegation`; `src/keys.js` `loginDelegation`, `sentDelegation`, `holdsKey`, `keepDelegation`,
`DELEGATION_SECONDS`; `src/auth.js` `loginOptions`, `loginVerify`; `public/static/browserkey.js`.

### 4.11 The hosting key

Each site has one hosting key: Ed25519, made on first use, kept by the site (PKCS #8). Its public key is the identity's
`hosting`. It signs what the site does as host, never anything as the owner:

- signed calls to other sites (section 2);
- list heads, checkpoints and receipts (section 6);
- records of kind `remove` or `close`, on the site's own items only (`author` and `host` both the site's identity:
  section 5).

A reader checks a host's signature against `hosting` in the document in effect, or as it was when the thing was signed
(a site that has moved signed its earlier removals with its old key). A group's site has a hosting key of its own, just
like a person's.

Source: `src/keys.js` `hostingKey`; `src/records.js` `HOST_KINDS`, `checkRecord`; `src/identities.js` `hostingKeyFor`.

### 4.12 Signed profiles and names

A profile is what a person calls themselves. It is signed by one of their browser keys and carries only a name: no
picture.

```
{"v":2,"kind":"profile","person":"5ZlwuPHaLz8_MkVydNmRkhkDh_ca2f9LOgW7ciEBP0w","name":"Ann Example","at":1795427944}
```

It travels as an envelope, with the delegation behind its key:

```json
{
  "bytes": "eyJ2IjoyLCJraW5kIjoicHJvZmlsZSIsInBlcnNvbiI6IjVabHd1…",
  "key": "Od6KCNBZoRwXBR26jhsmsdkIQG_u4cMZ-OKCBOgipkU",
  "signature": "Jb0KfR1_9DawCtr2nYKtQR4zkkDu6ZBDsc2Ah1N59xON5cM2lQGXRk-NydrPREfSieD0W4GK4XdOcZsiglmyCw",
  "delegation": { "bytes": "eyJ2IjoyLCJraW5kIjoiZGVsZWdhdGlvbiIs…", "proof": { "credential": "7vyQKVBDOp10Q88QEKyG6A", "…": "as in 4.3" } }
}
```

`signature` is Ed25519 over `"afterwrd profile 2\n" + bytes`.

A reader accepts a profile for identity `state` when (`checkProfile`): the bytes decode to `v` 2, `kind` `"profile"`,
`person` equal to the id, a string `name` and a safe-integer `at`; the delegation checks at time `at` (4.10) and names
`key`; and the signature checks with `key`. Only the first 100 characters of the name are used. A reader keeps a
profile in place of the one it holds only if its `at` is later, so an old signed profile passed on again can't put back
an old name.

The owner's site makes the profile bytes and the browser signs them in the background with its key (no prompt). The
site keeps one only if its `name` is the owner's name there, `at` is within 10 minutes of now, and the key's delegation
is live. It asks for a new one when the name changes or the delegation behind the kept one has less than a day left.

**Where profiles go:** beside an identity in `people`, in the Connect answers and in `/_p/items` (sections 8, 9,
10).

**How names are shown** (local, not wire): a friend is shown by the name the owner approved when they became friends,
with a note if their signed name has since changed. Anyone else is shown by their signed name, with a warning when it
looks like a friend's (or, in a group, the owner's or an admin's) once case, accents, spaces and look-alike letters are
folded.

Source: `src/identities.js` `checkProfile`, `handleIdentity`; `src/keys.js` `keepProfile`; `src/ownprofile.js`
`profileToSign`; `public/static/signprofile.js`; `src/names.js` `peopleShown`.

### 4.13 Moving to a new address

A person moves their identity to a new site by a slow change of `origin`. The id stays the same.

**The move request (`kind: "move"`).** The new site, which has no identity of its own, makes a request for its own
passkey to sign:

```json
{"v":2,"kind":"move","from":"https://afterwrd.ann-example.workers.dev","to":"https://ann.example","hosting":"<new site's hosting key, 43 characters>","passkey":{"id":"<credential id>","key":"<COSE key>","origin":"https://ann.example"},"at":1795427944}
```

The new site's passkey (the one this device signed in with there) signs `fingerprintOf("move", bytes)` as its only
statement. The owner's browser carries `{request: base64url, proof}` to the old site's agreement page; no site-to-site
call is made. The old site accepts it only if: `from` is its own address; `to` is a different, valid site address; the
bytes are under 4,096 characters of base64url; `hosting` is 43 characters and not the old site's hosting key;
`passkey.origin` is `to`; `at` is within 24 hours of now; and the proof checks against `passkey`. The request must be
signed by the new site's passkey, so a new host cannot slip in a key of its own for the owner to agree to without
noticing.

**The identity document.** The old site then makes the next document, with `origin` = `to`, `hosting` = the new site's
key, and `passkeys` = only the new site's passkey (the old ones work only at the old address). `recovery` is
unchanged. One of the passkeys in effect signs it. It is slow: 7 days from when each reader first sees it. Until then,
any old passkey, or the recovery key, can cancel it.

**What each side does**

| Who | When | What |
|---|---|---|
| New site | before the move takes effect there | Has no identity: serves 404 at `/.well-known/afterwrd`, signs nothing, answers friends' calls `409 {"error":"Not moved here yet.","moving":true}`. It reads the old site's `/.well-known/afterwrd` to see the document. |
| New site | once in effect | Takes the chain as its own and serves it. |
| Old site | after it signs | Keeps serving the whole chain. Its own signed calls name the old address until the move takes effect there. |
| Old site | once in effect | Answers friends' signed calls `410 {"error":"Moved.","moved":"<to>"}`, and refuses further identity changes ("change your identity there"). |
| A friend's site | on any sign of a change (the chain length in `/_p/items`, or a 410) | Fetches the identity again from the old address. The fetch "fails" there (the document in effect no longer names it), but the chain is learnt, and with it where the person is moving and when. |
| A friend's site | once in effect by its own clock | Calls the person at the new address, and takes their calls from it. Before then, a call from the new address gets `409 {"error":"Not moved here yet.","moving":true}`, which means "later", not "no". |

Each reader switches at its own time: 7 days after it first saw the move.

Source: `src/keys.js` `moveRequest`, `moveCheck`, `changeStart`, `ownMove`, `ownOrigin`; `src/movein.js` `start`, `finish`,
`fetchMove`; `src/identity.js` `moveOf`; `src/calls.js` `friendCalling`; `src/friendcopies.js`.

### 4.14 A group's identity

A group has no devices and no recovery code. Its documents have `owner` (the id of the person who made it),
`passkeys: []` and no `recovery`. The owner never changes: every document must have document 0's `owner`.

**Who signs.** Document 0, and any later document, is signed by one of the owner's passkeys, as the owner's identity
had them when this reader first saw the group's document, or as it has them now. A later document may instead be
signed by the owner's current recovery key. The rules for fast, slow, pending and cancel are as in 4.4, applied to
the group's own documents.

**Reading needs the owner.** A reader reads a group's chain with the owner's identity beside it, as that reader knows
it. It refuses the group (no identity at all) if it does not know the owner, or the owner's identity is frozen, closed or
itself a group's.

**`/.well-known/afterwrd` on a group's site** returns the group's chain and, as `owner`, its owner's chain. A reader
learns the owner's chain first, if it is a person's, and then the group's.

**Setting it up.** Once the group's site is running:

1. The owner's site reads the group site's hosting key from `GET /_group/ping` (`{afterwrd: "group", version, protocol,
   hosting}`), and makes document 0: `{"v":2,"kind":"identity","seq":0,"prev":null,"origin":<group's address>,
   "passkeys":[],"hosting":<that key>,"owner":<owner's id>}`.
2. One of the owner's passkeys signs it there (only passkeys made at the owner's own address can be used).
3. The owner's site sends `POST /_group/identity` to the group's site, as a signed call (section 2), with body
   `{chain: [<document 0>], owner: <owner's chain>}`.
4. The group's site accepts it only if: the call is signed by the site that claimed the group (its owner member,
   not yet tied to an identity: 403 otherwise, including a second attempt); it has no identity yet (409 otherwise); `chain` has exactly one document; the owner's
   chain reads cleanly, is not frozen, and names the calling site's address; document 0 names that owner, the group's
   own address and its own hosting key; and the owner's passkey signed it. Then the group's id is document 0's
   fingerprint, and its members list (section 10) takes that id.

> Note: no code makes a later document for a group (no passkey change, move or close), so in practice a group's chain
> is one document long.

Source: `src/identity.js` `readIdentity`, `ownerOf`; `src/identities.js` `readChain`, `learnIdentity`, `handleIdentity`;
`src/groupidentity.js` `handleGroupIdentity`, `setGroupIdentity`; `src/groups.js` (`/_group/ping`).

## 5. Records

A record is one signed statement by one person about one item: a post made, a comment, an edit, a vote, a member let
into a group. Every record lives on exactly one list (section 6), kept by its host. The host numbers it and signs where
the list is up to; it never changes the record.

### 5.1 The wire form

A record travels as a `sent` object:

```json
{
  "record": "<the record's bytes, base64url>",
  "sig": "<signature: 64 bytes, base64url>",
  "content": "<the content's bytes, base64url; only for kinds with content>",
  "salt": "<16 random bytes, base64url; with content>"
}
```

- `record` is the exact UTF-8 JSON the writer signed. It is stored and passed on byte for byte and never rebuilt, so
  key order and spacing are whatever the signer produced. The afterwrd browser code writes it with `JSON.stringify`.
  At most 4,096 bytes (`MAX_RECORD`).
- `sig` is an Ed25519 signature of `"afterwrd record 2\n"` followed by the record's bytes (section 3), made with the
  key the record names in `key`.
- The record's **fingerprint**, its id everywhere, is `fingerprintOf("record", bytes)`: base64url (no padding, 43
  characters) of SHA-256 of `"afterwrd record 2\n"` followed by the bytes. The same bytes sent twice are the same record.
- `content` is the UTF-8 JSON of what the record carries (words, a vote, a role), at most 16,384 bytes
  (`MAX_CONTENT`). It is not inside the signed bytes. The record holds `body` instead: base64url of SHA-256 of the
  16-byte `salt` followed by the content's bytes (plain SHA-256, with no `afterwrd` prefix). So nobody holding only the
  record can guess short content.
- A record whose kind carries content must have `body`, and is always sent with its content: words go only with the
  whole record, when its entry is emptied (6.7). Such a record sent without its content, content sent beside a record
  whose kind has none, or content that doesn't match `body`, makes the whole record fail its check.

The key that signed it is vouched for separately. A browser key is vouched for by a **delegation** (section 4), sent
beside the record, never inside it: in a write call as `delegation: {bytes, proof}`, and in a list read as a
`delegations` map from browser key to `{bytes, proof}`. The writer's identity document chain and signed name travel the
same way, as a `people` map from person id to `{chain, profile?}`.

Source: `public/static/records.js` `makeRecord`, `bodyOf`, `contentOf`, `MAX_RECORD`, `MAX_CONTENT`;
`public/static/signed.js` `signAs`, `fingerprintOf`.

### 5.2 The envelope

Every record is a JSON object with these fields. "Required" is what `parseRecord` refuses a record without. Ids
(person ids, keys, fingerprints) are always 43 base64url characters (`^[A-Za-z0-9_-]{43}$`).

| Field | Type | Required | Meaning and limits |
|---|---|---|---|
| `v` | number | yes | Always `2`. |
| `kind` | string | yes | One of the kinds in 5.5. |
| `author` | id | yes | The writer's person id (their identity's first fingerprint, section 4). |
| `key` | id | yes | The Ed25519 public key (32 raw bytes, base64url) that signed it: one of the author's browser keys, or, for a host's own `remove` or `close`, its hosting key. |
| `host` | id | yes | The person id of the site that keeps the list: a person's site, or a group's. |
| `item` | id | not for `item`; required for every other kind | The item it's on. A record of kind `item` must not have it: its own fingerprint is the item's id. For a group's members list, the group's person id. |
| `seen` | `{n, h}` or `null` | not for `item`; required (may be `null`) for every other kind | The point in the list the writer last saw: `n` an integer ≥ 0, `h` that entry's running head (6.3). `null` only for the first entry of a list. |
| `prev` | id or `null` | not for `item`; required (may be `null`) for every other kind | The fingerprint of the writer's own previous record on this list, or `null` if this is their first there. |
| `about` | id | for `edit`, `delete`, `remove`, `approve`, `role`, `calloff` only, and required for them | The record it acts on. |
| `version` | id | for `vote` and `answer` only, and required for them | The fingerprint of the version of the item it answers (section 7). |
| `role_at` | `{n, h}` | optional, any kind | For an admin's action in a group: the point in the group's members list at which they held the role. |
| `date` | string | optional, `answer` and `calloff` only | `YYYY-MM-DD` (month 01–12, day 01–31): one date of a repeating event, in the event's own time zone. Puts the record on that date's list (6.1). |
| `mentions` | array of ids | optional | Person ids it mentions, at most 10. |
| `audience` | `{kind: "invited", fp}` | optional, `item` and `change` only | Who an event is for, as a salted fingerprint, never the list of people (section 7). `kind` must be `"invited"`. |
| `body` | id | for kinds with content, and only for them | Salted SHA-256 of the content (5.1). |
| `at` | integer | yes | When the writer says they signed it, Unix seconds. Shown nowhere; hosts' "taken" times are shown. |
| `before` | integer | optional, `item` and `comment` only | Only for what's brought over from afterwrd 1: when it was first written, Unix seconds, above 0 and below `at`. Shown in place of the host's taken time when earlier (`writtenAt`). A host takes it only while bringing its own old rows over, and refuses it otherwise. |
| `old` | integer | optional, `item` with `before` only | A group post brought over from afterwrd 1: its number there, above 0. |

`parseRecord` does not refuse fields it doesn't know. They are signed, so they can't be added or taken away, but
nothing reads them.

Source: `public/static/records.js` `parseRecord`, `KINDS`, `WITH_CONTENT`, `ABOUT`, `VERSIONED`, `DATED`, `BROUGHT`,
`writtenAt`; `src/hosted.js` `takeRecord`.

### 5.3 When a record checks

The same check runs at the host when a record arrives and at every reader for every entry it is shown. A record checks
when all of these hold (`src/records.js` `checkRecord`, which never throws):

1. Its bytes decode from base64url and pass `parseRecord` (5.2): shape, size and the per-kind fields.
2. The author's identity is known (or can be fetched, section 4), and is neither frozen nor closed.
3. Its `key` is either:
   - the author's hosting key, as it is now or as it was at time `at` (`documentAt`). Then the record must be a
     `remove` or `close`, and `author` must equal `host`: a host acting as itself, on its own lists only. Such a record
     is "by host"; or
   - a browser key with a delegation that checks against the author's identity at time `at` (`checkDelegation`,
     section 4) and names this key.
4. `sig` is that key's signature of the record bytes as kind `record`.
5. `content` is sent exactly when the kind carries content, and then the salt is 16 bytes, the content is at most
   16,384 bytes, its salted SHA-256 equals `body`, and it parses as JSON.

`at` here is the time the check is made for: the host uses its clock now; a reader uses the entry's `taken` time, so a
record stays good after the delegation behind it has expired, as long as it was good when the host took it.

> Note: no code path in this version signs a record with a hosting key. Hosts and readers accept such a `remove` or
> `close`, but the owner's removals are signed by their browser key like everything else.

Source: `src/records.js` `checkRecord`, `HOST_KINDS`; `src/identity.js` `checkDelegation`, `documentAt`.

### 5.4 Which list a record goes on

- `item`: starts a new list whose id is the record's own fingerprint.
- Any record with `date`: the list `"<item>/<date>"`, one date of a repeating event.
- Every other record: the list named by its `item`.

A group's members list is the list whose id is the group's own person id, so its records have `item` equal to `host`.

Source: `src/lists.js` `listOf`, `dateList`, `parseListId`.

### 5.5 The kinds

There are 15 kinds. "Owner" means the item's writer (the author of its `item` record; for a members list, the group's
owner as its identity names them). Content shapes belonging to posts, polls and events are in section 7; the members
list is in section 10.

| Kind | Content | `about` | On | Who may sign it |
|---|---|---|---|---|
| `item` | yes | – | starts its own list | On a person's site, its owner only. In a group, any member. |
| `change` | yes | – | item | The item's owner. |
| `comment` | yes | – | item | Anyone the host lets see the item. |
| `edit` | yes | yes | item | The writer of the record it's about. |
| `delete` | – | yes | item | The writer of the record it's about. |
| `vote` | yes | – | item | Anyone who may see the poll. |
| `answer` | yes | – | item, date | A guest of the event (in a group: any member). |
| `end` | – | – | item | The poll's owner, once. |
| `close` | – | – | item, members | The item's owner, or the host; on a members list, the group's owner. |
| `remove` | – | yes | item, members | On a person's item: the item's owner or the host. In a group: its owner or an admin. |
| `calloff` | – | yes | item, date | In a group only: its owner or an admin; on one date, also the event's writer. |
| `join` | yes | – | members | The person joining. |
| `approve` | – | yes | members | The group's owner or an admin. |
| `role` | yes | yes | members | The group's owner. |
| `leave` | – | – | members | A member, or someone waiting. |

Kind by kind:

- **`item`** makes an item: a post, a photo, an event. Content is the post itself, `{type: "post" | "event" | "photo",
  …}` (section 7). On a person's site an event's `item` carries `audience`; a post's must not, and nothing in a group may. The record must be the list's first entry,
  and its fingerprint is the list's id.
- **`comment`**: content `{text, mentions?, here?}`. `text` must not be blank and is at most 2,000 characters. `mentions` is
  `[{name, person}]`: each `person` must be in the record's signed `mentions` and `@name` must appear in `text` as a
  whole word. `here: true` (groups only) must match `@here` in the text. Who may be mentioned is a host rule (section
  9). Hosts check all of this before taking it.
- **`edit`**: new words for the item itself (`about` = the item) or for one of the writer's comments. Content
  `{text, mentions?}`; at most 5,000 characters for a post (a group's own limit in a group) and 2,000 for a comment. It
  must be taken within 15 minutes (900 seconds) of the record it edits, by the host's taken times, and nobody else may
  have added an entry since that record. An event's words change with a `change`, never an `edit`; a post without
  photos can't be edited to no words.
- **`delete`**: takes back the writer's own record. The host then empties that record's entry (6.7). A delete whose
  `about` is the item itself deletes the whole item: the list ends, everything on it goes, and the item's photos and a
  repeating event's date lists go with it. Deletes are never held to the per-person cap or the daily cap.
- **`change`**: the item's owner changing it: an event's details and words `{event, text}`, or a post's remaining
  photos `{photos}` after one is deleted (section 7). May carry `audience` when who is invited changes. Not held to
  the per-person cap.
- **`vote`**: content `{choices: [index…]}`; an empty array takes a vote back. `version` must be the poll's current
  version, which is the poll's item id (nothing changes a poll). Refused once the poll has ended or its closing time
  has passed (host's clock).
- **`answer`**: content `{answer: "going" | "maybe" | "no"}`. `version` must be the event's current version. Refused
  once the event (or that date) is called off or over. A repeating event's answers must carry `date`, and only to one
  of its dates; a one-off event's must not.
- **`end`**: a poll's owner ends voting; comments carry on. Only once.
- **`close`**: closes a list. After it, an item's list takes only `remove` and `delete`; a members list takes nothing more, and the
  group is closed (section 10).
- **`remove`**: takes away someone else's record, as `delete` does for one's own (6.7). In a group, an admin's
  `remove` carries `role_at`, and an admin can't remove what the group's owner wrote. `about` the item itself removes
  the whole item. On a members list, `about` is a member's `join`; that join is not emptied (section 10).
- **`calloff`**: in a group, calls off an event (`about` = the event, on the event's own list) or one date of a
  repeating event (with `date`, on that date's list). Carries `role_at` when signed by an admin. Refused everywhere
  outside groups.
- **`join`**, **`approve`**, **`role`**, **`leave`**: only on a group's members list, never on an item's. `join`
  content `{name}`; `role` content `{role: "admin" | "member"}`, `about` a member's `join`. See section 10.

Source: `public/static/records.js` `KINDS`; `src/lists.js` `Rules.refuse`, `GroupRules.actTrouble`; `src/members.js`;
`src/items.js` `recordOn`, `kindPlan`, `wrongMentions`; `src/groupposts.js` `memberRecord`; `src/itemkinds.js`.

### 5.6 Order: `seen` and `prev`

Two fields tie each record to its place, and both host and readers check them for every record except `item`
(`prev` isn't checked for records by host):

- **`seen`** must name a real earlier point of this list: `seen.n` less than the new entry's number, and the running
  head at `seen.n` equal to `seen.h`. `seen` may be `null` only when the record will be entry 1 (the first `join` on a
  members list, or the first `answer` or `calloff` on a date's list). Any earlier point is accepted, not only the
  latest. Refusal: "That says it saw something this list never was."
- **`prev`** must be the fingerprint of the writer's own newest record on this list, or `null` if they have none
  there. One exception: `prev` may name an entry whose record is gone (deleted, removed or failing its check), if that
  entry comes after the writer's newest record the list can still attribute to them. That is how a writer carries on
  after their newest record was emptied. Refusal: "That's out of order."

`prev` also proves ownership. Each writer's chain is the set of their records here plus every `prev` they named. An
`edit` or `delete` is allowed when its `about` is in that chain (this record's `prev` included) or is a record the list
still shows as theirs. So a reader can tell that a delete was its writer's even after the record it deleted is gone.

Source: `src/lists.js` `Rules.order`, `Rules.refuse`, `Rules.add`.

### 5.7 What a host checks before taking a record

A writer's site sends its owner's record to the host in a signed call (section 8 for friends, 10 for groups) with body
`{sent, delegation, profile?}`. The host, in this order:

1. Parses the record; refuses it if it isn't one, or if `author` isn't the calling site's own person (403 "That isn't
   your site's to send.").
2. Checks access: the caller may see the item (404 otherwise); the caller isn't blocked; for a group, the caller is a
   member and the kind is one a member may send on a post.
3. Applies the daily cap (6.8; 429).
4. Checks the delegation against the author's identity now. It keeps it, to pass on to readers, only once the record
   is taken (step 7): a delegation shows that a passkey vouched for a key, not that the sender holds it.
5. Checks content rules for the kind: comment and edit lengths, mentions, poll and event rules (`kindPlan`: version,
   guest, closing time, called off, over).
6. Runs `checkRecord` (5.3) at the host's time now; refuses with "That didn't check." if it fails, or if `host` isn't
   this site ("That belongs somewhere else."). A `comment` on an item whose comments are turned off is refused
   ("Comments are turned off on this post.") unless its author wrote the item. Turning comments off is the host's own
   choice, as refusing any record is: nothing is signed for it, and readers don't check it (6.9 says how they hear).
7. Takes the record in turn with others for the same list: applies the list's rules (`Rules.refuse`, 6.10 lists them)
   to the list as it stands, then appends the entry and signs a receipt (6.5).

A refusal by the list's rules is HTTP 409 with `{error: "<reason>"}`, mostly in the rule's own words; two are
reworded on the wire: "That's out of order." becomes "Something changed meanwhile. Try again.", and "Someone has
replied since." becomes "Someone has replied since, so it can't be changed now." Earlier checks answer with their
own status (sections 8.10 and 10.9 list them). One reason is read by
machines: `"duplicate"` (the same record, already in the list). A writer's site treats a 409 `duplicate` as success:
its record is there.

Success is `{ok: true, receipt, n}`: `n` the entry's number and `receipt` the signed head (6.5). When the record
deleted or removed the whole item, no receipt is given: a person's site answers `{ok: true, receipt: null, n: null}`,
a group's `{ok: true, deleted: true, n}`.

Source: `src/friendhost.js` (`POST /_p/records`); `src/groupposts.js` `memberRecord`; `src/groupmembers.js`
`takeMemberRecord`, `theirs`; `src/hosted.js` `takeRecord`; `src/sentchecks.js` `keepSent`.

### 5.8 What a reader checks

A reader is shown a record only inside a list (6.9) or a note carrying one entry (section 9). For each record it runs
`checkRecord` at the entry's taken time, then the same list rules the host used (6.10). A record that fails
`checkRecord` because its writer can't be judged there (unknown, frozen or closed) is hidden and counted as "failed",
not trusted. Any other failure, or a record that checks but breaks a list rule, means the host took or passed on
something no honest host would: the reader stops there and says so.

Source: `src/lists.js` `checkList`.

## 6. Lists

A list is a host's numbered, append-only log of the records on one item. The host gives every entry a number and a
running head that covers everything before it, and signs the head. Hosts and readers apply the same rules, entry by
entry, so a host can't take anything a reader would refuse, and a reader can tell when it is shown something no honest
host would have taken.

### 6.1 Lists and their ids

| List | Id | Owner | First entry | Rules |
|---|---|---|---|---|
| An item's | the item's fingerprint | the item's writer | the `item` record | `Rules`; in a group, `GroupRules` |
| One date of a repeating event | `"<item>/<YYYY-MM-DD>"` | the event's writer | the first `answer` or `calloff` for that date | as the event's, holding only `answer` and `calloff` |
| A group's members list | the group's person id | the group's owner | the first `join` | `MemberRules` (section 10) |

A date's list starts when its first record is taken; until then, reading it gives `{v: 2, empty: true}`. A members
list exists, empty, from the group's creation.

Source: `src/lists.js` `dateList`, `listOf`, `parseListId`; `src/hosted.js` `rulesKind`; `src/groupidentity.js`.

### 6.2 Entries

On the wire, a list is an array of entries:

| Field | Type | Meaning |
|---|---|---|
| `n` | integer | Its number, from 1, with no gaps. |
| `fp` | id | Its record's fingerprint. |
| `taken` | integer | When the host took it, Unix seconds on the host's clock. What pages show, and what the edit window goes by. |
| `head` | id | The running head up to and including this entry (6.3). |
| `sent` | object | The record as sent (5.1). Absent once the record has been deleted or removed: only `fp` stays, so the list still checks. |

Hosts may include their own bookkeeping fields: `by_host: 1` on an entry signed with the hosting key, and `by` (the
fingerprint) and `by_n` (the number) of the delete or remove that emptied an entry. Readers ignore them and work these
things out for themselves.

Source: `src/lists.js` (header comment), `src/hosted.js` `take`.

### 6.3 The running head

```
head(0) = ""   (the empty string)
head(n) = fingerprintOf("head", UTF-8 of host + "\n" + list + "\n" + head(n-1) + "\n" + n + "\n" + fp + "\n" + taken)
```

So `head(n)` is base64url (no padding) of SHA-256 of these bytes:

```
afterwrd head 2\n<host>\n<list>\n<head(n-1)>\n<n>\n<fp>\n<taken>
```

`host` is the host's person id, `list` the list id (6.1), `n` and `taken` decimal integers with no padding, and `fp`
the entry's record fingerprint. For entry 1 the third line is empty. Neither the record's bytes nor its content are in
the head, only `fp`, so emptying an entry doesn't change any head.

Source: `src/lists.js` `headOf`.

### 6.4 Signed heads

A **signed head** is the host's statement that a list stood at `head` when it had `n` entries. Its bytes are the UTF-8
JSON

```json
{"v":2,"kind":"head","host":"<host's person id>","list":"<list id>","n":3,"head":"<head(n)>"}
```

(fields in that order as afterwrd writes them, though checkers decode rather than compare text), signed with the host's
hosting key as kind `head`: the signature covers `"afterwrd head 2\n"` followed by the bytes. On the wire:

```json
{ "bytes": "<base64url of the JSON above>", "sig": "<signature: 64 bytes, base64url>" }
```

A signed head checks (`checkHead`) when its bytes decode to an object with `v` 2, `kind` "head", the expected `host`
and `list`, an integer `n` ≥ 1 and a 43-character `head`, and `sig` is the hosting key's signature. Readers check it
with the host's current hosting key.

The same object serves three purposes: the `signedHead` sent with every list read (the host's word on where the list
ends now), a **receipt** (6.5), and a **checkpoint** (6.6).

Source: `src/lists.js` `signHead`, `checkHead`.

### 6.5 Receipts

When a host takes a record, it answers with a receipt: the signed head at the new entry, `{bytes, sig}`, with that
entry's `n` and `head`. The writer's site keeps it beside its own copy of the record. Since the head at `n` covers the
record's fingerprint and everything before it, the receipt is the host's signed promise that this record is entry `n`
of this list, after exactly those entries.

A receipt is used to catch a host that shows different people different lists:

- **Mention receipts.** A writer's site sends the receipt for a comment, with the comment, to each person it mentions
  (`POST /_p/mention`, section 9). Their site checks the receipt with the host's hosting key for list = the item, then
  reads the list from the host itself. If entry `n` there doesn't have the same `fp` and `head`, the host is hiding
  what it told the writer it took, and the owner is told.
- **The writer's own checks.** When the writer's site reads a list it has written to (6.11), any record of its own
  whose receipt number is at or after the first entry shown, taken before the read was asked for, but missing from what
  the host shows, is "missing". The site also asks each host in the background what became of each record it sent
  (`POST /_p/records/check`, section 8), and the host must show a signed delete or removal for any record it says has
  gone (6.7).
- **Leaving a group while waiting.** Someone still waiting to be let into a group can't read its members list; their
  `leave` uses their join's receipt as its `seen` and the join's fingerprint as its `prev`.

Source: `src/hosted.js` `take`; `src/receipts.js`; `src/sentchecks.js` `compareThread`, `answerCheck`;
`src/groupjoin.js` `waitingPoint`.

### 6.6 Checkpoints

Every time a list reaches a multiple of 500 entries (`CHECKPOINT`), the host keeps that entry's signed head as a
checkpoint. A reader asking for a list from the start (`after` 0) whose list has more than 500 entries is given the
newest checkpoint, as `checkpoint`, and only the entries after it. The reader checks the checkpoint with `checkHead`
and checks the entries from that point (6.10). Earlier entries are never sent.

Records after a checkpoint can name things before it (`seen`, `role_at`, `prev`, `about`), which the reader can't see.
A reader started from checkpoint `c` lets these through as long as they point before `c`; a point at or after `c` must
still match.

A group's members list is always sent whole, from entry 1, never from a checkpoint: who is in follows from every join
and approval since the start.

Source: `src/hosted.js` `readList`, `take`; `src/lists.js` `CHECKPOINT`, `Rules.refuse` (`checkpointed`),
`Rules.startAt`.

### 6.7 Deleted and removed records

When a `delete` or `remove` is taken about a record on the same list, the host empties the target's entry: `sent`
goes, and the entry keeps `n`, `fp`, `taken` and `head`. From then on the host never sends that record or its content
to anyone. The `delete` or `remove` itself stays in the list as an ordinary entry and serves as the marker that says
what happened.

On a group's members list, removing someone is about their `join`, which is not emptied: without it nobody could
check who was let in or removed.

A reader sorts every empty entry as follows (`checkList`):

| State | When |
|---|---|
| `deleted` | A `delete` in the entries shown has `about` equal to its fingerprint. |
| `removed` | A `remove` in the entries shown has `about` equal to its fingerprint (`removedBy` is that remover). |
| `left-out` | Nothing in the entries shown says why it is empty. |

A host sends everything from where a reader starts to the list's end, and a marker always comes after its target, so
an honest host's empty entry always has its marker in what's read. A `left-out` entry is the host leaving something
out (a `delete` or `remove` left out brings its target's words back), so the list is **unexpected**, unless an entry
shown as `failed` (its writer can't be judged here) says it is the `delete` or `remove` of it: then the words are gone
either way. A `failed` entry that says it deletes or removes an entry still shown with its words makes the list
**unexpected** too: the host left out who its writer is, so the act wouldn't count.

When a writer's site asks what became of its records (`POST /_p/records/check`, section 8), the host answers `deleted`
or `removed` with `marker: {sent, taken}`, the signed record that emptied it and when it was taken. The writer's site
accepts the marker only if it passes `checkRecord` at `taken`, is on the same host, has `about` equal to the record
asked about, and either is a `delete` by the writer themselves or a `remove` by someone who may remove there: on a
friend's item, the friend (the host); in a group, its owner or an admin proved by the owner's signed `role`. Anything
else counts as "missing".

When the record deleted or removed is the item itself, the whole list goes: every entry and checkpoint is dropped and
the list is marked deleted for good, so the same id can't be used again. Reading it then gives 404 `{error: "Not
found."}` on a person's site (the item, and so the caller's right to see it, has gone), and 410 `{error: "Deleted.",
deleted: true}` on a group's.

Source: `src/hosted.js` `take`, `readList`, `tombstone`; `src/lists.js` `checkList`; `src/sentchecks.js`
`answerCheck`, `checkMarker`, `removersAt`.

### 6.8 Caps

| Cap | Value | Applies to | Refusal |
|---|---|---|---|
| Entries in an item's or date's list | 2,000 (`MAX_ENTRIES`); 2,010 for a `close`, or a `delete` or `remove` of the item itself | every record | "This is as long as a list gets." |
| Entries in a members list | 20,000 (`MAX_MEMBER_ENTRIES`); 22,000 for `leave`, `remove` and `close` | every record | "This group's list is as long as it gets." |
| Records by one writer on an item's or date's list | 20 (`PER_AUTHOR`) | all but `delete`, the owner's `change`, records by host, and, in groups, `remove` and `calloff` | "That's as many as anyone can add here." |
| Records by one writer on one host a day | 200 (`LIMITS.records`) over the last 24 hours | all but `delete`, `leave`, `remove`, `calloff`; not the members list; not the owner's own records on their own site | 429 "That's a lot for one day here. Try again tomorrow." |

A writer's `delete`s count towards their 20 but are never refused by it. Readers check the 20-per-writer cap and the
list caps; the daily cap is the host's alone. A local test site may set smaller daily limits.

Source: `src/lists.js` `MAX_ENTRIES`, `MAX_ENDINGS`, `PER_AUTHOR`, `Rules.refuse`; `src/members.js` `MAX_MEMBER_ENTRIES`;
`src/hosted.js` `overDailyRecords`; `src/limits.js` `LIMITS`.

### 6.9 Reading a list

Lists are read in signed calls (section 2):

| Call | List |
|---|---|
| `GET /_p/items/<item>[?after=<n>]` | An item's list on a person's site or a group's |
| `GET /_p/items/<item>/dates/<YYYY-MM-DD>[?after=<n>]` | One date's list (groups) |
| `GET /_group/members/list[?after=<n>]` | A group's members list, wrapped as `{"afterwrd:list": …}` |

`after` (default 0; anything that isn't a non-negative number counts as 0) asks only for entries numbered above it:
a reader that has checked and kept a list up to `n` asks for what's after. There is no page size. The host sends every
entry after `after` (or after the newest checkpoint, 6.6) up to the end, and the list caps (6.8) bound the size.

The answer to an item's list:

```json
{
  "v": 2,
  "owner": "<the item's writer>",
  "entries": [ { "n": 1, "fp": "…", "taken": 1795000000, "head": "…", "sent": { "record": "…", "sig": "…", "content": "…", "salt": "…" } } ],
  "signedHead": { "bytes": "…", "sig": "…" },
  "checkpoint": null,
  "delegations": { "<browser key>": { "bytes": "…", "proof": { } } },
  "people": { "<person id>": { "chain": [ ], "profile": { } } }
}
```

`signedHead` is signed fresh at each read for the list's end now. `commentsOff: true` is there when the host has turned
comments off on the item (5.7): a reader shows that rather than a comment box, except to the item's writer. It's the
host's word about what it will take, not part of the list, so it's never checked; a reader that doesn't know it shows
the box, and the host's refusal says why. A group's site adds `roles`: for each admin who
signed a `remove` or `calloff` in the list, `{join, role}`, their `join` and the owner's `role` record making them
admin, each as a `sent` object. The members list's answer has `group` (the group's person id) in place of `v`, and no
`roles`.

| Status | When |
|---|---|
| 404 `{error: "Not found."}` | No such list here, or the caller may not see it; on a person's site, also an item deleted or removed whole. |
| 410 `{error: "Deleted.", deleted: true}` | On a group's site, an item deleted or removed whole. |
| 200 `{v: 2, empty: true}` | A date's list that hasn't started, of an event that exists. |

An empty members list (a group with nobody but its owner) has no entries and a signed head with `n` 0, which
`checkHead` would refuse; readers accept an empty members list when its `owner` is the group identity's owner, without
checking a head.

Source: `src/hosted.js` `readList`; `src/friendhost.js`; `src/groupposts.js` `handleGroupItems`, `roleProofs`;
`src/groupmembers.js` `signedMembers`; `src/groups.js`; `src/groupjoin.js` `checkMembers`.

### 6.10 How a reader checks a list

`checkList` takes the host, its current hosting key, the list id, the owner, the entries, the signed head, a starting
point `from` (a checked checkpoint, or the last point this reader checked, or none) and the lookups for identities and
delegations. Starting at `from` (or at 0 with head ""), for each entry in order:

1. The entry must be number `previous + 1`, with a 43-character `fp` and an integer `taken`. Otherwise **broken**.
2. If it has `sent`, `fingerprintOf("record", record bytes)` must equal `fp`. Otherwise **broken**: the host put in a
   different record.
3. If `sent` passes `checkRecord` (5.3) at time `taken`, the list rules must accept it as the next entry (below).
   If they refuse, **unexpected**: an entry no honest host would have taken. If `sent` doesn't pass `checkRecord`
   because its writer can't be judged here (unknown, frozen or closed), the entry is shown as `failed` (hidden) and
   counted as an entry whose record is gone. Any other failure (a signature that doesn't check, words missing or
   changed, no delegation for its key: an honest host keeps every delegation it took a record with) is **unexpected**.
4. The reader computes the running head (6.3); it must equal the entry's `head`. Otherwise **broken**.

At the end, `signedHead` must pass `checkHead` for this host and list, and its `n` and `head` must equal the last entry
checked (or `from`, if there were no new entries). Otherwise **broken**. Then empty entries are sorted (6.7).

The result is every entry up to the first problem, each with a state (`ok`, `deleted`, `removed`, `left-out`,
`failed`), and the `problem`, if any. Nothing after a problem in the entries is shown; a signed head that doesn't
match leaves the entries but marks the list **broken**.

The list rules (`Rules.refuse`, shared by host and reader), in order:

- not past the list cap; not a fingerprint already in the list ("duplicate"); `host` is this host;
- an `item` only as entry 1, only with the list's own id, and only by the list's owner (so a reader taking `owner`
  from the host the first time finds out if it's wrong); every other record on the list `listOf` names;
- `join`, `approve`, `leave` and `role` only on a members list;
- on a date's list, only `answer` and `calloff`, and nothing after a `calloff`;
- after a `close`, only `remove` and `delete`;
- the per-writer cap (6.8);
- `seen` and `prev` (5.6);
- `about` must name an entry in the list (unless before a checkpoint); `edit` and `delete` only of the writer's own;
  `edit` within 900 seconds of the target and before anyone else's later entry;
- `remove` and `calloff` by those 5.5 allows (`actTrouble`); in a group an admin must hold the role at `role_at`;
- `close` by the owner, the host or a record by host; `change` by the owner; `end` by the owner, once; `vote` not
  after `end`.

The group's own site judges an admin by its members list as it stands: the admin must be an admin now, `role_at` must
be a real point in the members list, and their role mustn't have changed after it. A reader of a group's post judges an
admin by the `roles` the group sent: a `join` by that person on this group, and a `role` with content `{role:
"admin"}` signed by the group's owner about that join.

> Note: if a writer's identity is later frozen, their records stop passing `checkRecord` and show as `failed` to
> readers who read the list again.

Source: `src/lists.js` `checkList`, `Rules`, `GroupRules`; `src/groupposts.js` `groupRules`; `src/groupcopies.js`
`checkRoles`.

### 6.11 Reading again, and noticing a fork

A reader keeps what it checked (`checked_n`, `checked_head`, and the entries as checked) and next time asks for
`?after=checked_n`, checking the new entries from `{n: checked_n, head: checked_head}`. A delete or removal among the
new entries empties what it names in the kept copy too.

If the new entries don't follow on (any problem), the reader reads the whole list again from the start (or from a
checkpoint). If the whole list no longer has, at `checked_n`, the head this reader checked before, the host has shown
two different histories: a fork. The reader says the conversation has changed and doesn't move its kept point. A host
can only rewrite the newest entries unseen; changing any entry someone has already checked shows up as a fork to them.

With a list read and checked, the writer's site compares it with what it sent:

| Found | Means |
|---|---|
| Its record `removed` | Told to the owner, with who removed it. |
| Its record `left-out` | "missing": told to the owner. |
| A record taken before the read (by its receipt) and at or after the first entry shown, not in the list | "missing". |
| A record that checks, by the owner, that their site never sent | "forged": said on Home (a stolen key used elsewhere). |

Source: `src/friendcopies.js` `friendThread`; `src/groupcopies.js` `groupThread`; `src/threads.js`;
`src/sentchecks.js` `compareThread`.

### 6.12 Worked example

Made by running the repo's own `makeRecord`, `Rules`, `headOf`, `signHead` and `checkHead` in Node 22. The person ids
are fingerprints of placeholder bytes, not real identity documents, and the identity and delegation step of
`checkRecord` is left out. Everything else is real output.

Ann (`hjBXN2oiIvHHsam5omk3OaPa-ZV3MXrG7X4OAbv-cTo`) posts; her friend Sam (`FtoJSt0aASpXOzL_wDQw0AU-Vn16FQQMnZ9eN_gz_aE`)
comments, then deletes his comment. Ann's site is the host.

**Entry 1, the post.** Record bytes:

```json
{"v":2,"kind":"item","author":"hjBXN2oiIvHHsam5omk3OaPa-ZV3MXrG7X4OAbv-cTo","host":"hjBXN2oiIvHHsam5omk3OaPa-ZV3MXrG7X4OAbv-cTo","key":"HnETtapW8w4Gr5RtWkqdyyxXoMKmOn3vRhWsRZRzAJI","body":"kb_b6N0hbbeH1Buin7HIKVUvbSO-JoenH6GGfSocLA4","at":1795000000}
```

Content `{"type":"post","text":"Bonfire at ours on Saturday?"}` with salt `q0kUGDT5EVu7es4ZRZN5_w`. SHA-256 of salt then
content is the `body` above. Its fingerprint, and so the list's id, is `QdFq43mt0VG9vOVhetmGoyrFAiArxy_6FVBppjG_Io8`.
Taken at 1795000000, its head is `fingerprintOf("head", …)` of:

```
hjBXN2oiIvHHsam5omk3OaPa-ZV3MXrG7X4OAbv-cTo
QdFq43mt0VG9vOVhetmGoyrFAiArxy_6FVBppjG_Io8

1
QdFq43mt0VG9vOVhetmGoyrFAiArxy_6FVBppjG_Io8
1795000000
```

giving `33GfKKOxovOSoQ-W5lec-umM2n8j1Y5ghHvQ2s9Lohc`.

**Entry 2, Sam's comment**, having seen entry 1, with no earlier record of his here:

```json
{"v":2,"kind":"comment","author":"FtoJSt0aASpXOzL_wDQw0AU-Vn16FQQMnZ9eN_gz_aE","host":"hjBXN2oiIvHHsam5omk3OaPa-ZV3MXrG7X4OAbv-cTo","item":"QdFq43mt0VG9vOVhetmGoyrFAiArxy_6FVBppjG_Io8","seen":{"n":1,"h":"33GfKKOxovOSoQ-W5lec-umM2n8j1Y5ghHvQ2s9Lohc"},"prev":null,"key":"A80-niximDBu1Z2sUsphFTxzIwlAx68bEMvYiOOL1VQ","body":"gqzf2RDKtHnI1s9DWN5kYTOvkmVzJPYoCWy5-vVT0DA","at":1795000120}
```

Fingerprint `ZEMhejWHiFiUS472tXj3ExWI-9rcn09tsVr0NZ7HIsg`, taken at 1795000121, head
`FwL78fhwwuebcssdT470Azrzt4rvb_Nmyw5fJqNwK3c`.

**Entry 3, Sam's delete**, with `prev` and `about` both naming his comment:

```json
{"v":2,"kind":"delete","author":"FtoJSt0aASpXOzL_wDQw0AU-Vn16FQQMnZ9eN_gz_aE","host":"hjBXN2oiIvHHsam5omk3OaPa-ZV3MXrG7X4OAbv-cTo","item":"QdFq43mt0VG9vOVhetmGoyrFAiArxy_6FVBppjG_Io8","seen":{"n":2,"h":"FwL78fhwwuebcssdT470Azrzt4rvb_Nmyw5fJqNwK3c"},"prev":"ZEMhejWHiFiUS472tXj3ExWI-9rcn09tsVr0NZ7HIsg","about":"ZEMhejWHiFiUS472tXj3ExWI-9rcn09tsVr0NZ7HIsg","key":"A80-niximDBu1Z2sUsphFTxzIwlAx68bEMvYiOOL1VQ","at":1795000420}
```

Fingerprint `jpsV7YBF6bMDEtKHYSDG8H4UqPSQ5vfF8zDq-uH8_6Y`, taken at 1795000421, head
`tfMKDsdEw-orNtsI0JMhwNaV424ggrD2BdF_svtqh9I`. The receipt Sam's site gets, and the `signedHead` any reader now gets,
signs:

```json
{"v":2,"kind":"head","host":"hjBXN2oiIvHHsam5omk3OaPa-ZV3MXrG7X4OAbv-cTo","list":"QdFq43mt0VG9vOVhetmGoyrFAiArxy_6FVBppjG_Io8","n":3,"head":"tfMKDsdEw-orNtsI0JMhwNaV424ggrD2BdF_svtqh9I"}
```

with signature `F0O3efuXzL9cIJY1rCt8Zt0fXFg5RABx_ABYO_WjEQnQyDg4FGpkwOWZBgA_R5xea2ZkzXm2boFwLPYKd_8fAQ` by Ann's
example hosting key `e-xlJ0DQt_m7oXoZrvdqNrrE75Wg_tOX_WEWWUDPfr0`.

The list as a reader is then sent it (records shortened):

```json
[
  { "n": 1, "fp": "QdFq43mt0VG9vOVhetmGoyrFAiArxy_6FVBppjG_Io8", "taken": 1795000000,
    "head": "33GfKKOxovOSoQ-W5lec-umM2n8j1Y5ghHvQ2s9Lohc", "sent": { "record": "eyJ2IjoyLCJraW5kIjoiaXRl…", "sig": "…", "content": "…", "salt": "q0kUGDT5EVu7es4ZRZN5_w" } },
  { "n": 2, "fp": "ZEMhejWHiFiUS472tXj3ExWI-9rcn09tsVr0NZ7HIsg", "taken": 1795000121,
    "head": "FwL78fhwwuebcssdT470Azrzt4rvb_Nmyw5fJqNwK3c", "by": "jpsV7YBF6bMDEtKHYSDG8H4UqPSQ5vfF8zDq-uH8_6Y", "by_n": 3 },
  { "n": 3, "fp": "jpsV7YBF6bMDEtKHYSDG8H4UqPSQ5vfF8zDq-uH8_6Y", "taken": 1795000421,
    "head": "tfMKDsdEw-orNtsI0JMhwNaV424ggrD2BdF_svtqh9I", "sent": { "record": "eyJ2IjoyLCJraW5kIjoiZGVs…", "sig": "…" } }
]
```

The reader recomputes all three heads from `fp` and `taken` alone and gets the signed `head`. Entry 2 has no `sent`,
and entry 3 is a `delete` about it, so it shows as `deleted`. Its rules accept entry 3 because `prev` names entry 2,
which puts the comment in Sam's chain even though the reader never sees the comment. A further record from Sam with
`prev: null` would be refused, "That's out of order.", since his newest record here is the delete.

Source: made by running `public/static/records.js`, `public/static/signed.js` and
`src/lists.js`.

## 7. Items

An item is one thing someone posts: a post, a photo in a post, or an event. Every item is a signed `item` record
(section 5) and the list of records that follows it (section 6). This section covers what an item's content may hold,
what a host checks before it takes one, who may see it, and the object a host sends a friend's site for each item.

### 7.1 What an item is

- **Its first record.** An item starts with a record of kind `item`. That record has no `item` field, and its `seen` and
  `prev` aren't used (section 5). Its content (the JSON sent beside it, bound by `body`) says what kind of item it is, in `type`:
  `"post"`, `"photo"` or `"event"`.
- **Its id.** The item's id is the fingerprint of its first record: `fingerprintOf("record", bytes)`, which is
  base64url(SHA-256(`"afterwrd record 2\n"` ‖ bytes)), 43 characters. Sending the same bytes twice gives the same id,
  and the host refuses the second one as `duplicate`.
- **Its host.** The first record's `host` field names the site that holds the item's list, by its person id. On a
  person's site, the host is the owner and the `author` must be the owner too: a person's site only hosts items its
  owner made. On a group's site, the host is the group's identity and the author is a member (section 10).
- **Its list.** The item's list has the same id as the item. The first record is entry 1. Everything that happens to
  the item afterwards (comments, edits, votes, answers, changes, deletes) is a later entry on that list. A repeating
  event also has one more list for each of its dates (7.6).
- **When it was written.** Pages show the host's "taken at" time for entry 1, not the record's `at`.

The browser signs every item. The site never makes an item record for its owner.

Source: `public/static/records.js` `makeRecord`, `parseRecord`, `writtenAt`; `src/lists.js` `Rules.refuse`, `listOf`;
`src/items.js` `checkNewPost`; `src/hosted.js` `takeRecord`.

### 7.2 Posts

A post is an item whose content has `type: "post"`. It may hold words, up to 20 photos, a poll, and mentions.

| Field | Type | Required | Rule |
|---|---|---|---|
| `type` | `"post"` | yes | |
| `text` | string | no (absent means `""`) | Up to 5,000 characters (`MAX_POST_TEXT`), counted as JavaScript string length (UTF-16 code units). It must already be trimmed and use `\n` line endings: the host refuses text that changes when `\r\n` and `\r` become `\n` and it is trimmed. |
| `photos` | array | no (absent = none) | Each entry is `{item, hash, thumb_hash, width, height, size}` (7.3). Up to 20 on a person's site, 8 in a group. |
| `poll` | object | no | 7.4. If there is a poll, `text` is its question and must not be empty. |
| `mentions` | array | no | `[{name, person}]`, at most 10. Each `person` must also be in the record's signed `mentions`, and `@name` must appear in `text` as a whole name (`says`). Mentions are covered in section 9. |
| `here` | `true` | no | Groups only: the post is for everyone in the group (section 10). |

What the host checks before taking a new post (`checkNewPost`):

- The first record is of kind `item`, authored by the owner, and its content `type` is `"post"` or `"event"`.
- A post has no `audience` field (7.7).
- A post has at least one of: words, photos, a poll.
- The number of photos listed equals the number of photo records sent with it, and each one matches (7.3).
- Mentions are as above, and only name approved friends with an identity (not limited to an event's guests).
- Any poll passes `pollTrouble` (7.4).

Two size limits also apply to every record (section 5): the record itself is at most 4,096 bytes, and its content at
most 16 KiB.

> Note: the host does not refuse unknown keys in a post's content. It stores and passes them on.

Source: `src/items.js` `checkNewPost`, `wrongMentions`; `src/edits.js` `MAX_POST_TEXT`;
`public/static/records.js` `MAX_RECORD`, `MAX_CONTENT`, `pickedMentions`; `src/groupposts.js` `postTrouble`.

### 7.3 Photos

**Each photo is an item of its own.** That is how a photo gets its own page and comments. The browser signs one `item`
record per photo first, then signs the post, whose `photos` array lists them in order. The host takes the photo items
first, then the post. If the post is refused, the host deletes (tombstones) the photo items it has just taken.

A photo item's content:

```json
{"type":"photo","hash":"9f2c1e0b5a7d4c3e8f6a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6",
 "thumb_hash":"0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5",
 "width":2560,"height":1920,"size":812345}
```

| Field | Rule |
|---|---|
| `hash` | SHA-256 of the full-size file's bytes, as 64 lowercase hex characters (`HASH_RE`). This is not base64url, unlike fingerprints. |
| `thumb_hash` | The same, for the thumbnail file. |
| `width`, `height` | Integers from 1 to 20,000. |
| `size` | A positive integer: the full file's size in bytes. In a group, at most 8,000,000. |

Each entry in the post's `photos` array is the photo's content without `type`, plus `item`, the photo item's id. The
host checks that `item` is the fingerprint of the photo record sent with the post, at the same position, and that
`hash`, `thumb_hash`, `width`, `height` and `size` are equal to that record's content. The order of keys does not
matter.

**The files.** Before the post is sent, the browser uploads both files to its own site by their SHA-256. The site's
file store recomputes each file's hash as it arrives and throws away any file whose bytes don't match its name. Files
may be up to 95 MiB. On a person's site, the host refuses a post unless both files of every photo are already in its
store (`checkPhotos`); a group's site copies them from the member's site instead (10.10). The browser's uploader makes JPEGs: the full size fits within 2560×2560, and the thumbnail within
900×600. Signed items only ever carry photos. Videos appear only in the shared archive (section 8).

**Fetching a photo.** A friend's site is never sent the files themselves. For each photo, the item object it is sent
(7.9) carries `src` and `thumbSrc`: links signed for that one friend, of the form
`<host origin>/files/<hash>?exp=<seconds>&sig=<43 characters>`. The friend's browser loads these straight from the
host, without a signed call. A reader keeps a link only if it is exactly of that form, on the host's own address and
for that photo's hash. A link lasts until the end of the next UTC day, and stops working as soon as the friend is
no longer a friend. The host serves the file from its store under its hash, with byte ranges and the ETag
`"<hash>"`. An expired or wrong link gets 403. Section 8 describes the link's signature.

**Deleting one photo.** The owner signs two records. The first is a `delete` on the photo's own list, about the photo
item. The second is a `change` on the post whose content is `{"photos": [...]}`, listing the photos left in their
order. The host checks that this list is exactly the post's current photo item ids with that one taken out. It refuses
if that would leave a post with no photos and no words. A group's site refuses to delete a single photo: the whole
post has to go.

**Seeing a photo.** A friend may see a photo item, and read its list, exactly when they may see the post it is in.

Source: `src/items.js` `checkNewPost`, `takePost`, `removePhoto`; `src/posts.js` `checkPhotos`; `src/media.js`
`MediaStore.receive`, `serve`; `src/share.js` `signedFile`, `signedFor`; `src/friendhost.js` `itemForFriend`,
`mayCallerSee`; `src/friendcopies.js` `keepCopy`, `signedNow`; `public/static/compose.js`; `public/static/upload.js`.

### 7.4 Polls

A poll is a post whose content has `poll`. The post's `text` is the question.

```json
"poll": {"options": ["Saturday", "Sunday"], "multiple": 0, "closes_at": 1796169599}
```

The host accepts the poll only if it is exactly what `readPoll` would produce from it (`pollTrouble`):

| Field | Rule |
|---|---|
| `options` | 2 to 10 strings. Each is already tidied: runs of whitespace replaced by one space, trimmed, not empty. Each is at most 100 characters. No two are the same once lower-cased. |
| `multiple` | The number `0` (one choice) or `1` (several). `true` and `false` are refused. |
| `closes_at` | Must be present. Either `null` (stays open until ended) or an integer number of seconds that is later than the host's time now and at most 366 days after it. |

Readers keep a friend's poll only if it passes the same check at the time the post was written.

> Note: the comparison covers only `options`, `multiple` and `closes_at`. Any other keys in `poll` are accepted and
> passed on.

**Votes.** A vote is a `vote` record on the post's list, with `version` set to the item's id (nothing changes a poll's
version) and content `{"choices": [i, …]}`. The choices are option numbers counting from 0, at most 10 of them, and
repeats are allowed. A poll with `multiple: 0` takes at most one distinct choice. An empty list takes the person's vote
back.

> Note: `choicesMask` also accepts choices written as strings of one or two digits, such as `"1"`.

The host refuses a vote in these cases:

- the post has no poll;
- the poll has ended or is past `closes_at`;
- `version` isn't the item's id;
- the choices aren't fair.

Anyone who may see the post may vote: any friend on a person's site, any member in a group.

**Ending.** The post's author may send one `end` record, which has no content. After it, no more votes are taken, but
comments carry on. Only the item's owner may end a poll, and only once (`Rules.refuse`). The host also refuses an `end`
once the poll is past `closes_at` ("That poll has closed.").

**Counting.** The count is worked out from the list, never kept separately (`workOut`). Going through the entries in
order, a vote counts if all of these hold:

- its record is still there;
- its `version` is the item's id;
- no `end` came before it;
- `closes_at` is null or later than the vote's taken time;
- its choices are fair.

Each person's newest counting vote replaces their earlier one, and a vote with no choices removes it. The result is
`{"votes": {<person id>: <bitmask>}, "ended_at": <taken time of the end, or null>}`, where bit *i* means option *i*.

Polls are public: everyone who can see a poll can see who chose what. A friend's site counts the poll again from the
checked list when the post is opened, provided it read the list from entry 1 rather than from a checkpoint. If its
count differs from the host's tally, the page says so.

Source: `src/polls.js` `readPoll`, `choicesMask`; `src/itemkinds.js` `pollTrouble`, `workOut`, `pollShown`;
`src/items.js` `kindPlan`; `src/archive/routes.js` `friendItemPost`.

### 7.5 Events

An event is an item whose content has `type: "event"`:

```json
{"type":"event","text":"Bring a coat.",
 "event":{"title":"Walk up Kinder Scout","starts_at":1796464800,"ends_at":1796486400,"all_day":0,
          "time_zone":"Europe/London","place":"Edale car park"}}
```

On a person's site, an event is for the friends invited to it: its first record must carry an `audience` (7.7). An
event has no photos and no poll. In a group, an event is for every member, carries no `audience`, and may repeat (7.6).

The `event` object is accepted only if it is exactly what the site would have made from its own form (`cleanEvent`):

| Field | Type | Rule |
|---|---|---|
| `title` | string | Not empty. Runs of whitespace replaced by one space, trimmed, at most 200 characters. |
| `starts_at` | integer | Seconds, from 2000-01-01 to 2100-01-01 UTC. For an all-day event, the form sets this to the start of the day in `time_zone`, but the host doesn't insist on it. |
| `ends_at` | integer or null | May be absent, which means null. For a timed event it must be later than `starts_at`; for an all-day event, no earlier than it. The event may last at most 31 days. For an all-day event, it is the start of the last day. |
| `all_day` | `0` or `1` | Numbers only. |
| `time_zone` | string | An IANA zone name, exactly as the runtime's `Intl` gives it back as canonical. For example, `"GB"` and `"europe/london"` are refused, and `"Europe/London"` is accepted. At most 64 characters. |
| `place` | string or null | May be absent, which means null. Tidied like `title`, at most 300 characters. An empty string is refused: there is no place, so use null. |
| `cancelled` | `true` | Only in a `change`. Calls the event off. |
| `rrule` | string | Groups only (7.6). |

No other keys are allowed. The host also refuses a new event that has already finished. An event finishes:

- if it is all day: one day after `ends_at`, or one day after `starts_at` if there is no end;
- if it is timed: at `ends_at`, or three hours after `starts_at` if there is no end;
- if it repeats: when its last date finishes.

On a person's site, the owner may have at most 100 events still to come, and invite at most 100 friends to each.

> Note: whether a zone name is accepted depends on the time-zone data of the runtime doing the check. Two sites with
> different tz data can disagree about the same event.

**Answers.** A guest answers with an `answer` record whose content is `{"answer": "going" | "maybe" | "no"}`, and
whose `version` is the event's current version. The host refuses the answer in these cases:

- the writer isn't a guest (on a person's site, someone in the host's guest list; in a group, any member);
- the event has been called off or is over;
- the `version` is out of date;
- the event repeats and the answer has no `date` (7.6).

Each guest's newest answer counts. The host counts only the answers of people who are guests now. The tally is
`{"answers": {<person>: {answer, version, taken}}}`. A reader marks an answer given to an earlier version as given
before the event last moved.

**Version.** An event's version starts as its item id. It becomes the fingerprint of the newest `change` that alters
`title`, `starts_at`, `ends_at`, `all_day`, `time_zone` or `place`, or that calls the event off. In a group, an
admin's `calloff` without a date also moves it. Changing only the words, the guest list or the repeat pattern doesn't
move it.

**Changes.** Only the event's author may send a `change`. Its content is `{"event": {…}, "text": "…"}`, giving the
whole event as it now is, checked as above. The text may be up to 5,000 characters. An event's words change only this
way: an `edit` of an event is refused. The host refuses a change in these cases:

- the event is already off or over;
- the change would make a one-off event repeat, or stop a repeating one repeating;
- after a move, the event would already be over;
- it moves the event within 300 seconds of the last move (`CHANGE_SECONDS`).

A change that also changes who is invited carries a new `audience` (7.7). `cancelled: true` calls the event off for
good. A change to an event that is off is refused. Readers show the host's taken time of that change as
`cancelled_at`.

Source: `src/calendar.js` `cleanEvent`, `parseEvent`, `validZone`, `finishedAt`, `eventChanged`; `src/itemkinds.js`
`eventTrouble`, `workOut`, `eventShown`, `CHANGE_SECONDS`; `src/items.js` `checkNewPost`, `createItem`, `kindPlan`,
`recordOn`, `MAX_GUESTS`; `src/events.js` `readForSigning`.

### 7.6 Repeating events and their dates

Only a group's events may repeat. A repeating event's `event` has `rrule`, which must match one of these exactly, with
nothing else and no more than 80 characters:

```
FREQ=WEEKLY;UNTIL=YYYYMMDD
FREQ=WEEKLY;INTERVAL=2;UNTIL=YYYYMMDD
FREQ=MONTHLY;BYMONTHDAY=<1–31>;UNTIL=YYYYMMDD
FREQ=MONTHLY;BYDAY=<1–4 or -1><SU|MO|TU|WE|TH|FR|SA>;UNTIL=YYYYMMDD
```

- `UNTIL` is a calendar date in the event's `time_zone`, not a UTC time as in RFC 5545.
- The rule must fit the event (`ruleFits`). Its first date must be the day the event starts, in `time_zone`. `UNTIL`
  must be on or after that day, and at most 366 days after it. The event must last less than the shortest gap between
  dates: 7 days for weekly, 14 for fortnightly, 28 for monthly.
- **Dates.** The event's dates are worked out with plain calendar arithmetic, from its start day, stepping 7 or 14
  days, or month by month for up to 13 months. A month without the date (the 31st, a fifth Tuesday) is skipped. There
  are at most 60 dates. Each date is named `YYYY-MM-DD`, its day where the event is held.
- **Times.** Each timed date starts at the same wall-clock time in `time_zone` as the first, and lasts as long as the
  first, so 19:00 stays 19:00 through clock changes. An all-day date starts at the start of its day in the zone, and
  spans as many days as the first.

For example, an event starting on Tuesday 1 December 2026 with `FREQ=MONTHLY;BYDAY=1TU;UNTIL=20270601` has the dates
2026-12-01, 2027-01-05, 2027-02-02, 2027-03-02, 2027-04-06, 2027-05-04 and 2027-06-01.

**Each date has its own list**, with the id `<item id>/<date>`, for example
`cgm2jigLNTp5jQvaO7v2yfKmB-VeDjeomu-eCoN9A9E/2026-12-08`.

- The list holds only two kinds of record, each of which carries `date` and has `item` set to the event's id: `answer`
  records, and at most one `calloff`, which must be about the event.
- The list's first record starts it. That record's `seen` is null. The list's owner is the event's author.
- After a `calloff`, the date's list takes nothing more.
- An answer to a repeating event must have a `date`, and an answer to a one-off event must not. The date must be one
  of the event's dates. That date must not be called off or over, and the `version` must be the event's current
  version.
- **Calling off a date.** The event's author, a group admin or the group's owner may call off a date. An admin may not
  call off a date of an event that the group's owner added. The host takes at most 10 date call-offs per event in any
  24 hours.
- **No per-date changes.** A change always applies to the whole event. Changing only the pattern doesn't move the
  version, so answers to a date that still exists stay valid. Dates that are no longer in the pattern are no longer
  shown.
- **What the host works out.** For each date list, the host works out `{answers, off: {by, at} | null, list: {n,
  head}}` (`dateTally`, `refreshDate`) and keeps it in the event's tally under `dates`. The dates called off appear in
  the event's `skipped` array. When a member's site is sent the event, it is also sent each date's signed `calloff`,
  so it can work out `skipped` from signatures. A member's site reads a date's whole list with
  `GET /_p/items/<id>/dates/<date>` (section 10).
- **Deleting.** Deleting a repeating event also deletes its date lists.

Source: `src/calendar.js` `parseRule`, `ruleFits`, `ruleDates`, `occurrences`, `readRepeat`, `hasDate`;
`src/lists.js` `dateList`, `parseListId`, `Rules.refuse`, `GroupRules.actTrouble`; `src/itemkinds.js` `workOut`,
`dateTally`; `src/items.js` `kindPlan`, `refreshDate`, `dateOver`; `src/groupposts.js` `memberItem`.

### 7.7 Audiences: who may see an item

There are two audiences on a person's site:

| Item | First record's `audience` | Who may see it |
|---|---|---|
| A post (and its photos) | absent | Every friend: every connection that is approved and connected. |
| An event | `{"kind": "invited", "fp": "<43 characters>"}` | Only the friends invited to it: the host's guest list for the item. |

In a group, every item is for all members, and a record with `audience` is refused. There is no "chosen list"
audience for posts: only events are for a chosen list.

**The audience fingerprint** commits the owner's browser to exactly who is invited, without the record naming them:

```
fp = fingerprintOf("audience", salt ‖ UTF-8(join("\n", sort(unique(person ids)))))
   = base64url(SHA-256("afterwrd audience 2\n" ‖ salt ‖ ids))
```

- `salt` is 16 random bytes, made fresh each time.
- The person ids are deduplicated, sorted by JavaScript's default string order (UTF-16 code units; ids are base64url,
  so this is the same as byte order), and joined with `\n`. There is no trailing newline.
- `audience` may appear only on records of kind `item` and `change`, and its `kind` must be `"invited"`.

For example, the salt `AAcOFRwjKjE4P0ZNVFtiaQ` (base64url) with the two guests `YzBZcP6oQxqH-JnBDAEAv7w-GXjIIRcHBz9WBENecAs`
and `DW07_7A_ZNElAe_WYh6clXZOPln3dxhRUMiGBeL360A` gives
`3CGB2QH5cDMwVYUm90X1xQv9ZHge1zoO4AE-oozH4J0` (made with `records.js` `audienceOf`).

**How the host checks it.** The owner's browser sends its own site the guests' connection ids and the salt, alongside
the signed record. The host checks that all of these hold (`guestsFor`):

- every guest is a friend who is approved, connected and has an identity;
- there are no more than 100 guests;
- the fingerprint worked out from their person ids and the salt equals the record's `fp`.

Only then does it store the guest list. A `change` with a new `audience` replaces the list, checked the same way.
Friends taken off the list are told the event is gone, and so are new readers of `/_p/items` (7.9).

**What each friend may see** (`SEES`, `mayCallerSee`):

- every item with no audience;
- events whose guest list holds that friend's connection;
- photo items, which go by the post they're in.

This one rule decides what `GET /_p/items` lists, whether `GET /_p/items/<id>` answers or returns 404, and whether
`POST /_p/records` takes a record (404 "That post isn't here any more.").

**What a reader can check.** A reader can check that the first record says the item is for those invited. A friend's
site keeps an event from a friend only if its first record has `audience`, and a group's only if it has none. A reader
learns it is invited by being sent the item. It cannot check that it is in the fingerprinted list, or who else is: the
salt is never sent to anyone. Guests do see the person ids of everyone who has answered, through the tally and the
event's list. They also see how many are invited (`tally.invited`), but not who.

The host uses the salt for that one check and doesn't keep it, so the fingerprint binds the guest list only at the
moment the host takes the record.

Source: `public/static/records.js` `audienceOf`, `parseRecord`; `public/static/ui/sign.js` `signEvent`;
`src/items.js` `guestsFor`, `createItem`, `kindPlan`, `recordOn`; `src/friendhost.js` `SEES`, `mayCallerSee`,
`handleFriendItems`; `src/friendcopies.js` `keepCopy`; `src/notes.js` `queueItemNote`, `noteFor`.

### 7.8 Edits and deletes on items

The record shapes are in section 5, and the list rules in section 6. As they apply to items:

- **Editing a post's words.** The author sends an `edit` whose `about` is the item's id, with content `{text,
  mentions?}`. The rules:
  - It must come within 15 minutes of the item being taken.
  - Nobody else may have written on the item since. A vote, answer or comment from someone else counts as writing.
  - The text may be up to 5,000 characters.
  - A post with a poll, or with no photos, keeps non-empty text.
  - An event's words change only through `change` (7.5).
  - The words before each edit are kept, as the item's `earlier`.
- **Changing what isn't words.** This is done with `change`, by the item's author only: an event's details (7.5), or a
  post's photo list (7.3).
- **Deleting an item.** The author sends a `delete` whose `about` is the item's id. The host deletes the whole list,
  keeping only its row as a tombstone, and with it the post's photo items, their files (unless something else uses
  them) and, for a repeating event, its date lists. On a person's site, an event's guests are told it's gone, and that
  it's off if it was still to come (section 9). After that, `GET /_p/items/<id>` answers 404 (410 on a group's site, 6.7),
  and the id appears in `gone` (7.9).
- **Groups.** An admin's `remove` of the item works like a delete. A host's own `remove` or `close`, signed with its
  hosting key, is described in sections 5 and 10.

Source: `src/items.js` `recordOn`, `itemFromList`, `itemGone`, `removePhoto`; `src/lists.js` `Rules.refuse`;
`src/hosted.js` `take`, `tombstone`, `tombstoneDates`.

### 7.9 An item as a friend's site is sent it

`GET /_p/items?since=<t>` (section 8) answers with an `items` array, and a new-post note (section 9) carries one item.
In both, each item is the object below (`itemForFriend`). A group's site sends the same shape, with more `records`
(section 10).

```json
{
  "id": "cgm2jigLNTp5jQvaO7v2yfKmB-VeDjeomu-eCoN9A9E",
  "sent": {"record": "<record bytes, base64url>", "sig": "<signature: 64 bytes, base64url>",
           "content": "<content bytes, base64url>", "salt": "<16 bytes, base64url>"},
  "taken": 1795427983,
  "content": {
    "type": "post", "text": "Which day for the walk?",
    "photos": [{"item": "Dz9-1Dd9_7F4EFSObWsgdmNJD17yWaxOJ97jMNJlZhY",
                "hash": "9f2c…e4f5a6", "thumb_hash": "0a1b…c4d5", "width": 2560, "height": 1920, "size": 812345,
                "src": "https://sam.example/files/9f2c…e4f5a6?exp=1795564800&sig=<43 characters>",
                "thumbSrc": "https://sam.example/files/0a1b…c4d5?exp=1795564800&sig=<43 characters>"}],
    "poll": {"options": ["Saturday", "Sunday"], "multiple": 0, "closes_at": 1796169599}
  },
  "earlier": [],
  "edited_at": null,
  "comments": 3,
  "changed_at": 1795428410,
  "list": {"n": 7, "head": "<running fingerprint, 43 characters>"},
  "tally": {"votes": {"YzBZcP6oQxqH-JnBDAEAv7w-GXjIIRcHBz9WBENecAs": 2}, "ended_at": null},
  "version": "cgm2jigLNTp5jQvaO7v2yfKmB-VeDjeomu-eCoN9A9E",
  "records": []
}
```

| Field | Meaning | How the reader treats it |
|---|---|---|
| `id` | The item's id. | Must equal the fingerprint of `sent.record`. |
| `sent` | The first record exactly as signed, with its content and salt (section 5). | Checked in full (`checkRecord`) as of `taken`. It must be of kind `item`, its `host` must be the friend, and its `author` the friend. Otherwise the item is dropped. |
| `taken` | The host's taken time for entry 1. | The time shown. |
| `content` | The item as the host has worked it out now: the latest words, `photos` (each with `src` and `thumbSrc` added for this friend), `poll`, `mentions`, and `event`. An event may include `cancelled_at`, `called_off_by` and `skipped`, which the host adds. | Not trusted. The reader works out the words, the photo list and the event itself from `sent` and `records` (`signedNow`). It takes from here only the `src` and `thumbSrc` of each photo whose `item`, `hash` and `thumb_hash` match the signed ones, and only if each is exactly `<host's address>/files/<that hash>?exp=<1–12 digits>&sig=<43 characters>`. |
| `earlier` | `[{text, replaced_at}]`: the words before each edit. | Recomputed from the signed edits. |
| `edited_at` | The taken time of the last edit, or null. | Recomputed. |
| `comments` | How many comments are showing. | The host's word, kept as a whole number up to 9,999 and shown as the count. Opening the comments reads and checks the thread itself. |
| `changed_at` | When the item last changed, by the host's clock. | Kept; the reader pages by the answer's `until`. |
| `list` | `{n, head}`: where the item's list is up to. | Kept. The list is checked when it is opened (section 6). |
| `tally` | Polls: `{votes, ended_at}`. Events: `{answers, invited, dates?}`. An event's may have `moved_at`. | The host's word, kept only in that shape (`cleanTally`: at most 2,000 people, masks below 1,024, 60 dates). A poll is counted again when it is opened (7.4). A one-off event's answers are not counted again; a repeating group event's answers for the date opened are. |
| `version` | What a vote or answer must name now. | Kept if it is a well-formed id. |
| `records` | `[{n, fp, taken, sent}]`: the author's own `edit` records about the item, and their `change` records, in list order. A group adds `calloff` records, and date call-offs carrying `date`. | Each is checked. A record is applied only if it is on this item and host, and its author is the item's author (or, in a group, the owner, an admin, or for a date call-off the event's author). A dated record must match its `date`. |

The reader also caps what it keeps: `text` at 5,000 characters, 20 photos, 20 `earlier` entries, and the newest 60
`records`.

Source: `src/friendhost.js` `itemForFriend`, `handleFriendItems`, `delegationsFor`; `src/friendcopies.js` `keepItem`,
`keepCopy`, `signedNow`, `cleanTally`, `stripCancelled`; `src/notes.js` `noteFor`; `src/groupposts.js` `memberItem`.

## 8. Friends

A friendship is two sites that each keep a connection to the other, tied to the other owner's identity. Each owner
reads the other's posts from their own site, and writes on them through it: reading is a pull from the friend's
site, writing is a record the reader's site passes on. Nothing secret is exchanged. Every call between friends is a
signed call (section 2) made with the calling site's hosting key, and the receiver works out who is calling from the
caller's identity at the caller's own address.

This section covers every call between friends' sites except notes (`POST /_p/notes`, `POST /_p/mention`: section 9),
site checks (`POST /_p/check-request`, `/_p/check-token`, `/_p/check-soon`, `/_p/check-failed`, `/_p/checked`:
section 11), and `POST /_p/before`, which only brings comments over from afterwrd 1 and isn't specified here.

| Call | Caller | Purpose |
|---|---|---|
| `GET /_connect/<token>` | a browser, unsigned | the page a Connect link opens (HTML) |
| `GET /_connect/<token>/info` | a site, unsigned | the name of the link's owner |
| `POST /_connect/<token>/accept` | a site, signed | ask to be friends with a link |
| `POST /_connect/ask` | a site, signed | ask to be friends without a link |
| `POST /_p/introduce` | an approved friend, signed | introduce the owner to someone |
| `POST /_p/ask-through` | an approved friend, signed | pass on a request to be friends with one of the owner's friends |
| `POST /_p/disconnect` | a friend, approved or waiting, signed | end the friendship, withdraw or decline a request |
| `GET /_p/items?since=` | an approved friend, signed | the owner's posts changed since a time |
| `GET /_p/items/<id>` | an approved friend, signed | one item's whole list |
| `POST /_p/records` | an approved friend, signed | the caller's owner's record on one of the owner's items |
| `POST /_p/records/check` | an approved friend, signed | what became of the caller's owner's records |
| `POST /_p/report` | an approved friend, signed | tell the owner about someone else's comment |
| `POST /_p/reports/check` | anyone, unsigned | what became of reports, by their ids |
| `GET /_p/posts`, `/_p/posts/<key>` | an approved friend, signed | the owner's Facebook posts |
| `GET /_p/albums`, `/_p/albums/<key>` | an approved friend, signed | the owner's albums |
| `GET /_p/photos/<sha256>` | an approved friend, signed | one photo or video |
| `GET /files/<sha256>?exp=&sig=` | a browser, unsigned | a file, by a link the owner's site signed |

Source: `src/app.js` `route`; `src/friendcalls.js`; `src/friendhost.js`; `src/connect.js`.

### 8.1 The friend gate

Every call from a friend's site under `/_p/` except `/_p/mention` and the unsigned `/_p/reports/check` (8.15) passes
through one gate
(`friendCalling`) before anything else is read. All
`POST /_p/*` bodies over 64 KB are refused with 413 `{"error": "That's too big."}` before the gate (`src/app.js`
`route`).

The gate, in order:

1. If the owner has moved away and the move is in effect: **410** `{"error": "Moved.", "moved": "<new origin>"}`.
2. The connection is looked up by the `Afterwrd-From` header: a connection with that origin that is connected (made
   by a link or an ask, approved or not). If there is none, but a friend's identity says they are moving to that
   address and the move is not yet in effect here: **409** `{"error": "Not moved here yet.", "moving": true}`. If it
   is in effect, that friend's connection is used and switched to the new address. If the site is itself mid-move-in:
   **409** with the same body. (Moving: section 4.)
3. No connection: **401** `{"error": "Not connected."}`.
4. The signed call is checked (section 2). The hosting key must be the current one of the identity named by `keyid`,
   at the `Afterwrd-From` address; and if the connection is already tied to an identity, `keyid` must be that
   identity. Any failure: **401** `{"error": "Not connected."}`.
5. A connection not yet approved by the owner here: **403** `{"error": "Waiting for <owner name> to approve the
   connection."}`. Only `POST /_p/disconnect` passes a waiting connection.
6. The caller's daily allowance is counted (section 2): over it, **429** `{"error": "...", "retry": <unix seconds>}`.

So a stranger, an unsigned call and a call signed by the wrong identity all get the same 401, and nobody can learn
from this site who its owner is friends with.

A calling site reads these answers as follows (`src/friendcopies.js` `noteAnswer`): 401 means the friend has removed
this site (its copies of their posts are dropped at once); 403 means their owner has not approved yet; 409, 410 and 429
mean their site is there; anything else, or no answer, means it is away.

Source: `src/calls.js` `friendCalling`, `switchConnection`; `src/friendcopies.js` `noteAnswer`, `pullItems`.

### 8.2 Making friends with a Connect link

A Connect link is `https://<site>/_connect/<token>`. The token is 32 random bytes, base64url (43 characters); the
site keeps only its SHA-256 (lower-case hex). A link works once and lasts 30 days. The path pattern a site accepts is
`/_connect/[A-Za-z0-9_-]{40,100}`. A link made for one person in the owner's Facebook download is the same on the wire.

The owner of site B makes the link and sends it to A's owner by any means. A's owner pastes it into A. A link only
asks: B shares nothing until its owner approves.

**`GET /_connect/<token>`** (unsigned): an HTML page for someone without a site yet. 404 HTML page if the link is
used or expired.

**`GET /_connect/<token>/info`** (unsigned, no allowance counted): `{"name": "<owner's name>"}`, the plain name the
owner set (not a signed profile). Used by A to show its owner who they are about to ask. 404 `{"error": "This friend
link has expired or has already been used. Ask your friend for a new one."}` if it isn't open.

**`POST /_connect/<token>/accept`** (signed call from A). Body:

```json
{
  "name": "Sam Taylor",
  "profile": {
    "bytes": "<signed profile: base64url>",
    "key": "<browser key: base64url>",
    "signature": "<signature: 64 bytes, base64url>",
    "delegation": { "bytes": "<delegation: base64url>", "proof": { "…": "passkey or recovery proof (section 4)" } }
  }
}
```

`profile` is A's owner's signed profile (section 4), or `null` if they have none. B checks, in order:

| Check | Refusal |
|---|---|
| Body at most 64 KB | 413 `That's too big.` |
| Link open (unused, unexpired), checked before the body is read | 404 `This friend link has expired or has already been used. Ask your friend for a new one.` |
| Signed call good, from the identity that A's address names (fetched from A's `/.well-known/afterwrd` if not known); allowance counted | 400 `Couldn't confirm your site: …`; 429 over the allowance (2.6) |
| Caller isn't B itself | 400 `That's a link to your own site.` |
| No connection with A's origin yet | 409 `Your sites are already connected.` |
| Link marked used (atomically: two accepts at once, one wins) | 404 `This friend link has already been used.` |
| Caller's identity not blocked by B's owner (8.14) | 404 `This friend link has already been used.` (the link is spent) |

The link is only checked, and A's identity only fetched, once the token is known to be good, so a stranger can't make
B fetch anything. B then keeps a connection to A's origin, tied to the calling identity, connected but not approved.
A's name is the name in `profile` if it checks against A's identity (and that identity is not frozen); otherwise the
plain `name`, trimmed to 100 characters (`"A friend"` if empty).

Answer, 200:

```json
{ "name": "Ann Example", "profile": { "bytes": "…", "key": "…", "signature": "…", "delegation": { "bytes": "…", "proof": {} } } }
```

`profile` is B's owner's signed profile, or `null`.

**A's side** (`handshake`). Before calling, A refuses locally if it is already connected to B's origin. It fetches B's
identity from B's `/.well-known/afterwrd` first, so it knows who it is asking; a site without one is refused. It then makes the call above (timeout 25 seconds). On 200 it keeps a connection to B's origin, tied
to that identity, approved at once (A asked), and takes B's name from the answer's `profile` if it checks against B's
identity, else from `name`. The answer itself is not signed: it is trusted as coming over HTTPS from the address whose
identity A just fetched, and only the profile inside it is checked.

> Note: neither side calls the other back to confirm. B learns A's identity from the signed call; A learns B's from B's
> address. Each binds the connection to that identity, and every later call is checked against it.

Source: `src/connect.js` `handleConnectLink`, `accept`, `signedName`, `handshake`, `makeFriendLink`, `parseLink`;
`src/calls.js` `siteCalling`.

### 8.3 Asking without a link: `POST /_connect/ask`

A may ask B without a link if A's owner is in a group with B's owner, or a friend of B's owner has introduced A's
owner to them (8.5), which includes a friend in common passing on A's request (`POST /_p/ask-through`, 8.5). Signed
call from A. Body:

```json
{ "name": "Sam Taylor", "profile": { "…": "as in 8.2" }, "via": { "group": "https://group.example", "id": 7 } }
```

or with `"via": { "introduction": true }`. `group` is the group's origin and `id` the group's number on that origin,
as both members know it.

B's checks, in order. Until the call has been proved, every refusal
other than a malformed address (400) is the same 403
`{"error": "Without a friend link, you can only ask someone you're in a group with, or a friend has introduced you to."}`,
so the asker learns nothing about B's friends, groups, introductions or refusals.

1. Body at most 64 KB (413). `Afterwrd-From` must be an `https:` origin with no user, password or trailing dot, and not
   B itself (400 `That doesn't look like an afterwrd site.`).
2. A reason: with `introduction: true`, B holds an introduction to A's origin, made in the last 60 days by a friend who
   is still approved and whose site has answered B. With `group`, B's owner is a member of that group (by origin and
   id) and the group's member list includes A's origin as an approved member. B checks only the member list it keeps,
   never asking the group while the asker waits (so the time the answer takes says nothing about B's groups); a list
   over an hour old is asked for again after answering, at most once an hour per group. A's site asks once more a few
   seconds later if refused (since 2.3.2). No reason: 403.
3. The signed call checks, from the identity at `Afterwrd-From` (allowance counted): otherwise 403. Only a call with
   a reason gets this far, so only then may B fetch the asker's identity.
4. Rate: at most 30 proved asks per hour overall and 5 per asking origin, counted in the same statement that records
   the ask: 429 `Lots of people are asking to be friends just now. Try again later.`
5. Already approved friends: 409 `You're already friends.` Already asking, declined before (8.4), or blocked:
   409 `You've already asked.`
6. At most 20 requests waiting for B's owner, checked in the same statement as the insert:
   429 `<owner name> has a lot of friend requests waiting. Try again later.`

Answer, 200: `{"name", "profile"}` as in 8.2. A's side is the same `handshake`, with `via` added to the body.

B keeps why it was asked, to show its owner: the group, the introducer, or (for an introduction marked `asked`) the
friend in common, shown as "You're both friends with <name>".

Source: `src/connect.js` `ask`, `reasonFor`, `liveIntroduction`, `askToBeFriends`.

### 8.4 Waiting, approved, declined

Each side keeps its own state for the other; there is no call that says "approved".

| Step | A (asked) | B (was asked) | On the wire |
|---|---|---|---|
| A asks (8.2 or 8.3) | approved at once | connected, waiting | A's pulls of B (8.7) get 403; B doesn't call A |
| B's owner approves | — | approved | nothing is sent; A's next pull succeeds, and B starts pulling A |
| B's owner declines | — | forgotten | B sends `POST /_p/disconnect` to A first |
| A's owner withdraws | forgotten | — | A sends `POST /_p/disconnect` to B (allowed while waiting) |

If B's owner later asks A by 8.3 while A's request is waiting, B approves it with no call (unless A came by a link made for someone in B's Facebook download, which B's owner
still approves). A site counts the other as
"friends both ways" once the other has answered a pull (`reached_at`): only then may it introduce them (8.5) or accept
an introduction from them.

A site remembers origins it must not take a linkless ask from again (`declined_asks`): an origin whose 8.3 request
its owner declined, and an origin its owner removed (8.6). Asking that origin itself, or approving it, clears the mark.
A Connect link still works.

Source: `src/connect.js` `decideRequest`, `approve`, `askToBeFriends`, `removeFriend`; `src/friendcopies.js`
`waitingFor`, `noteAnswer`.

### 8.5 Introductions: `POST /_p/introduce`

An owner introduces two friends to each other: their site tells each friend's site about the other, which gives
each a reason to ask without a link (8.3). Signed call from an approved friend. Body:

```json
{ "type": "Introduce", "origin": "https://sam.example", "name": "Sam Taylor", "content": "You both love birds." }
```

`type` is sent but not read. `asked: true` marks an introduction made by passing on a request (below): it is kept the
same way, but not shown to the owner as an introduction, as the request follows at once. `content` is optional; the receiver normalises line endings, trims, and cuts it to 300
characters. `name` is trimmed and cut to 100 characters (`"A friend"` if missing); it is the introducer's name for that
person, unsigned.

| Check | Answer |
|---|---|
| `origin` is a valid origin (as in 8.3), not the receiver and not the caller | 400 `That isn't someone to be introduced to.` |
| The caller's site has answered the receiver (friends both ways); if it never has, the receiver pulls from it once now (8.7) | 403 `You haven't approved <owner name> as a friend yet.` |
| At most 20 a day from one friend, every introduction counted whether kept or not, before anything is looked up (in the count's own statement) | 429 `That's a lot of introductions for now. Try again later.` |
| `origin` is already connected, declined, already introduced by this caller, or belongs to an identity the owner has blocked | 200 `{"ok": true}`, nothing kept |
| Over 20 kept from one friend, or 100 kept overall | 200 `{"ok": true}`, nothing kept |
| Otherwise | 200 `{"ok": true}`, kept for 60 days |

The answer never depends on whom the owner knows: a friend can't use introductions to test who the owner is friends
with, has turned down or has blocked (since 2.3.2).

On the sending side, an owner may introduce up to 10 friends to each other at once; each call tells one friend about
one other, and a request makes at most 9 calls. Only friends both ways can be introduced.

Source: `src/connect.js` `receiveIntroduction`, `introduceFriend`, `introduceTogether`, `introducible`.

#### Passing on a request: `POST /_p/ask-through`

A's owner sees someone (C) comment on a post of their friend B's, and would like to be friends with them. A asks B's
site to pass it on. Signed call from A, an approved friend of B. Body: `{ "origin": "https://c.example" }`.

| Check | Answer |
|---|---|
| `origin` is a valid origin (as in 8.3), not B and not A | 400 `That isn't someone to ask.` |
| A's site has answered B (friends both ways); if it never has, B pulls from it once now (8.7) | 403 `You haven't approved <owner name> as a friend yet.` |
| At most 10 from one friend a day, 30 an hour overall, counted in the same statement that records it | 429 `That's a lot of requests to pass on for now. Try again later.` |
| Otherwise | 200 `{"ok": true}` |

If `origin` is a friend of B's owner both ways, B's site then introduces A to C (`POST /_p/introduce` to C, with
`origin` A, B's name for A, and `asked: true`), after answering, so the time the answer takes says nothing either, and
doesn't say whether that worked. A's site asks C once more a few seconds later if refused. The answer is the same whether or
not C is B's friend, so A can't find out who B's owner is friends with by asking: only A's request to C (8.3, with
`via: { "introduction": true }`), which C's owner then sees, shows it. A site makes that request straight after a 200.

Source: `src/connect.js` `passOnAsk`, `askToBeFriends`.

### 8.6 Ending it: `POST /_p/disconnect`

Signed call from a friend, approved or still waiting. Body `{}`. Answer 200 `{"ok": true}`.

Sent when an owner removes a friend, withdraws a request, declines one, or blocks a friend (8.14). The sender forgets
the receiver whether or not the call gets through, and marks the receiver's origin as declined (8.4) when removing.
The receiver forgets the caller: the connection, their place in the owner's invited events (their answers are taken
out of those events' totals), its copies of their posts, introductions they made, and notices about them. It does not
mark the caller as declined. Neither side deletes records already on the other's lists: those stay, signed.

After this, the caller's calls get 401 (8.1), and per-friend links to files stop working at once (8.12).

Source: `src/friendcalls.js` `handleFriendCalls`; `src/connect.js` `removeFriend`, `decideRequest`; `src/events.js`
`friendGone`.

### 8.7 Reading posts: `GET /_p/items?since=<t>`

The owner's posts that changed after `t`, oldest change first, 50 at most. `t` is a time on the host's clock (unix
seconds), as the host gave it in `until` last time; `0` or missing means from the start. Only posts (not photos, which
come inside their post), and only those the caller may see: everyone's posts, and events the caller is invited to
(section 7).

Answer, 200:

```json
{
  "v": 2,
  "items": [
    {
      "id": "<item id: 43 characters>",
      "sent": { "record": "<base64url>", "sig": "<signature: 64 bytes, base64url>", "content": "<base64url>", "salt": "<base64url>" },
      "taken": 1795431600,
      "content": { "text": "First frost on the allotment.", "photos": [
        { "item": "<photo item id>", "hash": "<sha256 hex>", "thumb_hash": "<sha256 hex>",
          "src": "https://ann.example/files/<sha256 hex>?exp=1795564800&sig=<43 characters>",
          "thumbSrc": "https://ann.example/files/<sha256 hex>?exp=1795564800&sig=<43 characters>" } ] },
      "earlier": [], "edited_at": null, "comments": 2, "changed_at": 1795435200,
      "list": { "n": 3, "head": "<running fingerprint: 43 characters>" },
      "records": []
    }
  ],
  "gone": ["<item id>"],
  "until": 1795435200,
  "more": false,
  "identity": 3,
  "delegations": { "<browser key>": { "bytes": "<base64url>", "proof": {} } },
  "mine": { "now": 1795438800, "records": [ { "fp": "<43 characters>", "list": "<item id>", "taken": 1795433000 } ] },
  "profile": { "bytes": "…", "key": "…", "signature": "…", "delegation": { "bytes": "…", "proof": {} } }
}
```

| Field | Meaning |
|---|---|
| `items` | each post as section 7 describes: its first record as signed (`sent`, `taken`), its words now, photos with per-friend links (8.12), its list's count and head, `records` (its writer's signed edits and changes, each `{n, fp, taken, sent}`), and for polls and events a `tally` and `version` |
| `gone` | ids of lists deleted after `t` (an event only to those invited to it when it went), and of events the caller was uninvited from after `t` |
| `until` | the `since` to send next time. With `more`, the last change sent. Otherwise the last change sent, but never later than one second before now and never earlier than `t`, so a change later in the same second isn't missed; the reader may receive the same post twice |
| `more` | there are more than 50; ask again with `until` |
| `identity` | how many documents the owner's identity chain has; a reader whose copy is shorter fetches `/.well-known/afterwrd` again |
| `delegations` | for each browser key that signed a record in `items` (first records and `records`), its delegation `{bytes, proof}` |
| `mine` | the caller's owner's records this site took from 600 seconds before `t` on, at most 200: see 8.11 |
| `profile` | the owner's signed profile now, if there is one |

The reader checks each item before keeping it (section 7, `keepCopy`): the first record must check with the given
delegations at `taken`, its fingerprint must equal `id`, its kind must be `item`, and its host and author must both be
the friend's identity. The words, photos and event details are worked out again from the signed records, not taken
from `content`. A reader keeps a photo's links only if each is exactly the friend's own link to that file (8.12).

A reader pulls each approved friend at most once an hour, up to 3 pages a pull and 40 friends a round, in the
background from Home; friends never yet pulled (or still waiting) are pulled while Home waits, up to 10 for at most 4
seconds. A friend whose site said 429 is not asked again until its `retry`. Calls time out after 8 seconds and replies
over 2,000,000 bytes are not read.

Source: `src/friendhost.js` `handleFriendItems`, `itemForFriend`, `mayCallerSee`, `delegationsFor`;
`src/friendcopies.js` `pullItems`, `pullFriends`, `pullNew`, `keepCopy`; `src/calls.js` `callFriend`.

### 8.8 Reading one item: `GET /_p/items/<id>[?after=<n>]`

`<id>` is a 43-character item id: a post, or a photo in one (a photo goes by its post). The whole list of that item,
or only entries after `n`, for a reader that has already checked up to `n` (`src/threads.js`).

| Condition | Answer |
|---|---|
| The caller may not see it (no such item, or an event they're not invited to) | 404 `{"error": "Not found."}` |
| No list | 404 |
| Deleted or removed whole (the item has gone, so the caller can't see it) | 404 `{"error": "Not found."}` |

Answer, 200: the list, in the form section 6.9 gives (`v`, `owner`, `entries`, `signedHead`, `checkpoint`,
`commentsOff` when the owner has turned comments off, `delegations`, `people`). Without `after`, a list longer than 500 entries is sent from its latest checkpoint (6.6).
`people` carries the identity chain and signed profile of every writer in the entries, as far as this site knows
them, so the reader can check and name people it doesn't know.

The reader checks the whole list against the host's hosting key (section 6). If what's new doesn't follow on from the
point it checked before, it reads the whole list again and tells its owner if what it checked before has changed.

Source: `src/friendhost.js` `handleFriendItems`, `peopleFor`; `src/hosted.js` `readList`; `src/friendcopies.js`
`friendThread`; `src/threads.js`.

### 8.9 The owner's signed name

There's no call for it on its own. A friend's site gets the owner's signed profile (section 4.12) in the answers to
`POST /_connect/<token>/accept` and `POST /_connect/ask` (8.2, 8.3) and in every `GET /_p/items` answer (8.7), and
keeps it only if it checks and is newer than the one it holds.

Source: `src/connect.js` `accept`, `ask`; `src/friendhost.js` `handleFriendItems`; `src/friendcopies.js` `pullItems`.

### 8.10 Writing: `POST /_p/records`

A friend's site passing on its owner's record (a comment, edit, delete, vote or answer: section 5) on one of the
owner's items. The record was signed in the friend's browser; their site adds the delegation for the key that signed
it and their signed profile. Body:

```json
{
  "sent": { "record": "<base64url>", "sig": "<signature: 64 bytes, base64url>", "content": "<base64url>", "salt": "<base64url>" },
  "delegation": { "bytes": "<base64url>", "proof": { "…": "…" } },
  "profile": { "bytes": "…", "key": "…", "signature": "…", "delegation": { "bytes": "…", "proof": {} } }
}
```

`profile` is optional. The host checks, in order:

| Check | Refusal |
|---|---|
| `sent.record` parses as a record with a 43-character `item` (so never an `item` record) | 400 `That didn't work.` |
| The record's `author` is the calling identity | 403 `That isn't your site's to send.` |
| The caller is not blocked by the owner | 409 `That wasn't taken.` |
| The caller may see the item (8.8) | 404 `That post isn't here any more.` |
| Fewer than 200 records from this author taken here in the last day, across all items (`delete`, `leave`, `remove` and `calloff` aren't counted) | 429 `That's a lot for one day here. Try again tomorrow.` |
| `delegation.bytes` is a delegation (at most 1024 bytes) from the caller's identity, good now, for `record.key` | 400 `That isn't signed by them.` |
| The record itself, the list's rules and the kind's rules (sections 5 and 6) | 409 with the reason; `duplicate` if the list already has it |

Once the record is taken, the delegation is kept, so the host can pass it on with the list; a delegation sent with a
record that's refused isn't kept. If `profile` checks against the caller's identity, it is kept and passed on with the list in `people`; if not,
it is ignored.

Answer, 200:

```json
{ "ok": true, "receipt": { "bytes": "<signed head: base64url>", "sig": "<signature: 64 bytes, base64url>" }, "n": 4 }
```

`receipt` is the host's signed head with the record as entry `n` (section 6). A comment also makes the host tell its
owner and others in the thread (section 9).

**The writer's side.** The writer's site sends only records its own owner signed (`author` is its owner, the
delegation is one it holds and still good), and keeps each in its `sent` table with the receipt. If the host answered
409 `duplicate`, the record counts as taken. If it answered another 4xx, the record is not kept (the owner is told),
except a `delete`, which is kept to send again. If there was no answer or a 5xx, it is kept as "unsure" and the next
check (8.11) finds out.

Source: `src/friendhost.js` `handleFriendItems`; `src/items.js` `recordOn`; `src/hosted.js` `takeRecord`,
`overDailyRecords`; `src/friendcopies.js` `relayRecord`; `src/sentchecks.js` `keepSent`.

### 8.11 What became of a record: `POST /_p/records/check`

A writer's site asking a host what became of its owner's records there. Body:

```json
{ "points": [ { "fp": "<record fingerprint: 43 characters>", "list": "<item id, or item id/YYYY-MM-DD>" } ] }
```

More than 200 points: 413 `{"error": "At most 200 at a time.", "status": 413}`. Points whose `fp` isn't 43 base64url
characters or whose `list` isn't a list id are dropped. With none left: `{"results": [], "delegations": {}, "people": {}}`.

Each point gets a state:

| State | When |
|---|---|
| `missing` | no such list; or the host's index has no record with that fingerprint on that list by the caller; or the entry isn't where the index says |
| `gone` | the list was deleted, or the caller may no longer see the item |
| `there` | the entry still has its record |
| `deleted`, `removed` | the entry was emptied by a `delete` or `remove` about it; comes with `marker: {sent, taken}`, the signed record that did it |

Answer, 200:

```json
{
  "results": [ { "fp": "<43>", "state": "removed", "marker": { "sent": { "record": "…", "sig": "…" }, "taken": 1795440000 } } ],
  "delegations": { "<browser key>": { "bytes": "…", "proof": {} } },
  "people": { "<person id>": { "chain": ["…"], "profile": {} } },
  "roles": {}
}
```

`delegations` and `people` cover the markers' signers (other than the host). `roles` is `{}` (or absent, when no points were left) from a person's
site; a group's site fills it (section 10).

The writer doesn't take a marker on the host's word. It checks the marker as a record (at its `taken`), that its host
is this host and its `about` is the fingerprint asked about; a `delete` counts only if the owner signed it, and on a
friend's post a `remove` counts only if the friend signed it. A marker that fails is treated as `missing`. The owner is
told about records `removed`, and about records `missing` that the host had taken; an "unsure" record found
`missing` was never taken and is forgotten.

**`mine`.** Each `GET /_p/items` answer (8.7) also lists the caller's records the host took recently, with the host's
clock (`now`). The writer looks for any taken more than 300 seconds before `now` that its own `sent` table doesn't
have: something signed as its owner that their site never sent, which Home then reports.

**The writer's schedule.** Records are asked about daily for their first week, weekly up to 90 days, then monthly,
while the host is still a friend. A round runs at most once an hour from Home, and asks up to 10 hosts, one call each
(at most 200 points; timeout 15 seconds). A host that doesn't answer is asked again a day later. A `delete` not yet
taken is sent again with `POST /_p/records` at each round, up to 20 a host, for 30 days. A host that is no longer a
friend isn't asked.

Opening a thread (8.8) also settles records: the writer compares the checked list with its `sent` table, and a record
the host gave a receipt for, at a point the reader was shown, that isn't in the list, counts as `missing`.

Source: `src/sentchecks.js` `answerCheck`, `mineSince`, `checkSentRound`, `checkHost`, `checkMarker`, `removersAt`,
`settle`, `compareThread`, `compareMine`; `src/friendhost.js` `handleFriendItems`.

### 8.12 Photos and videos: links to files

Files never travel inside a call. A site sends links to them, signed by itself, which the reader's browser loads
straight from that site: `GET /files/<sha256>?exp=<t>&sig=<s>` (or `HEAD`), unsigned, with no session. `<sha256>` is
the file's SHA-256 in lower-case hex. Only the site that made a link can check it.

Each site has one 32-byte HMAC key (`media_key`, random, kept in its settings). Two kinds of link:

| Kind | Used for | `exp` | `sig` |
|---|---|---|---|
| per-friend | photos in `/_p/items`, and everything in 8.13 except the owner's profile picture and cover | the end of the next UTC day: `(floor(now / 86400) + 2) × 86400`, so 24 to 48 hours, and the same all day | 32 bytes: the friend's connection number on this site (4 bytes, big-endian), then the first 28 bytes of HMAC-SHA256(key, `"<sha256>.<exp>.friend.<number>"`) |
| plain, long | the owner's profile picture and cover (8.13) | `(floor(now / 86400) + 7) × 86400`: 6 to 7 days | HMAC-SHA256(key, `"<sha256>.<exp>"`), 32 bytes |
| plain, short | a member's site's links to its own files, for its group to copy them (section 10.10) | `(floor(now / 3600) + 2) × 3600`: 1 to 2 hours | as above |

`sig` is base64url without padding (43 characters); the strings are UTF-8. Example:
`https://ann.example/files/<sha256 hex>?exp=1795564800&sig=<43 characters>`.

The site serving a link checks: `exp` is an integer later than now; `sig` is 43 base64url characters; then either the
plain HMAC matches, or `exp` is no later than the end of the next UTC day, the per-friend MAC matches (constant-time
comparison) and that connection is still connected and approved. A good link is answered with the file (`Range` and
`If-None-Match` are honoured) and `Cache-Control: private, max-age=<seconds left>`. Otherwise 403, text
`This link has expired`.

So removing a friend stops their per-friend links at once. A plain link works for anyone who has it until it
expires, friend or not.

A reader of the Facebook archive (8.13) takes a link only if it is exactly `<friend's origin>/files/<sha256>?exp=<1–12
digits>&sig=<43 characters>` for the file it describes.

Source: `src/share.js` `signedFile`, `signedFor`; `src/app.js` `signedFile`, `serveFile`; `src/friends.js`
`signedLink`.

### 8.13 The shared Facebook archive and albums

An owner who imported their Facebook download can share it with friends. These calls answer in ActivityStreams 2.0
(`public/static/activity.js`), plain text (`mediaType: "text/plain"`), with afterwrd's own terms under
`https://afterwrd.app/ns#` (prefix `afterwrd:`). Every address is on the owner's site: the owner is `<site>/`, a post
`<site>/posts/<key>`, a photo `<site>/photos/sha256/<hash>`, a file `<site>/files/<hash>`. Files come as per-friend
links in `afterwrd:fetch` (the owner's own picture and cover, as plain long links). Where photos were taken is never
sent. The owner's signed posts never come this way: only `/_p/items`.

| Call | Answer |
|---|---|
| `GET /_p/posts?page=n` | `OrderedCollectionPage` of Facebook posts, newest first, 30 a page: `totalItems`, `afterwrd:page`, `afterwrd:hasNext`, `attributedTo` (the owner as a `Person`, with `icon` and `image`), `orderedItems` (`Note`s). Empty (`totalItems: 0`) unless the owner shares Posts |
| `GET /_p/posts/<key>` | one `Note`, with `attributedTo` the owner; 404 unless shared. `<key>` is `post-<digits>-<8 hex>` |
| `GET /_p/albums` | `Collection` of albums, each a `Collection` with `name`, `totalItems`, `afterwrd:key`, `published` (first photo), `updated` (last), `icon` (cover). Albums made on the site always; Facebook's, and the sets `other` and `videos`, if the owner shares Photos. Empty albums are left out |
| `GET /_p/albums/<key>?page=n` | `OrderedCollectionPage` of `Image`s and `Video`s, oldest first, 150 a page, with `name`, `summary`, `totalItems`, `afterwrd:key`, `afterwrd:page`, `afterwrd:hasNext`. `<key>` is digits, `other` or `videos`; 404 if not shared |
| `GET /_p/photos/<sha256>` | one `Image` or `Video`, if it's in a shared album or came with a shared post; 404 otherwise. With `afterwrd:album` `{key, name, totalItems, index}` and `afterwrd:prev` / `afterwrd:next` (neighbours' hashes) when it's in a shared album; with `afterwrd:item` `{post, index}` (1-based) when it's a photo in a signed post (the reader opens it there, by 8.8); otherwise with `afterwrd:postedWith`, the shared post it came with |

`page` is clamped to 1–10,000. A `Note` has `id`, `attributedTo`, `published`, `summary` (title), `content`,
`attachment` (media, and a `Link` for a shared link), `tag` (`Mention`s with a name only: people tagged on Facebook),
`location` (`Place` with a name), `context` (`Group` with a name) and `afterwrd:kind`. Media have `id`, `url`,
`mediaType`, `width`, `height`, `preview` (thumbnail, with its own `afterwrd:fetch`), `name` (description),
`published`, `afterwrd:takenAt` and `afterwrd:fetch`. Single objects (`/_p/posts/<key>`, `/_p/albums/<key>`,
`/_p/photos/<sha256>`) carry `@context`; lists of posts and albums don't. 404s are `{"error": "That isn't there any more."}`.

Photos of signed posts are in the album "Posted on afterwrd", which every friend is shown.

The reader keeps only what it can check: every address must be on the friend's own site, every link exactly as in
8.12, and it reads at most 100 posts, 2,000 albums and 500 photos per answer, and drops any text longer than it expects.

Source: `src/friendcalls.js`; `src/share.js` `sharePosts`, `sharePost`, `shareAlbums`, `shareAlbum`, `sharePhoto`,
`ownerActor`, `photoShared`; `src/friends.js`; `public/static/activity.js`.

### 8.14 Blocking

Blocking is by identity, so it holds if the person moves site. They aren't told. What changes on the wire:

| Situation | What the blocking site does |
|---|---|
| Blocking an approved friend | ends the friendship first: `POST /_p/disconnect` to them (8.6), and marks their origin declined |
| Blocking someone whose request is waiting | drops the request and marks their origin declined; no call |
| Their `POST /_connect/<token>/accept` | 404 `This friend link has already been used.`; the link is spent |
| Their `POST /_connect/ask` | 409 `You've already asked.` |
| A friend's `POST /_p/introduce` naming their origin | 200 `{"ok": true}`, nothing kept |
| Their `POST /_p/records` | 409 `That wasn't taken.` (they'd normally get 401 first, not being a friend) |
| Their notes and mention receipts | dropped (section 9) |

Records of theirs already on the owner's lists stay, and are still sent to other readers in `/_p/items/<id>` (a list
is signed and can't leave entries out); the owner's own pages fold them away. Their votes and event answers still
count. The owner can still make friends with them again by using a Connect link of theirs, without unblocking; their
records are then still refused.

Source: `src/blocks.js` `handleBlocks`, `isBlocked`; `src/connect.js` `accept`, `ask`, `receiveIntroduction`;
`src/friendhost.js` `handleFriendItems`.

### 8.15 Telling the owner: `POST /_p/report`, `POST /_p/reports/check`

A friend's site tells the owner here about someone else's comment on one of the owner's posts ("Tell Ann"). A group's
site takes the same calls from members, about any member's post or comment, for its owner and admins (10.9). Reports
go only to whoever runs the space: never to anyone central, and never to the person reported. A report isn't a record
and isn't signed by a browser: the signed call (section 3) says which person's site sent it, which is enough, since
nobody else reads it.

Body of `POST /_p/report`:

```json
{ "item": "<the list it's on>", "about": "<the record's fingerprint>", "reason": "unkind", "note": "…", "named": true }
```

`reason` is one of `unkind`, `wrong`, `spam`, `illegal`, `other`; `note` is trimmed and cut to 500 characters;
`named` is true unless it's `false`. On a person's site
`about` must be a `comment` by someone other than the owner; on a group's, a `comment` or an `item` (a post or photo),
by anyone but the caller. A group sends it to its owner and admins **apart from whoever wrote it**, and never lists it
to them or lets them leave it; with nobody else running the group, it's refused (400). The host keeps a copy of what
the record said (once for each thing), until 90 days after the report is dealt with, even if its writer deletes it.
With `named: false` it keeps no record of who sent it. The daily caps (10 a person, once a thing a day, and a named
report once a thing for good) are kept under SHA-256 of a random salt made each day with the person, and the person and
the thing; the salt and the day's rows go when the next day's first report comes. That's what honest code keeps: the
call itself is signed by the sender's site, so whoever runs the host could learn who by changing its code. At most 20
reports about one thing are kept open; another is answered with the id of one already there, whose outcome it shares.

| Status | When |
|---|---|
| 200 `{"ok": true, "id": "<report id>"}` | kept |
| 400 `That didn't work.` | `about` (on a group's site, `item` too) isn't a 43-character id, or `reason` isn't one of the five |
| 400 `That's yours.` | the record is the caller's own |
| 400 | a kind this host doesn't take reports about (`That can't be reported here.`), or nobody but its writer runs the group |
| 404 | the caller may not see `item` (`That post isn't here any more.`), or `about` isn't on it, or has been emptied (`That isn't there any more.`) |
| 409 `You've told them about this already.` | the same person, about the same record: today, or ever for a named report |
| 409 `This group has closed.` | a group's site, once it's closed (10.13) |
| 429 `That's a lot for one day. Try again tomorrow.` | more than 10 from one person in a day (UTC) |

On a person's site, an `illegal` report also tells the owner's phones, for the first 3 such reports in 24 hours; other
reasons wait quietly for the owner to look.

A site from before reports answers 404 `Not found.`: the reporter's site says theirs needs updating.

A report is dealt with when what it's about is removed (a `remove` of it, or of the post it's on), when its writer is
removed from the group, or when whoever runs the space leaves it, with an optional word back (300 characters).

`POST /_p/reports/check` `{ids: [<report id>…]}` is **unsigned**: a report's id is a 256-bit secret only its sender's
site has, so asking needn't say again who's asking. A body over 8,192 characters is 413 `{"error": "Too much."}`; ids
that aren't 16 to 64 base64url characters are dropped, and only the first 50 left are looked at. It answers `{reports:
[{id, outcome, word}]}`, leaving out ids it doesn't know: `outcome` is null while open, else `removed`, `left` or
`member`. A report whose post or comment has
gone with its list (a whole post deleted or removed, its photos with it) counts as removed. The reporter's site asks
hourly at most, the longest-unasked first, and says what became of it in Notifications; for `illegal` still open after
3 days, it says where else to turn. Reports to a friend or group it no longer has are marked gone and not asked about.

A group's `report` note (10.12) reaches its admins' sites through their own notice budget (20 a day from a group),
apart from the one other notices share, so neither crowds out the other.

Source: `src/reports.js`; `src/friendhost.js`, `src/groupposts.js` (the calls); `src/groups.js` (`/_group/admin/reports`).

## 9. Notes

A note is how one site tells another that something happened, so the receiver needn't poll every friend. Every note is
"fat": it carries the signed things it is about, so the receiver checks it there and then from what it holds, and never
has to call back to find out what the note meant. A note is a hint plus evidence. Missing one loses nothing that
matters: the same records reach the receiver anyway the next time it reads the sender's posts (section 8).

There are two calls:

| Call | Sent by | About |
|---|---|---|
| `POST /_p/notes` | a person's site to its friends' sites; a group's site to its members' sites | a new post, a comment, a change to an event, something gone, a group closing |
| `POST /_p/mention` | the site of a comment's writer to the site of each person it mentions | a mention receipt: the host's receipt for that comment |

### 9.1 POST /_p/notes

A signed call (section 2). The body is one JSON object, `{"v": 2, "kind": …, …}`. A note body is built for each
recipient at the moment it is sent, not when it is queued. A post note's photo links are specific to that recipient,
and a note about something deleted since it was queued is not sent at all.

**Who may send it.** The receiver first checks whether the call comes from a group it belongs to: `Afterwrd-From` must
be the address of a group with an identity that the owner has joined, and the call must be signed by that group's
hosting key for that address. If so, the note is handled as a group note (9.3). If not, the caller must be a friend
(`friendCalling`, section 2). An unknown or badly signed caller gets `401`. A friend who isn't approved yet gets `403`.
A site that has moved answers `410`, and one part-way through a move answers `409`.

**Size.** Bodies over 64 KB are refused with `413` before anything is read, as for every `POST /_p/…` call (section 2).

**Answers.**

| Status | Body | When |
|---|---|---|
| `202` | `{"ok": true}` | the note was taken; also when it checked but was dropped quietly (the writer is blocked, it's the owner's own, it isn't for them) |
| `400` | `{"error": "That didn't work."}` | not JSON, `v` isn't `2`, unknown kind, malformed fields, or the receiver has no hosting key yet |
| `400` | `{"error": "That isn't a post of theirs."}` / `"Their identity couldn't be checked."` / `"That receipt doesn't check."` / `"That comment doesn't check."` / `"That isn't theirs to change."` / `"That isn't a change to an event."` | a check failed (below; a group's wording is in 9.3) |
| `401`, `403`, `409`, `410`, `413`, `429` | `{"error": …}` | refused before the note was looked at (section 2) |

The sender reads only the status. 2xx means delivered. Retries are described in 9.6.

Source: `src/notes.js` `receiveNotes`; `src/groupjoin.js` `signedGroup`; `src/calls.js` `friendCalling`; `src/app.js`.

### 9.2 Notes from a friend's site

A person's site sends four kinds. Their fields:

| Kind | Fields | Sent to |
|---|---|---|
| `item` | `item`, `delegations` | every friend when the owner posts; for an event, only those invited (and anyone added to it later) |
| `comment` | `item`, `photo?`, `entry`, `receipt`, `delegations`, `people` | everyone the comment mentions, and everyone else who has commented on that item, apart from its writer, as long as they are friends of the host |
| `change` | same fields as `comment` | everyone still invited to an event when its writer changes it (not those just added, who get `item`) |
| `gone` | `item`, `cancelled` | those whose invitation to an event was taken back, and all guests when an event is deleted |

Shared fields:

| Field | Type | Meaning |
|---|---|---|
| `item` | string (43-char id) or object | for `item`: the post exactly as `GET /_p/items?since` gives it (section 8: `id`, `sent`, `taken`, `content`, `records`, `list`, …); for the rest: the list's id (a post, or a photo in one) |
| `photo` | `{post, index}` | when `item` is a photo inside a post: the post's id and the photo's position, 1-based, 1–20 |
| `entry` | `{n, fp, taken, prev, sent}` | the list entry (section 6): its number (≥ 2), the record's fingerprint, when the host took it (seconds), the running head of entry `n − 1` (`""` if none), and the signed record as the host holds it (`{record, sig, content, salt}`, section 5) |
| `receipt` | `{bytes, sig}` | the host's signed head for that entry (section 6: `{v: 2, kind: "head", host, list, n, head}`, signed by the host's hosting key) |
| `delegations` | `{<key>: {bytes, proof}}` | the delegations behind the keys that signed the records carried (section 4) |
| `people` | `{<person>: {chain, profile?}}` | the identity document chain and signed profile of the comment's writer (section 4) |
| `cancelled` | boolean | `gone` only: the event was still to come and has been deleted, so its guests are told it's off |

Example: a comment note.

```json
{
  "v": 2,
  "kind": "comment",
  "item": "<item id: 43 chars, base64url>",
  "photo": { "post": "<post id: 43 chars>", "index": 2 },
  "entry": {
    "n": 5,
    "fp": "<record fingerprint: 43 chars>",
    "taken": 1763905212,
    "prev": "<running head of entry 4: 43 chars>",
    "sent": { "record": "<record bytes, base64url>", "sig": "<signature: 64 bytes, base64url>",
              "content": "<content bytes, base64url>", "salt": "<16 bytes, base64url>" }
  },
  "receipt": { "bytes": "<signed head bytes, base64url>", "sig": "<signature: 64 bytes, base64url>" },
  "delegations": { "<browser key>": { "bytes": "<delegation bytes>", "proof": { "…": "section 4" } } },
  "people": { "<person id>": { "chain": ["<identity document>", "…"], "profile": { "…": "section 4" } } }
}
```

**`item`: a friend's new post.** The receiver checks it as it checks any post from that friend (section 8,
`keepItem`). The first record must check against the delegations sent. Its fingerprint must be `item.id`. It must be
kind `item`, hosted by the calling friend and written by them. Its words and details are worked out from the signed
records in `item.records`, not from what the host says they are. Failing any of that gets `400 "That isn't a post of
theirs."`. A post that checks is kept as a copy at once, whatever the owner's notice limits say. Then the receiver:
- for an event (the first record has an `audience`), keeps an "invite" notice and may tell the owner's phones;
- otherwise keeps a "post" notice, and a "mention" if the record's `mentions` names the owner here.

**`comment` and `change`.** The receiver checks:
1. `item` is an id. `entry.n` is a safe integer ≥ 2, `entry.taken` a safe integer, `entry.fp` an id, `entry.prev` a
   string. Otherwise `400 "That didn't work."`.
2. The host took it there. The host's identity must be known here (`400 "Their identity couldn't be checked."`). It
   works the head out again,
   `headOf({host: caller, list: item, prev, n, fp, taken})` (section 6). It checks `receipt` against the caller's
   current hosting key for that host and list. The receipt's `n` and `head` must equal `entry.n` and the head just
   worked out. Otherwise `400 "That receipt doesn't check."`.
3. It learns the writer's identity from `people` (only the entry for the record's `author` is read), and their signed
   name.
4. The record checks (section 5), with delegations looked up only in `delegations`, as at `entry.taken`. Its
   fingerprint must be `entry.fp`, its kind must be the note's kind, `host` must be the caller and `item` must be
   `item`. Otherwise `400 "That comment doesn't check."`.

Then, for `comment`: nothing more happens (still `202`) if the writer is the owner here or is blocked. Otherwise the
receiver keeps a "mention" notice if the record's `mentions` names the owner, or a "comment" notice if the owner has a
comment of their own taken on that list. Anything else is dropped. The notice names the writer by the name the owner
knows them by, else by their signed name, else "Someone".

For `change`: the record's author must be the caller (`400 "That isn't theirs to change."`). The receiver must hold a
copy of that event from that friend; with no copy, it answers `202` and does nothing. The new content must be an event
(`400 "That isn't a change to an event."`). The copy is updated, and the owner is told if the event moved or was
called off, unless they had answered "no".

**`gone`.** `item` must be an id. The receiver deletes its copy of that item from that friend, and the notices about
it. There is nothing to check: it only touches what that friend's own site sent. If `cancelled` is `true` (the sender says the event
was still to come), the copy is an event not already called off, and the owner hadn't answered "no", it keeps a "cancelled" notice and may tell their phones.

Source: `src/notes.js` `queueItemNote`, `queueChangeNotes`, `queueCommentNote`, `noteFor`, `receiveItem`,
`receiveComment`, `receiveChange`, `receiveGone`; `src/friendcopies.js` `keepItem`, `keepCopy`; `src/friendhost.js`
`itemForFriend`, `delegationsFor`, `peopleFor`.

### 9.3 Notes from a group's site

A group's site sends notes to its members' sites at the same address, in the same envelope. Members are those
approved with an identity. Section 10 covers when a group sends each one and the group rules behind them. What's
common with 9.2:

| Kind | As from a friend, plus |
|---|---|
| `item` | `people` and `names` (`{<person>: name}` from the members list, used only when nothing better is known); `here: true` for an @here post (9.5); `item.records` may include an admin's `calloff`. The post may be written by any member; its host is the group. |
| `comment`, `change` | `names`; the receipt is the group's. The host is the group, not the writer. A `change` must be by the event's writer as the receiver's copy has it. |
| `calloff` | group only: an admin, or the event's writer, calling an event off. With `date` (`YYYY-MM-DD`), one date of a repeating event, on that date's own list, where `entry.n` may be 1. The record's `date` must equal the note's. |
| `gone` | as from a friend |
| `closed` | group only: the owner's `close` on the group's members list (the list whose id is the group's person id), with the group's receipt. It must be by the group's owner. The receiver marks the group closed. |
| `report` | group only: `{v: 2, kind: "report", id, illegal}`, something raised with the admins (8.15). Nothing in it is signed or checked. The receiver keeps it only if the group's last word on its own role was `owner` or `admin`, and `id` is 16 to 64 base64url characters: as a notice in a budget of its own, 20 a day from one group, and on the phones for `illegal: true`, 3 a day from one group. |

Checks 1, 2 and 4 of 9.2 apply, with the group's hosting key and the group as host. Any member's comment is accepted
(the writer needn't be a friend), and the writer is named from what the receiver knows, else their signed name, else
`names`. A comment also makes a "comment" notice when the owner here wrote the post. The refusals are worded
differently: `"That isn't a post in this group."` for an `item`, `"That doesn't check."` for a record, and `"The
group's identity couldn't be checked."`.

Source: `src/groupcopies.js` `receiveGroupNote`, `groupClosed`, `dateCalledOff`; `src/groupposts.js` `groupNoteFor`,
`queueToPeople`.

### 9.4 Mention receipts: POST /_p/mention

Here is the case it covers. When W comments on H's post and mentions M, H's site may tell M (9.2), but only if M is
H's friend. And H could show M a different thread from the one it showed W. So W's own site also sends M the receipt
H gave W for that comment (section 8: the answer to `POST /_p/records`). M's site then checks that H shows M the same
thread at that point. W and M needn't be friends.

**Sending.** After a comment by the owner is taken on a friend's or a group's item, the owner's site queues a receipt
for each person in the record's `mentions`, apart from the host and the owner. It is sent to that person's address as
the sending site knows it from the identities it has learnt. With no known address, it isn't sent. It is also not sent
if the comment's words have been deleted since.

**Request.** A signed call from the writer's own site, signed by the writer's hosting key:

```json
{
  "v": 2,
  "kind": "receipt",
  "host": "<host's person id>",
  "item": "<list id: the post, or a photo in it>",
  "photo": { "post": "<post id>", "index": 1 },
  "sent": { "record": "<record bytes>", "sig": "<signature: 64 bytes, base64url>", "content": "…", "salt": "…" },
  "receipt": { "bytes": "<signed head bytes>", "sig": "<signature: 64 bytes, base64url>" },
  "delegation": { "bytes": "<delegation bytes>", "proof": { "…": "section 4" } },
  "people": { "<writer's person id>": { "chain": ["…"], "profile": { "…": "section 4" } } }
}
```

`photo` is optional (as in 9.2). `delegation` is the one delegation behind the record's key. `people` holds only the
writer.

**Answer.** Always `202 {"ok": true}`, whatever happens. Nobody can learn from it whom the owner is friends with, or
in which groups. The exceptions are refusals made before the handler runs: `413` for a body over 64 KB, and `429`
once the caller has used its day's allowance (section 2).

**Checks, in order.** Each one stops quietly if it fails:
1. `v` is `2`, `kind` is `"receipt"`, and `host` and `item` are ids.
2. `host` is an approved, connected friend of the owner here, or a group with an identity that the owner has joined.
3. The record (parsed, not yet verified) is a `comment` with that `host` and `item`. It isn't by the owner here, and
   its `mentions` includes the owner here.
4. The call is signed (section 2) by the record's author, whose identity this site must know already (from a thread
   they wrote in, say): nothing is fetched to check the call, so a stranger's call can't make the receiver reach out.
   Someone it doesn't know is told by the host's note instead. The author isn't blocked.
5. The record checks (section 5) as at now, with `delegation` accepted only for the record's own key.
6. The host's identity is known here and isn't frozen. `receipt` checks as the host's signed head for list `item`
   under the host's current hosting key.

Then the receiver keeps a mention receipt (`fp`, `n`, `head`, writer, state `unchecked`). It keeps a "mention" notice,
which is the same notice the host's own note would make: one per record, whichever arrives first. It may tell the
owner's phones.

**Checking the host.** Straight away, and again at each later read of that friend's or group's posts for up to
2 days (3 receipts at a time), the receiver reads the item's list from the host (section 8, `GET /_p/items/<id>`). If
entry `n` there has the same `fp` and running head, the receipt is `ok`. If it doesn't, the receipt is `hidden`, and
the owner gets a notice saying the host isn't showing them what it told the writer it took. If the host can't be
reached, it is asked again next time. After 2 days it is left unchecked.

Source: `src/receipts.js` `queueReceipts`, `receiptFor`, `sendReceipt`, `receiveReceipt`, `checkReceipts`,
`checkGroupReceipts`; `src/calls.js` `knownCalling`.

### 9.5 Mentions and @here on the wire

A mention is part of the signed record, never of the note. A record's `mentions` field is an array of up to 10 person
ids (section 5). Its content carries `mentions: [{name, person}]`, the names as written. When the browser makes a
record, it includes a person only if `@<name>` still appears in the text as a whole word: not followed by a word
character, and not preceded by a word character or `@` (`says`). Receivers decide whether they were mentioned only
from the signed `mentions` array.

Who hears about a mention:

| Where | Told by |
|---|---|
| a post | its host's `item` note, which every friend gets (only invited guests for an event; for a group, only those mentioned) |
| a comment on a post on site H | H's `comment` note, if the person is H's friend or a member of group H; and the writer's site's receipt (9.4), unless the person is H or the writer |

`@here` is group only (section 10). The post's signed content has `here: true`, and its text must say `@here`. The
group sends an `item` note with `here: true` to every member. The receiver treats it as @here only if both the note's
`here` and the signed content's `here` are `true`.

Source: `public/static/records.js` `pickedMentions`, `says`; `src/notes.js`; `src/groupcopies.js` `receiveGroupNote`.

### 9.6 Notices, phones and limits on the receiving side

A note that checks becomes at most one notice for the owner, per `(kind, record fingerprint)`. Repeats and retries
are harmless. Notices are kept for 60 days. The text is cut to 200 characters and the name to 100. Limits, each
checked in the same statement that keeps the notice (a notice over a limit isn't kept; the note is still answered
`202`):

| Limit | Value | Counted per |
|---|---|---|
| notices | 60 in 10 minutes, 500 in a day (not counting `report` notices) | sending friend's site, or group |
| `report` notices (9.3) | 20 a day; on phones, `illegal` ones only, 3 a day | group |
| notices set off by one writer | 20 a day | writer (record author), across all friends and groups |
| mentions reaching phones | 5 in 10 minutes, 20 a day | sending friend's site, or group |
| mentions and @here reaching phones by one writer | 5 a day | writer, across all friends and groups |
| @here reaching phones | the first in a day | group |
| calls of any kind | the caller's daily allowance | caller's identity (section 2) |

Phones are told only by the owner's own site, never by a friend's. The site sends Web Push messages, signed with its
own VAPID key and encrypted for each device, to the devices the owner has turned on. They are sent only for mentions,
@here, invitations, changes and calling off of events, and reports that something might be illegal (8.15, 9.3). A friend's note can at most make the receiving site decide
to do this, within the limits above.

Source: `src/notes.js` `keepNotice`, `tellMention`; `src/notify.js` `pushAllowed`, `writerMayBuzz`, `MENTION_PUSH`;
`src/limits.js` `LIMITS`; `src/push.js`.

### 9.7 Delivery: the Outbox

Notes and mention receipts are sent from a queue (the Outbox, a Durable Object), not during the request that caused
them. A queued note holds the recipient's connection or member id, or for a receipt their person id, never their
address. The address is looked up at sending, so a friend removed or a member who has left gets nothing more.

| Rule | Value |
|---|---|
| calls per run | 40 at most (a run is one alarm; the next is set for the earliest due item, at least 1 s later) |
| order in a run | retries that are due first, then each queued note's next recipients, oldest note first |
| timeout | 5 s for `/_p/notes`; 8 s for `/_p/mention` |
| redirects | not followed (a 3xx counts as refused) |
| sent from | a person's site: the address the note was queued at; a group's site: the group's own address |
| tried again | no answer, a timeout, `5xx`, `429`, `409` (a move not yet in effect there; notes only, not receipts), or the body couldn't be built just then |
| not tried again | any other non-2xx answer (`400`, `401`, `403`, `404`, `410`, `413`, …) |
| back-off | 60 s, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h between tries: 8 tries over about 44.6 hours, then given up |
| nothing to send | the recipient is no longer a friend or member, they aren't invited (any more) to the event, or the thing is gone: dropped, not retried |

A note to every friend (or, for @here and `closed`, every member) walks the friend list in id order, 40 at a time, as it stands
when sent. A note to chosen people walks a fixed list. Receivers must not rely on order: notes about one item can
arrive in any order, more than once, or not at all.

For an invitation (an `item` note to chosen guests), the sender records whether each guest's site took it,
was unreachable, or refused it, and shows the owner that on the event's guest list.

A `410` (moved) counts as final: the friend sees the post at their next read, from their new address. A note bigger
than a site takes (64 KiB) is sent without the post's `records` (its edits and changes: the friend's next read brings
them), and not at all if it's still too big.

Source: `src/outbox.js` `Outbox.sendNote`, `Outbox.sendNotes`, `prepareNotes`, `NOTE_RETRY_SECONDS`;
`src/receipts.js` `sendReceipt`; `src/calls.js` `callFriend`.

## 10. Groups

A group is a site of its own. It runs the same afterwrd code as a person's site, in group mode, and holds exactly one
group: its members list and its posts. Nobody signs in at a group's site. Everyone, its creator included, uses it from
their own site, through signed calls (section 2). The group knows each member by the address and identity they joined
with, and calls their sites back the same way.

A group has an identity (section 4) like a person's site, with one difference: it has no passkeys or recovery key of
its own. Its identity is owned by the person who made it (the group's owner), whose passkey signs it. With that
identity the group's site does what any host does: it numbers and signs lists (section 6), issues receipts, and signs
its calls with its hosting key.

### 10.1 What a group's site answers

A site is in group mode when its Worker has the secret `GROUP_KEY`. It then answers only these, and a plain 404 page for
anything else:

| Call | Who | What |
|---|---|---|
| `GET /.well-known/afterwrd` | anyone | the group's identity, with its owner's beside it (section 4) |
| `GET /_group/ping` | anyone | that it's running, its version, its hosting key (10.2) |
| `POST /_group/claim` | the creating site, once | becomes the group's owner (10.2) |
| `POST /_group/identity` | the claiming site, once | the group's first identity document (10.2) |
| `GET /_join/<token>` | anyone with the link | an HTML page asking where your site is |
| `GET /_join/<token>/info` | anyone with the link | the group, to sign a `join` by (10.4) |
| `POST /_join/<token>/accept` | a signed call | someone's signed `join` (10.4) |
| `GET /_group/members`, `GET /_group/members/list` | members | who's in, and the signed members list (10.6) |
| `POST /_group/records` | members, and people waiting | a signed record for the members list (10.7) |
| `GET /_group/admin/members`, `POST /_group/admin/*` | admins | running the group (10.8) |
| `GET /_p/items…`, `POST /_p/items`, `POST /_p/records`, `POST /_p/records/check`, `POST /_p/people` | members | its posts (10.9) |
| `POST /_p/report` | members | telling the admins (8.15) |
| `POST /_p/reports/check` | anyone, unsigned | what became of reports (8.15) |
| `GET /files/<sha256>?exp=…&sig=…` | a member's link | one photo (10.10) |
| `POST /_group/rejoin/point`, `POST /_group/rejoin`, `POST /_group/before` | sites of people in a group from afterwrd 1, for 30 days after it came over | bringing its members and posts over; not specified here |

POST bodies to `/_group/…` and `/_p/…` are refused with 413 above 64 KB before anything is read, as on a person's site
(section 2). `/_join/<token>/accept` reads at most 64 KB itself, and answers a bigger body with 400. A group's site has no daily run.

The group lives at local id 1. Where the code builds addresses for it (the `id` of its Group object), they are
`<group origin>/groups/1`.

Limits that apply throughout:

| Limit | Value | Where |
|---|---|---|
| Members besides the owner | 1,000 | `src/groups.js` `MAX_MEMBERS` |
| Requests waiting at once | 50 | `MAX_WAITING` |
| An unanswered request is dropped from the site's table after | 7 days | `WAITING_SECONDS` |
| An invite link lasts | 14 days | `LINK_SECONDS` |
| Requests one invite link can carry | 100 | `LINK_REQUESTS` |
| Entries in a members list | 20,000 | `src/members.js` `MAX_MEMBER_ENTRIES` |
| Group name / about / rules | 100 / 1,000 / 2,000 characters | `MAX_GROUP_NAME`, `MAX_GROUP_ABOUT`, `MAX_GROUP_RULES` |
| A post's text | 5,000 characters | `MAX_GROUP_TEXT` |
| A comment's text | 2,000 characters | `src/archive/comments.js` `MAX_COMMENT` |
| Photos in one post | 8 | `MAX_GROUP_PHOTOS` |
| One photo / one thumbnail | 8,000,000 / 1,000,000 bytes | `PHOTO_BYTES`, `THUMB_BYTES` |
| All the group's photos | 1,000,000,000 bytes | `GROUP_BYTES` |
| Posts from one member | 10 per 600 s, 50 a day, 40 photos a day | `POST_RATE` |
| @here | 3 a day per member, 10 a day for the group | `HERE_LIMITS` |
| A closed group goes on answering for | 30 days | `CLOSE_SECONDS` |

Source: `src/app.js` `route`, `routeGroup`; `src/groups.js` (constants).

### 10.2 Setting up: ping, claim, identity

A new group's site is set up in three calls from the owner's site, straight after that site has made it.

**`GET /_group/ping`.** Not signed. Always answered, even once the group has gone.

```json
{ "afterwrd": "group", "version": "2.0.0", "protocol": 2, "hosting": "<hosting public key: 32 bytes, base64url>" }
```

`hosting` is the group site's hosting key. The owner's site puts it into the group's identity document.

**`POST /_group/claim`.** A signed call from the owner's site. Body:

| Field | Type | Meaning |
|---|---|---|
| `setup` | string | the `GROUP_KEY` the owner's site made this Worker with |
| `name` | string | the group's name; trimmed, cut to 100 characters; required |
| `about` | string, optional | normalised (CRLF to LF, trimmed), cut to 1,000 characters; empty becomes null |
| `owner` | string | the owner's name as they call themselves; trimmed, cut to 100; "Someone" if empty |

Checks, in order: `setup` must equal `GROUP_KEY` (both are hashed with SHA-256 and the hashes compared), else 403. The
group must not be claimed already, or closed and emptied, else 409. The call's signature must check and must not be
from the group's own address, else 401. A missing name is 400.

The caller's address becomes the owner's row, as the only member, with role `owner`. Until the group has an identity,
this address is how the owner is recognised, and only for `POST /_group/identity`. The answer:
`{"id": 1, "name": "…", "about": "…" | null, "owner": "…"}`.

**The group's identity document.** The owner's site builds it from the ping:

```json
{"v":2,"kind":"identity","seq":0,"prev":null,"origin":"https://walkers.example.workers.dev","passkeys":[],"hosting":"<from the ping>","owner":"<owner's person id>"}
```

The bytes are `JSON.stringify` of exactly these fields in this order (section 3). `passkeys` is always empty and there
is no `recovery`: a document with `owner` and any passkey or recovery key is refused (`src/identity.js`). The owner
signs it in their browser with one of their passkeys registered at their own site's address: a passkey statement
(section 3) over the single fingerprint `fingerprintOf("identity", bytes)`, with a nonce from their site. The chain
sent is one entry: `{"bytes": "<base64url>", "sig": {"passkey": <statement>}}`. The group's person id is that
document's fingerprint, as for any identity (section 4).

**`POST /_group/identity`.** A signed call from the address that claimed the group. Body:
`{"chain": [<the one entry>], "owner": [<the owner's whole identity chain, same entry shape>]}`.

The group's site checks:

1. The caller's address is the owner's row, and that row has no identity yet; else 403.
2. The group has no identity yet; else 409.
3. `chain` is exactly one entry, and `owner` parses as a chain; else 400.
4. The owner's chain reads with no problem, isn't frozen, and its current `origin` is the calling address; else 400.
5. The document's `owner` is the owner's person id, its `origin` is the group's own address, and its `hosting` is the
   group's own hosting key; else 400.
6. The chain reads as a group's identity with the owner's beside it (section 4 `readIdentity`): signed by a passkey of
   the owner's identity. Else 400.

It then takes the identity as its own, starts the members list empty (`n` 0, head `""`, its id the group's person id,
its owner the owner's person id) and records the owner's person id on the owner's row. The answer:
`{"ok": true, "person": "<group's person id>"}`. A second attempt is refused with 403, since the owner's row now has an identity.

From then on the group publishes `{v: 2, chain, owner}` at `/.well-known/afterwrd` (section 4), and a reader checks the
group's chain with the owner's.

Source: `src/groups.js` `handleGroupApi`, `claim`; `src/groupidentity.js` `handleGroupIdentity`, `setGroupIdentity`;
`src/membership.js` `claimGroup`; `src/identity.js` `parseIdentity`, `readIdentity`.

### 10.3 The members list

Who's in a group is a list (section 6) the group hosts. It differs from an item's list in four ways:

- Its id is the group's own person id. Each of its records has `host` and `item` both set to that id.
- Its owner is the group's owner (the identity document's `owner`), who is always in and never joins.
- It's always read and checked whole, from entry 1. Checkpoints are written every 500 entries as for any list, but
  never offered for this one: who's in follows from every join and approval since the start.
- Removing someone never empties their `join`: it stays with its record, so anyone can check the list again later.

Its records (section 5 for the envelope):

| Kind | Signed by | `about` | Content | Effect |
|---|---|---|---|---|
| `join` | the person joining | none | `{"name": "<as they call themselves>"}` | they wait |
| `approve` | an admin or the owner | their `join` | none | they're in |
| `remove` | an admin or the owner | their `join` | none | a request turned down, or a member removed |
| `role` | the owner | a member's `join` | `{"role": "admin" \| "member"}` | their role |
| `leave` | the member, or someone waiting | none | none | they're out |
| `close` | the owner | none | none | the group is closed (10.13) |

The rules, from `src/members.js` `MemberRules.refuse`. These rules are used both by the group when it takes a record and
by a member's site when it reads the list. A record is refused if:

- it would be entry 20,001 or later (22,001 for a `leave`, `remove` or `close`, so a full list can still end: each
  needs someone in or asking, so they can't run on far past it);
- its fingerprint is already in the list ("duplicate");
- `host` or `item` isn't the group's id; it isn't one of the six kinds; or it's signed by the group's hosting key;
- the list has a `close` in it;
- its `seen` or `prev` is out of order (section 6 `Rules.order`). `seen` may be null only for entry 1;
- `join`: the author is the owner, or is in. Someone still waiting may ask again: their new `join` replaces the
  earlier one, which then counts as out;
- `leave`: the author is the owner ("close the group instead"), or neither in nor waiting;
- `close`: the author isn't the owner;
- `approve`, `remove`, `role`: the author isn't an admin or the owner; or
  - an admin's record must carry `role_at` (a point `{n, h}`): its `n` must be before this entry, `h` must be the
    list's running fingerprint at `n`, and nothing may have changed the admin's role or membership after `n`. This
    stops an admin who has lost the role acting on what they saw before. The owner's `role_at` is ignored;
  - `about` must be a `join` in the list whose person isn't out;
  - `approve`: they must be waiting;
  - `remove`: an admin can't remove another admin (only the owner can);
  - `role`: only the owner; the target must be in; `role` must be `"admin"` or `"member"`.

How the list adds up: a `join` makes its author waiting, with role `member`. A later `join` from the same person
replaces their earlier one. `approve` makes them in; `remove` and `leave` make them out; `role` sets their role. A person
who is out may `join` again. There's no per-person cap on this list, and its records don't count towards anyone's daily
records.

The owner's site's browser attaches `role_at` to every `approve`, `remove` and `role` it signs. It's the point in the
list the site last checked.

A `join` made by running the code with a test key (the record's bytes, decoded):

```json
{"v":2,"kind":"join","author":"05TDo8QXEb5aYNXFPVbhW0Og8fZTNu64W4vzwvEI_A4","host":"WATKJsi5qOj0Q0UqyZDs0L7taNFCiLkxd_JL4sPpDrk","item":"WATKJsi5qOj0Q0UqyZDs0L7taNFCiLkxd_JL4sPpDrk","seen":null,"prev":null,"key":"Tmp0tRA8KRA2y-IUAtONO1eYznM0mfZgQao5QChVnb0","body":"BWlvVLN8Dq2hIcVYN8Df1XBWx_is3oIio9lv7mOBZX8","at":1795427927}
```

Its content is `{"name":"Sam Taylor"}`, sent beside it with its salt. The group's receipt for it as entry 1, taken at
1795430400, is a signed head whose bytes are:

```json
{"v":2,"kind":"head","host":"WATKJsi5qOj0Q0UqyZDs0L7taNFCiLkxd_JL4sPpDrk","list":"WATKJsi5qOj0Q0UqyZDs0L7taNFCiLkxd_JL4sPpDrk","n":1,"head":"ubqjWIL4PJ0LQfFceN6EcCAqqtCu45jz2RQgbuQDsjA"}
```

(The ids here are fingerprints of placeholder bytes, not of real identity documents.)

Source: `src/members.js` `MemberRules`; `src/lists.js` `Rules.order`; `src/hosted.js` `rulesKind`, `readList`, `take`;
`public/static/ui/groupsign.js`.

### 10.4 Invite links and joining

An admin makes an invite link with `POST /_group/admin/link` (10.8): `<group origin>/_join/<token>`. The token is 32
random bytes in base64url (43 characters). The group keeps only its SHA-256, and only one link at a time: a new one
ends the old. A path is matched by `^/_join/([\w-]{40,100})(/info|/accept)?$`.

A link works while it's under 14 days old, has had fewer than 100 requests, and the group isn't closed or gone. Otherwise
the page answers 404 with HTML, and `/info` and `/accept` answer 404 with
`{"error": "This invite link has expired. Ask whoever sent it for a new one."}`.

**`GET /_join/<token>`** is an HTML page for a person's browser. It asks for their site's address and sends them
there. On their own site they confirm, and their site goes on from there.

**`GET /_join/<token>/info`.** Not signed. Answers:

```json
{ "id": 1, "name": "Walkers", "about": "Sunday walks", "rules": "Be kind.", "owner": "Ann Example",
  "person": "<group's person id>", "members": { "n": 12, "h": "<running fingerprint at 12>" } }
```

`rules` is null when the group has none (10.15). `members` is null while the members list is empty. The joiner's site refuses a group whose `person` isn't a 43-character
id. Its browser then signs a `join` with `host` and `item` = `person`, `seen` = `members`, `prev` = the fingerprint of
this site's newest record on that list the group took (or null), and content `{name}`. Before sending, the joiner's site
fetches the group's identity from the link's address and checks its person id is `person`.

**`POST /_join/<token>/accept`.** A signed call from the joiner's site. Body:

| Field | Meaning |
|---|---|
| `sent` | the signed `join`: `{record, sig, content, salt}` (section 5) |
| `delegation` | `{bytes, proof}`: the browser-key delegation behind it (section 4) |
| `profile` | optional: the joiner's signed profile (section 4) |

Checks, in order:

1. The link works (above), else 404.
2. The body parses and has `sent`; else 400.
3. One request is counted against the link, before anything is checked or fetched; at 100, 429.
4. Requests waiting more than 7 days are dropped from the site's table.
5. The call's signature checks (the caller's identity is fetched from its address if needed), else 401.
6. The calling address isn't already an approved member, else 409.
7. The record's `author` is the caller's person id, and `delegation` is a delegation from their identity that's
   current now and names the record's `key`; else 400.
8. It's a `join` with `item` the group's id, else 400.
9. Its author hasn't been removed from the group (10.15), else 403 `You can't join this group.`
10. Fewer than 50 are waiting, else 429.
11. The members list takes it (10.3), else 409 with the reason.

The joiner's name comes from the `join`'s checked content: trimmed and cut to 100 characters, or "Someone". A valid
`profile` is kept to pass on to other members. The answer:

```json
{ "ok": true, "id": 1, "name": "Walkers", "about": "Sunday walks", "receipt": { "bytes": "…", "sig": "…" }, "person": "<group's person id>" }
```

The joiner's site keeps the `join` and its receipt (10.14). The joiner now waits. They can make one call: take the
request back with a `leave` (10.7).

Source: `src/groups.js` `linkedGroup`, `handleJoinLink`; `src/groupmembers.js` `takeJoin`, `theirs`;
`src/membership.js` `linkInfo`; `src/groupjoin.js` `joinPoint`, `joinSigned`.

### 10.5 Members' sites and the group, calling each other

**A member calling the group.** Every call except ping, claim, identity, invite links, `/_p/reports/check` and the
calls for groups from afterwrd 1 must be a signed call (section 2) whose `Afterwrd-From` address is a member's row
that has an identity. The signature must check against the
hosting key of that same identity at that same address. The group never fetches anything for an address that isn't a
member's, so a stranger can't make it call out. The caller then comes under the day's allowance (section 2), charged to
their person id. The group's owner is exempt on their own group.

Answers before any route:

| Condition | Status | Body |
|---|---|---|
| the group has gone (10.13) | 410 | `{"error": "This group has closed."}` |
| not a member, or the signature doesn't check | 401 | `{"error": "Not a member of this group."}` |
| waiting, anything but `POST /_group/records` | 403 | `{"error": "Waiting for <owner's name> to let you in."}` |
| a `/_group/admin/` call from someone who isn't an admin | 403 | `{"error": "Only the group's admins can do that."}` |

A member is recognised by both their address and their identity. A member whose site moves to a new address isn't
recognised at the new one.

**The group calling a member.** A signed call from the group's address, signed with its hosting key, keyid the group's
person id, always `POST` with a JSON body. The member's site takes it only if `Afterwrd-From` is the address of a group
it has a row for, with an identity, that it has joined or asked to join, and the signature checks against that group's
hosting key. The call then comes under the allowance, charged to the group's person id. Otherwise: 401
`{"error": "Not a member."}` on `/_member/…`; on `/_p/notes` it's checked as a friend's note instead (section 9).

The group makes two kinds of call:

- `POST /_p/notes`: notes (10.12).
- `POST /_member/removed`: an admin removed this member, or turned down their request. The group sends it, once,
  without retrying, just before it drops their row. Body: `{sent, entry: {n, fp, taken, prev}, receipt, roles,
  delegations, people}`: the signed `remove`, where the group took it on the members list and its receipt, and for an
  admin's removal their `roles` proof (10.9) with the delegations and identities behind it. The member's site forgets
  the group, its copies and notices, only if this shows the removal for sure: a `remove` by the group's owner, or by
  an admin as the `roles` proof shows, of the newest `join` this site sent there, whose head worked out from `entry`
  is the one in `receipt`, signed by the group's current hosting key. It never forgets a group it made itself. It
  answers `{"ok": true}` either way.

Source: `src/groupmembers.js` `signedMember`, `callMember`; `src/groups.js` `tellRemoved`; `src/groupjoin.js`
`signedGroup`; `src/membership.js` `handleMember`, `removedForSure`; `src/notes.js` `receiveNotes`.

### 10.6 Reading who's in

**`GET /_group/members`** (members) and **`GET /_group/admin/members`** (admins) return an ActivityStreams Collection:

```json
{
  "@context": ["https://www.w3.org/ns/activitystreams", { "afterwrd": "https://afterwrd.app/ns#" }],
  "type": "Collection",
  "context": { "type": "Group", "…": "the group: below" },
  "totalItems": 2,
  "items": [
    { "type": "Person", "id": "https://ann.example/", "name": "Ann Example", "afterwrd:role": "owner",
      "afterwrd:joinedAt": "2026-11-01T09:00:00Z", "afterwrd:person": "<person id>" },
    { "type": "Person", "id": "https://sam.example/", "name": "Sam Taylor", "afterwrd:role": "member",
      "afterwrd:joinedAt": "2026-11-02T18:30:00Z", "afterwrd:person": "<person id>", "afterwrd:join": "<their join's fingerprint>" }
  ]
}
```

`items` is ordered owners and admins first, then by name. Members see only those in. Admins also see those waiting, and
each item gets `afterwrd:member` (the group's row number for them) and `afterwrd:waiting` (true or false), and
`afterwrd:before: true` for someone waiting who was in the group on afterwrd 1. Admins' answer also has
`afterwrd:removed`, who can't ask to join again (10.15). Fields with no value are left out.

The `context`, the Group object, also comes with every `GET /_p/items` pull (10.9):

| Field | Meaning |
|---|---|
| `type`, `id` | `"Group"`, `<group origin>/groups/1` |
| `name`, `summary` | name and about (unsigned: the group's word) |
| `afterwrd:rules` | its rules, if it has any (10.15) |
| `published` | when it was claimed (ISO 8601) |
| `attributedTo` | the owner: `{type: "Person", id: "<their site>/", name}` |
| `afterwrd:members` | how many are in, the owner included |
| `afterwrd:role` | the caller's role: `owner`, `admin` or `member` |
| `afterwrd:waiting` | admins only: how many are waiting |
| `afterwrd:people` | everyone in: `[{type, id, name, "afterwrd:person"}]`, for mentions |
| `afterwrd:hereAnyone` | whether any member may use @here |
| `afterwrd:mayHere` | whether the caller may |
| `afterwrd:closedAt`, `afterwrd:goesAt`, `afterwrd:close` | once closed: when, when it goes, the `close`'s fingerprint |

All of this is the group's own word, not signed (the signed list is below). Members' sites use it only to show the
group. Two uses go further: the person ids under `afterwrd:person`, which a member's site uses to pick who to mention;
and the addresses of those in, which a person's site uses to say a friend request comes from someone in the same group
(section 8). A member's site caps what it reads at 5,000 people.

**The signed members list** comes from **`GET /_group/members/list`**, as `{"afterwrd:list": …}`:

| Field | Meaning |
|---|---|
| `group` | the group's person id |
| `owner` | the group's owner's person id |
| `entries` | the list's entries from the start (section 6: `{n, fp, taken, head, sent?}`) |
| `signedHead` | the group's signed head on the list's end now |
| `checkpoint` | always null |
| `delegations` | `{<key>: {bytes, proof}}` for every record's key |
| `people` | `{<person id>: {chain, profile?}}` for the owner and every record's author |

With `?after=<n>`, `/_group/members/list` sends only the entries after `n`, still with a signed head on the end. Before
the group has an identity, it's null.

A member's site checks it like this. The group's identity must be known (or fetched from its address), match, and not be
frozen. It learns each identity in `people` and checks each profile. If there are no entries, `owner` must be the group
identity's `owner`. Otherwise it checks the list as section 6 `checkList` does, with the members-list rules, the
group's current hosting key, and `owner` equal to the group identity's `owner`; any problem refuses the whole list. A
site that has checked the list before asks only for what's after where it got to, and goes on from the rules as they
stood. If what comes back doesn't follow on, it reads the list whole again. Replies to the members calls may be up to
8 MB (others, 2 MB): a whole list at 1,000 members is about 4.6 MB.

Source: `src/groups.js` `groupObject`, `groupMembers`; `src/groupmembers.js` `signedMembers`; `src/groupjoin.js`
`checkMembers`, `checkedMembers`; `src/membership.js` `parseGroup`, `parseGroupMembers`, `call`.

### 10.7 `POST /_group/records`

A member's (or a waiting person's) signed record for the members list: `approve`, `remove`, `role`, `leave` or `close`.
Body: `{"sent": {record, sig, content?, salt?}, "delegation": {bytes, proof}}`, and for a `remove`, optionally
`"clear": true` (10.15).

Before signing, the member's site works out the record's `seen`, `prev` and `role_at` from the list as it last checked
it: `seen` = `role_at` = its last checked point, `prev` = its owner's newest record there. Someone still waiting can't
read the list. Their site uses its own receipt for their `join` instead: `seen` = that receipt's `{n, head}`, `prev` =
their newest record the group took, and no `role_at`.

Checks, in order:

1. The group has an identity, else 409.
2. `author` is the caller and the delegation is good (as in 10.4), else 400.
3. The kind is one of the five and `item` is the group's id, else 400
   (`"That isn't about this group's members."`).
4. The group isn't closed, else 409.
5. A `close` comes from the owner's row, else 403.
6. For `approve`, `remove`, `role`: `about` must be the `join` of someone in the group's table, else 404. For `leave`
   and `close`, the target is the caller.
7. `approve`: the group isn't full (1,000 approved besides the owner), else 409.
8. The members list takes it (10.3), else 409 with the reason. A refusal for a record already taken says `"duplicate"`.

Then the group's table follows the list: `approve` lets them in, `role` sets their role, and `remove` and `leave` drop
their row. A `remove` first sends `POST /_member/removed` to them (10.5), deals with any open reports about what they
wrote (8.15), and, if they were in, keeps them as removed and clears up if asked (10.15). A `close` closes the group
(10.13). The answer
is `{"ok": true, "receipt": <signed head>, "n": <entry number>}`.

The member's site keeps what it sent with the receipt (10.14). If a `leave` doesn't get through, it's kept and sent
again in the background, for up to 30 days (section 8), to the same path. An answer of 409 `"duplicate"` counts as
taken.

Source: `src/groupmembers.js` `takeMemberRecord`; `src/groups.js` `handleGroupApi`; `src/groupjoin.js`
`membersPoint`, `waitingPoint`, `relayGroupRecord`; `src/sentchecks.js` `resend`.

### 10.8 Admin calls

Admins are the owner and members whose role is `admin` in the group's table. That table follows the signed list. The
calls below other than `GET /_group/admin/members`, `end` and the two reports calls are refused with 409 `{"error": "This group has closed."}` once it's closed. Name, about,
@here and invite links are not signed records: they're the group's own settings, changed on an admin's signed call.

| Call | Body | Answer | Notes |
|---|---|---|---|
| `GET /_group/admin/members` | | as 10.6, with those waiting | |
| `POST /_group/admin/link` | `{}` | `{"link": "<origin>/_join/<token>"}` | replaces any earlier link |
| `POST /_group/admin/about` | `{"name", "about", "rules"?}` | `{"ok": true}` | name trimmed, cut to 100, required (400); about as in claim; `rules` as about, cut to 2,000, left as they were if absent (10.15) |
| `POST /_group/admin/here` | `{"on": true \| false}` | `{"ok": true}` | whether any member may use @here; anything but `true` means no |
| `GET /_group/admin/reports` | | `{"reports": [...]}` | what members have raised (8.15): one entry for each thing, every open one first, then those dealt with in the last 30 days, at most 200 things; never what's about the asker's own posts and comments |
| `POST /_group/admin/reports/leave` | `{"about", "word"?}` | `{"ok": true}` | looked at and left, with an optional word back (cut to 300); not for the asker's own |
| `POST /_group/admin/unremove` | `{"person"}` | `{"ok": true}` | someone removed may ask to join again (10.15) |
| `POST /_group/admin/end` | `{}` | `{"ok": true}` | owner only (403 otherwise); see 10.13 |

Anything else under `/_group/` is 404 `{"error": "Not found."}`.

Source: `src/groups.js` `handleGroupApi`; `src/membership.js` `admin`, `handleGroupActions`.

### 10.9 Posts on a group's site

A group's posts are items (section 7) the group hosts. Members write and sign them, as a friend's post is written and
signed by its owner. The calls have the same paths as a person's site's (section 8). These are the differences:

- **Who may call.** Members in the group (10.5), not friends. Every member sees every post: there are no audiences.
  An `item` with `audience` is refused.
- **What a post may be.** Content `type` is `"post"` or `"event"`. Its text must already be normalised (CRLF to LF,
  trimmed): if it isn't, the post is refused. At most 5,000 characters. A post needs text or photos; a poll needs its
  question. An event has no photos or poll and may repeat. Up to 8 photos.
- **The list rules** are `src/lists.js` `GroupRules`. Their `remove` and `calloff` differ from section 6:
  - `remove` (an entry or the whole post) comes from the group's owner or an admin, not the post's writer.
  - `calloff`, about an event, comes from an admin or the owner, or for one date of a repeating event, also from the
    event's writer.
  - An admin's `remove` or `calloff` must carry `role_at`. It's checked against the members list as for 10.3: the
    author must be an admin there now, `role_at.h` must be the list's running fingerprint at `role_at.n`, and their role
    unchanged since.
  - An admin can't remove, or call off, what the owner wrote.
  - The group itself, signing with its hosting key, may `remove` (clearing up, 10.15), but never `calloff`.
  - Removals and call-offs don't count towards the 20 records per person on a list.
- **`GET /_p/items?since=<t>`** answers as a person's does (50 a page, `more`, `until`, `gone`, `delegations`,
  `mine`), plus `people`, and:
  - `context`: the Group object (10.6), which a member's site uses to keep the group's name, its role and closing up to
    date;
  - `roles`: proof that the admins who called off events in these posts are admins (below);
  - `usage`: only to the owner, and only on Cloudflare: how busy the group's site has been this week, since it shares
    the owner's account.

  It has no `identity` or `profile`. With `since`, `people` and `delegations` hold only those new to the group's site
  since (less a minute). A member's site missing someone asks with `POST /_p/people`.
- **`GET /_p/items?before=<t>`**: the 20 posts made before `t`, newest first, with `more`; `until` null, `gone` empty,
  no `mine`. **`GET /_p/items?id=<id>`**: one post, the same way. Members' sites use these for older pages and links,
  and don't keep them.
- **Each item** is as a friend's site sends one (section 7). Its `records` also hold every `calloff` on it, and a
  `calloff` from each date of a repeating event that's been called off, with that `date`. A member's site works a
  post's state out from these signed records.
- **`GET /_p/items/<id>`** and **`GET /_p/items/<id>/dates/<date>`** answer as a person's do (`owner`, `entries`,
  `signedHead`, `checkpoint`, `delegations`, `people`, `?after=`). They add `roles` for everyone who removed something
  or called it off, other than the owner and the group itself. A date whose list hasn't started yet answers
  `{"v": 2, "empty": true}` if the event is still there.
- **`roles`** is `{<person id>: {"join": <their join, as sent>, "role": <the owner's newest role record making them admin>}}`.
  A member's site counts someone as an admin if their `join` is theirs and on this group's list, and the `role` is the
  owner's, about that `join`, with content `{role: "admin"}`. It takes the group's word that they were still an admin
  when they acted: only the group checks `role_at`.
- **`POST /_p/people`**: `{"people": [<id>…], "keys": [<key>…]}`, at most 200 of each. Answers
  `{"v": 2, "people": {…}, "delegations": {…}}`. A person's site doesn't have this call.
- **`POST /_p/items`** (a new post): body
  `{sent, photos: [sent…], files: [{src, thumbSrc}…], delegation, profile?}`. See 10.10 for photos and 10.11 for
  mentions. On top of the checks in section 7, it's refused:
  - with 429 past the posting limits or the group's room for photos;
  - with 429 past 200 records a day from that member across the group (not counting the members list);
  - with 409 once the group's closed.

  Answer: `{"ok": true, "id": "<post id>", "receipt": <signed head>}`.
- **`POST /_p/records`**: body `{sent, delegation, profile?}`. Allowed kinds: `comment`, `edit`, `delete`, `vote`,
  `answer`, `end`, `change`, `remove`, `calloff`. Group-specific refusals:
  - an event's words change only with `change`, not `edit`;
  - `calloff` is only for an event;
  - a photo can't be deleted or removed on its own, only its whole post;
  - a comment's or edit's mentions must name members (10.11);
  - once closed, everything but `delete` is 409.

  Anyone in the group may answer an event. Answer: `{"ok": true, "receipt", "n"}`, or
  `{"ok": true, "deleted": true, "n"}` when a whole post went.
- **`POST /_p/records/check`** answers as on a person's site (section 8). It also works while the group is closing.
  Removals by admins come with their `roles` proof.
- **`POST /_p/report`** and **`POST /_p/reports/check`** are as in 8.15. A member may report any member's post or
  comment but their own.

Source: `src/groupposts.js` `handleGroupItems`, `postTrouble`, `newPost`, `takeGroupPost`, `memberRecord`,
`memberItem`, `roleProofs`, `groupRules`; `src/lists.js` `GroupRules`; `src/groupcopies.js` `pullGroup`, `fillGaps`,
`groupThread`, `checkRoles`.

### 10.10 Photos in groups

A group keeps its own copy of every photo posted in it. It copies them from the member's site.

1. The member's site stores the photo and its thumbnail first. Its browser signs each photo as an item of its own (as
   on a person's site, section 7): content `type: "photo"` with `hash`, `thumb_hash` (SHA-256, hex), `width`, `height`
   and `size`. The post's content lists them in order under `photos`, each with its item id and those same five fields.
2. The member's site sends, for each photo, a plain signed link to each file on its own site:
   `files[i] = {src, thumbSrc}`, each `<member origin>/files/<hash>?exp=<seconds>&sig=<43 characters>`. These are good
   for one to two hours (section 8 for signed file links).
3. The group checks each photo:
   - it's an `item` by the member, hosted by the group, with `type: "photo"`;
   - its fingerprint and five fields match the post's list;
   - its hashes are 64 hex characters;
   - each link is exactly `<the member's own address>/files/<that hash>?exp=<1–12 digits>&sig=<43 characters>`;
   - width and height are 1–20,000, and size is 1–8,000,000;
   - the member's photos today plus these come to 40 or fewer;
   - the group's stored bytes plus each photo's `size` + 1,000,000 stay within 1,000,000,000.
4. The group takes the photos' records, then the post's. It then fetches each distinct file once:
   - `GET`, no redirects followed, 20 s timeout;
   - refused unless the answer is 2xx and any `Content-Length` is no bigger than the limit (8,000,000 for a photo, 1,000,000 for a
     thumbnail);
   - streamed into its store, cut off at the limit; the store refuses a file whose SHA-256 isn't its hash.

   If any file fails, the post and its photos are taken back (their lists become tombstones) and the call answers 400.

The member's site then lets its own copies of those files go. Members' sites never fetch photos from each other: every
member gets them from the group.

The group gives each member their own links to its files in what it sends them: `<group origin>/files/<hash>?exp=…&sig=…`.
These are friend-style links (section 8) keyed by the member's row number. They last until the end of the next UTC day
and work only while that member is in. Anyone else's request for a file is refused.

Source: `src/groupposts.js` `newPost`; `src/groups.js` `copyPhotos`; `src/groupcopies.js` `postSigned`;
`src/friends.js` `signedLink`; `src/share.js` `signedFile`, `signedFor`.

### 10.11 Mentions and @here

A post, comment or edit in a group may mention people (the record's `mentions`, with `{name, person}` pairs in its
content, section 7). The group refuses one if:

- the content names anyone the record doesn't list;
- a name isn't in the words;
- anyone listed isn't in the group (approved, or the owner), or is the writer.

**@here** is content `"here": true` on a new post whose words say `@here`. Content with `here` set to anything but
`true`, or without `@here` in its words, is refused. On a new post the group also checks:

- whether the writer may use it. The owner and admins may; others only if the group's `here_anyone` setting is on
  (`POST /_group/admin/here`). Otherwise 403.
- the allowance: 3 a day for each member, and 10 a day for the group. Uses by admins and the owner count towards the
  group's 10, but they aren't held to it. Over the allowance, 429.

A post with @here goes as an `item` note with `here: true` to every member (10.12). A post without it goes as an `item`
note only to those it mentions. Mention receipts (section 9) are sent by the writer's own site, with the group's
receipt, not by the group.

Source: `src/groupposts.js` `wrongMentions`, `takeHere`, `newPost`; `src/groupcopies.js` `relayToGroup`.

### 10.12 Notes a group sends

A group sends fat notes to members' `POST /_p/notes` through the same outbox, retries and signed calls as a person's
site (section 9). They go only to members who are in (approved, with an identity). Each body is `{v: 2, kind, …}`.
The member's site answers 202 `{"ok": true}`, and ignores notes about its own owner's records.

| `kind` | Sent when | To | Body (besides `v`, `kind`) |
|---|---|---|---|
| `item` | a new post that mentions people | those mentioned, not the writer | `item` (as in 10.9, with this member's photo links), `here: false`, `delegations`, `people`, `names` |
| `item` with `here: true` | a new post with @here | every member | as above |
| `comment` | a comment on a post or photo | the post's writer, everyone who has commented there, and those mentioned, not the writer | `item`, `photo?`, `entry`, `receipt`, `delegations`, `people`, `names` |
| `change` | an event's writer moved it, or called it off with `change` | those going or who might | as `comment` |
| `calloff` | an admin called off an event, or one date of one (which the event's writer may also do) | those going or who might (to that date), not the writer | as `comment`, with `date` for one date |
| `report` | a member raised something with the admins (8.15) | the owner and admins, apart from whoever wrote what was raised | `id`, `illegal` (true for "might be illegal": the admin's site may buzz their phones, 3 a day from a group at most). What it is, and who raised it, only from `GET /_group/admin/reports` |
| `gone` | a whole event still to come was deleted or removed | those going or who might | `item`, `cancelled: true` |
| `closed` | the owner closed the group | every member | `item` (the group's id), `entry`, `receipt`, `delegations`, `people` |

Fields:

- `entry` is `{n, fp, taken, prev, sent}`: the record's place in its list, with `prev` the running fingerprint just
  before it (`""` at entry 1). `item` is the post (or photo) id. For one date of a repeating event it's the event,
  and `date` is the date. `photo` (for a comment on a photo) is `{post, index}`, with `index` counted from 1.
- `names` is `{<person id>: <name>}`: the name each signed into their `join`, or the owner's. A member's site uses it
  only for someone it has no better name for.

A member's site checks a `comment`, `change` or `calloff` note:

- `entry.n` is at least 2 (at least 1 on a date's list), and the fields are well formed;
- the running fingerprint worked out from `prev`, `n`, `fp` and `taken` is the one in `receipt`, which the group's
  hosting key signed for that list;
- the record checks (section 5) as of `taken`, its fingerprint is `entry.fp`, and its kind, host, item and date match
  the note's;
- a `change` must come from the event's writer, as its copy has it;
- a `calloff` is applied only if it's by the event's writer or the group's owner, or by an admin whom `roles` in the
  note proves (10.9). A group doesn't send `roles` in notes, so an admin's call-off is answered 202 and left for the
  next pull, which checks the whole post.

It checks a `closed` note the same way on the members list, and its record must be a `close` by the group's owner (as
the group's identity names them). An `item` note's item is checked as a pull's are (section 8 `keepCopy`).

A group never sends a plain `gone` for a post that was deleted or removed. Members learn of those from the next pull's
`gone`.

Source: `src/groupposts.js` `groupNoteFor`, `sameForMembers`, `queueToPeople`, `queueComment`, `answering`;
`src/outbox.js` `prepareNotes`, `sendNote`; `src/groupcopies.js` `receiveGroupNote`, `groupClosed`, `dateCalledOff`.

### 10.13 Closing a group

The owner closes a group with a signed `close` on its members list, sent to `POST /_group/records`. Once the group
takes it:

- it's closed from the `close`'s `taken` time, and its invite link is deleted;
- every member is sent a `closed` note (10.12). A member who misses it learns from `afterwrd:closedAt` and
  `afterwrd:close` in the next pull;
- for the next 30 days it's read-only. Members can still read who's in, posts, threads and dates, ask what became of
  their records, and delete their own records with `delete`. Everything else is refused: a new post, other records,
  members-list records (`leave` included), `POST /_p/report`, and admin calls other than reading the members and the
  reports calls. A refused call gets 409 `{"error": "This group has closed."}`;
- after those 30 days, the first call to `/_join/…`, to `/_group/…` (other than ping, claim, identity and the calls
  for groups from afterwrd 1) or to `/_p/…` (other than `/_p/reports/check`) empties it. Its posts, photos, lists,
  members and links all go, with reports made there (8.15), their caps, and the list of who was removed (10.15); a mark
  that it's closed stays, so it can't be claimed again. `/_p/reports/check` still answers, with nothing. From then on,
  `/_join/…` answers 404, and the rest of `/_group/…` and `/_p/…` answer 410
  `{"error": "This group has closed."}`.

`POST /_group/admin/end` from the owner answers 409 while the 30 days are running. Once they're over it answers
`{"ok": true}`, because the group has emptied itself already. The owner's site calls it just before deleting the group's
Worker. After the group has gone, `end` answers `{"ok": true}` to any caller, member or not.

Members' sites stop pulling from a group 30 days after it closed, and delete their copies of its posts then.

Source: `src/groups.js` `closed`, `empty`, `groupGone`, `handleGroupApi`; `src/groupsites.js` `askToEnd`;
`src/groupcopies.js` `pullGroups`, `groupClosed`.

### 10.14 What a member's site keeps

A member's site keeps, for each group:

- **What it sent.** Every record its owner signed for the group (posts, photos, comments and the rest, and its
  members-list records) goes in its `sent` table with the group's receipt. A record the group refused isn't kept, except a `delete` or
  `leave`, kept to send again; one with no answer is kept as unsure. These
  matter on the wire in three ways:
  - each new record's `prev` is the newest of these the group took, on that list;
  - a waiting person's `seen` comes from their `join`'s receipt (10.7);
  - the site asks the group about them with `POST /_p/records/check`, and compares the group's `mine` with them
    (section 8). Deletes and leaves that didn't get through are sent again.
- **Copies of posts.** Up to the newest 50 posts, any event still to come, and any post its owner sent a record to
  in the last 30 days. Each copy's first record is checked as it arrives. Copies are asked for with `since`: when the
  group's page opens, and in the background at most hourly, up to 3 pages a pull. Older posts are read with `before`
  and checked, not kept.
- **Checked lists.** The members list, and each post's list, as far as it has checked them, so it next asks only with
  `?after=`.
- **The group's row:** its address, its person id, the owner's name, its own role, and when the group closed. The
  role and the owner's name are the group's word, from the Group object. When the group closed is the group's word
  until a signed `close` arrives; then it's the `close`'s `taken`.

The site forgets the group, its copies and notices, when the group takes its `leave`, or when the group tells it it was
removed. Once the group has gone, it's forgotten when the owner here takes it off their list. The site's own copies of
what it sent stay.

Source: `src/groupjoin.js` `keepSent`, `relayGroupRecord`; `src/groupcopies.js` `pullGroup`, `trim`, `pullGroups`,
`postSigned`, `relayToGroup`; `src/membership.js` `refresh`, `forgetGroup`; `src/sentchecks.js` `keepSent`.

### 10.15 Rules, removed members, and clearing up

Added for safety (docs/safety-plan.md 3.4); a group's site from before answers as it did, and members' sites cope.

- **Rules.** `POST /_group/admin/about` also takes `rules` (at most 2,000 characters; empty clears them). The group
  object (10.6) carries them as `"afterwrd:rules"`, and `GET /_join/<token>/info` as `rules`, so the joiner's site shows
  them before they ask ("By asking to join, you agree to them").
- **Removed stays removed.** When an admin's `remove` takes out a member who was in (not someone only asking), the
  group keeps their person id. A later `join` from it is refused: `POST /_join/<token>/accept` answers 403 `You can't
  join this group.`, whatever the link. Leaving doesn't count. Admins see who's there in `GET /_group/admin/members`
  as `"afterwrd:removed": [{"afterwrd:person", name, "afterwrd:removedAt"}]` (the newest 200), and `POST /_group/admin/unremove`
  `{person}` lets them ask again.
- **Clearing up.** `POST /_group/records` with a member's `remove` may carry `clear: true`. Once the removal is taken,
  the group removes everything that person wrote there with its own hosting key, as `GroupRules` lets a host: each of
  their posts whole (photos and comments with it), and each of their comments on others' posts. Readers show these as
  removed by the group. They aren't held to the per-person cap. The member is out before any of it starts; it goes 300
  at a time, carrying on whenever an admin next reads `GET /_group/admin/members`.

Source: `src/groups.js`, `src/groupmembers.js` `takeJoin`, `takeMemberRecord`; `src/groupposts.js` `clearUp`.

## 11. Site checks

A site can't vouch for itself. Tampered code can answer any question about itself with a copy of the real code. So
evidence about a site on Cloudflare comes from Cloudflare's API, read with a read-only token the site's owner allowed,
and the comparison runs on another site: the checker's. The site checked never handles the token used to check it in
a check by link, and never sees the checker's working in either kind of check. The code is compared with releases
signed with afterwrd's release key.

Checks apply only to sites on Cloudflare, at `https://<script>.<account-subdomain>.workers.dev`. A self-hosted site
can't be checked, and every `/_p/check-*` or `/_p/checked` call from a friend whose address isn't on workers.dev gets `404
{"error": "Not found."}`, as if the call didn't exist. A self-hosted site answers every one of them with a plain-text
`404 Not found`.

There are two kinds of check:
- **By link.** A person is present. The checker makes a one-time link and the person opens it. Cloudflare asks them to
  allow read-only access, and the checker's site reads the result.
- **Automatic.** Nobody is present. A site whose owner allows it keeps a lasting read-only grant and hands a friend's
  site a one-hour token on request. Friends' sites check each other a few times a week.

### 11.1 Signed releases

The list of releases a site may run is published at
`https://raw.githubusercontent.com/afterwrd/afterwrd/main/signatures/index.json`:

```json
{
  "seq": 28,
  "releases": [
    {
      "version": "0.58.2",
      "manifest_sha256": "89e6e15a630743f1d6f7359aa776d95ec9e86608840b5a92ad0a3ad76fb237b7",
      "signed_at": "2026-11-18T11:51:53Z",
      "etag": "303a77f76794802cda84948958b5cf964b61532d7427a7ef3c353eba09f55a4e"
    }
  ],
  "signature": "<Ed25519 signature: 64 bytes, standard base64>",
  "signature2": "<Ed25519 signature: 64 bytes, standard base64>"
}
```

(The release entry is real. The real list has many more.)

| Field | Format |
|---|---|
| `seq` | integer ≥ 1. It goes up at every signing. A site never accepts a list whose `seq` is lower than one it has seen. |
| `version` | `\d+.\d+.\d+` |
| `manifest_sha256` | 64 lowercase hex: SHA-256 of the release's `manifest.json` bytes |
| `signed_at` | `YYYY-MM-DDTHH:MM:SSZ` |
| `etag` | optional, 64 lowercase hex: Cloudflare's fingerprint of the release's code (`resources.script.etag` of a version uploaded with exactly that code and settings) |
| `signature` | Ed25519 over `signedText`, standard base64 with padding (88 characters) |
| `signature2` | Ed25519 over `signedText2`. Required when `seq` ≥ 9, and checked whenever it is present. |

The signed bytes are UTF-8 text, with each release in the list's order and a newline after every line:

```
signedText  = "afterwrd releases\n"   + seq + "\n" + for each release: version " " manifest_sha256 " " signed_at "\n"
signedText2 = "afterwrd releases 2\n" + seq + "\n" + for each release: version " " manifest_sha256 " " signed_at " " (etag or "-") "\n"
```

The public key is `package.json` `afterwrd.releaseKey`: 32 bytes as standard base64,
`jWNP4nrIYvCKiaHm2PXOy9lx2wobn4m7FjWWZARyEK8=`. A list is refused as a whole in any of these cases: it is over 256,000
characters, it has more than 200 releases, any field is malformed, or either signature fails. An `etag` counts only
when `signature2` covers it.

A release's `manifest.json` is at `https://github.com/afterwrd/afterwrd/releases/download/v<version>/manifest.json`. A
check uses these fields from it:
- `modules`: `[{name, sha256, type}]`, the Worker's code files;
- `assets`: `[{path, …}]`, the site files;
- `compatibility_date` and `compatibility_flags`.

The code carries the SHA-256 of every site file and serves a file only if its bytes match. So checking the code
covers the site files too, provided every request for them reaches the code (11.2, the last row).

Source: `src/signing.js` `signedList`, `signedText`, `signedText2`; `src/static.js` `serveStatic`;
`scripts/release.mjs`; `scripts/sign.mjs` `etagOf`.

### 11.2 What a check compares

The checking site reads Cloudflare's API (`https://api.cloudflare.com/client/v4`) with the token, `GET` only:

| Read | What's required |
|---|---|
| `/accounts` (first 5), then `/accounts/<a>/workers/scripts` in each | exactly one account has a Worker named `<script>` (otherwise the result is `missing` or `several`) |
| `/accounts/<a>/workers/subdomain` | the account's workers.dev name is the address's second label, so a token for another account can't stand in |
| `…/scripts/<script>/subdomain` | `enabled` is true |
| `…/scripts/<script>` | the code, as `multipart/form-data`. Each part's SHA-256 must equal the manifest's `modules` entry of that name, with none extra or missing. The version is read from `index.js`, from the bundled `name: "afterwrd-worker", version: "x.y.z"`. |
| the signed list (11.1) | that version is in it, and the downloaded manifest's SHA-256 is its `manifest_sha256`. The version isn't older than a known security fix. |
| `…/script-settings` | no tail consumers, no Logpush, no log destinations |
| `…/deployments` | one version serving 100% of traffic |
| `GET <site>/_version` on the site itself (public, `{"id": <version id>}`) | equals the serving version's id, so the Worker read is the one answering at the address |
| `…/versions/<serving id>` | `resources.script.etag` equals the signed `etag` for that version. Bindings are exactly `assets ASSETS`, `d1 DB`, `durable_object_namespace MEDIA MediaStore`, `durable_object_namespace OUTBOX Outbox`, `version_metadata VERSION`, plus, if present, the secrets `SETUP_CODE`, `UPDATE_TOKEN` and `OUTBOX_KEY` (the key every call to the site's own objects carries, so another Worker bound to them gets nothing). Neither `MEDIA` nor `OUTBOX` names another Worker (`script_name`) or another class: the signed code wired to someone else's objects would otherwise pass (since 2.3.2). `script_runtime`'s compatibility date and flags are the manifest's. `script_runtime.assets` has `raw_run_worker_first: true` and `serve_directly` not true, so every request reaches the code (Cloudflare's etag doesn't cover this setting or the site files). |
| up to 8 other Workers' deployments and serving versions | none is bound to the site's D1 database, or to its Durable Objects: a `durable_object_namespace` binding naming the site's Worker (`script_name`) or one of its namespaces (`namespace_id`). More than 8 other Workers is reported. |
| `HEAD <site><path>` for the manifest's private site files (up to 25 in a check by link; up to 44, in a step of its own, in an automatic check), unsigned in, no redirects followed | none answers `200` |

A check by link also reads the account's audit log (11.3). An automatic check reads every upload since the last
complete check instead (11.4).

Source: `src/checks.js` `checkSite`, `siteFiles`, `BINDINGS`; `src/app.js` (`/_version`).

### 11.3 Check by link

This flow runs between the checker's site and the checked person's browser. No call passes between the two sites
until the end.

1. The site owner who wants a check sends `POST /_p/check-request` to a friend (11.5). The friend's Home shows the
   request. The friend makes a link, `<checker>/_check/<token>`: a 43-character random token, kept only as its
   SHA-256, usable once, for 14 days, with at most 20 unused links at a time. They send it back by message, outside
   afterwrd. A link can also be made for any address, or none.
2. The person opens the link and presses start. The checker's site redirects them through afterwrd's relay page
   (`https://afterwrd.app/connect/`) to Cloudflare's OAuth, with PKCE. The relay chooses the scope from the return
   path, so `/_check/done` only ever asks for `workers-scripts.content_read account-settings.read`.
3. The code returns in the URL fragment, and the page posts it to `POST /_check/finish` on the checker's site. That
   site swaps it for an access token and runs 11.2. The token is never stored in the database. It waits up to
   10 minutes in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie on `/_check` in the person's own browser, while the
   page calls `POST /_check/audit` for each page of the audit log (500 entries, newest first, from an hour before the
   Worker was made until now).
4. Audit entries made through OAuth that afterwrd itself does (uploading, deploying and scheduling the site's Worker
   or its groups' Workers, making or deleting databases, setting a new account's workers.dev name within 5 minutes of
   the Worker being made) are counted. Anything else done through OAuth or the API is listed: on the site's own Worker,
   database or account as unexpected, and on other Workers and databases separately.
5. If the result is "all good" and the site checked is a friend, the checker sends it `POST /_p/checked` (11.5).

Source: `src/checks.js` `makeCheckLink`, `start`, `finish`, `auditStep`, `readAuditPage`, `expected`, `tellChecked`;
`src/cloudflare.js` `relayLink`, `exchangeCode`; `installer/connect.html`.

### 11.4 Automatic checks

**The site checked** allows it once. Its owner goes through the relay with the return path `/_cloudflare/checks-done`,
which asks for `offline_access workers-scripts.content_read`. The site keeps the refresh token only if Cloudflare's
answer names a `scope` with nothing outside those two. It is kept in the Outbox's vault object, never in the database.
On `POST /_p/check-token` the site hands out an access token from it. It reuses the token already handed out while
that has more than 40 minutes left, because refreshing would end a check under way. Otherwise it refreshes, keeping
the new refresh token. The token's lifetime is the one Cloudflare gives, capped at one hour. If Cloudflare refuses
the refresh with `400` or `401`, the grant is forgotten.

**The checking site** runs after its daily automatic-update run. It needs automatic updates on and checking not
turned off, and it must have a signed list no older than the newest it has seen. It picks friends on Cloudflare,
never one it checked in the last day:
- up to 2 that sent `check-soon` in the last 3 days and haven't been checked since;
- with probability 3/7, the friend checked least recently, so each site gets about three regular checks a week.

For each friend picked:
1. It calls `POST /_p/check-token`. A refusal, a `409 {off: true}` or a missing token is recorded as "couldn't check".
   Three in a row after an earlier success show on the checking owner's Home. A `429` (the site's checks for the day
   are used up, or it is busy) is recorded the same way but marked busy: a run made only of busy answers shows on Home
   only once it's five long.
2. It checks the code and setup (11.2), with the account tie. It doesn't read the audit log.
3. It reads every version uploaded, and every deployment made, since the start of the last complete check of that
   friend. It looks no further back than the first release signed with an etag. It reads at most 100 listed versions,
   and looks at no more than 30. Each must have an `etag` in the signed list, otherwise it is reported as an unknown
   upload, and `script_runtime.assets` as in 11.2, otherwise it is reported as letting files past the code (`files: true`), and its storage bindings as in 11.2,
   otherwise it is reported as wired to another Worker (`wired: true`, since 2.3.2). Putting an old upload back live makes no new version, so deployments are looked at too.
4. It checks the site files against the signed release's manifest. The manifest is downloaded again, must be at most
   2 MB, and its SHA-256 must be the signed one.
5. It tells the friend's site the result: `POST /_p/checked` if all good, otherwise `POST /_p/check-failed` with
   finding codes.

Each part runs in a request of its own to the checking site's own address, so each has its own allowance of
outgoing calls. These are internal and not part of the protocol.

Source: `src/friendchecks.js` `handleChecksConnect`, `letOn`, `giveCheckToken`, `checkAccess`, `runFriendChecks`,
`whoToCheck`, `checkFriend`, `uploadsSince`, `friendCheckStep`.

### 11.5 The calls

All are signed calls from a friend's site (section 2), answered only to approved friends on Cloudflare. Each answers
`400` if `type` isn't the one shown.

| Call | Body | Answer | Effect and limits |
|---|---|---|---|
| `POST /_p/check-request` | `{"type": "CheckRequest"}` | `200 {"ok": true}`; `400` if `type` is wrong | Shows "please check my site" on the owner's Home. One per friend, refreshed at most hourly, 50 at most in all, gone after 14 days. Sent only when the sender's code was uploaded more than an hour ago. |
| `POST /_p/check-token` | `{"type": "CheckToken"}` | `200 {"token": "<Cloudflare access token>", "until": <seconds>}`; `409 {"error", "off": true}` if not allowed or the grant is lost; `429` over the limit | 2 tokens a day to one friend's site, 12 to all (rolling 24 h, counted atomically). A refused request is remembered (at most one write a day per friend) to show the owner who tried. |
| `POST /_p/check-soon` | `{"type": "CheckSoon"}` | `200 {"ok": true}` | "I've just been updated, please check me soon." Sent after an update to 2 random friends on Cloudflare, if the sender allows checks. Ignored if the receiver has checking turned off. |
| `POST /_p/checked` | `{"type": "Checked", "site": "<receiver's own address>", "version": "x.y.z"}` | `200 {"ok": true}`; `400` if `site` isn't the receiver's address | A pass, from a check by link or an automatic one. It is the friend's word: kept at most once an hour per friend, the newest 10 kept, shown as "last checked by". It clears an earlier failure from the same friend. |
| `POST /_p/check-failed` | `{"type": "CheckFailed", "site": "<receiver's address>", "version": "x.y.z" \| null, "found": ["code", …]}` | `200`; `400` if `site` is wrong or no known code is given; `403` if the receiver hasn't handed this friend a token in the last 2 hours | Kept at most once an hour per friend, the newest 10 kept, and shown on Home in the receiver's own words for each code. Up to 6 codes; unknown codes are ignored. |

`version` is kept only if it matches `\d{1,4}.\d{1,4}.\d{1,4}`. The finding codes:

| Code | Meaning |
|---|---|
| `missing` | the account has no Worker for the site |
| `several` | more than one account allowed has one |
| `unreadable` | Cloudflare wouldn't hand over the code |
| `code` | the code isn't the release it says it is (also sent when nothing more specific applies) |
| `serving` | the serving version's etag isn't the signed one, or there's no signed etag for that version |
| `unsigned` | the version isn't in the signed list |
| `upload` | an upload or deployment since the last check wasn't a signed release |
| `too-many` | too many uploads since the last check to look at them all |
| `account` | the account's workers.dev name isn't the address's |
| `setup` | bindings, logging, traffic split or compatibility settings aren't afterwrd's |
| `files` | Cloudflare serves some site files without the code checking them |

Free text from the checker never reaches the receiver's pages: only codes, which the receiver turns into its own words.

Source: `src/friendcalls.js` `handleFriendCalls`; `src/checks.js` `askForCheck`, `receiveCheckRequest`,
`receiveChecked`; `src/friendchecks.js` `giveCheckToken`, `askFriendsToCheckSoon`, `receiveCheckSoon`,
`receiveCheckFailed`, `findingCodes`, `FOUND`.

## 12. Security considerations

### 12.1 What's trusted

- **Your own site is honest to you.** If it has been taken over, anything it shows its owner can be false. Friends'
  site checks (section 11) are what catch that.
- Ed25519, SHA-256, TLS and WebAuthn hold, and passkeys and the devices holding them belong to their owners.
- Cloudflare (or whoever runs a self-hosted server) runs the code it's given and doesn't read or change people's
  data. It could; nothing here stops it reading.
- The release key stays offline, and its holder signs only releases they have rebuilt and checked (section 11.1).
- Clocks are right to within a few minutes: signed calls allow 5 either way (section 2.3).
- Friends are chosen. A friend can always see, copy and pass on what's shared with them.

### 12.2 What the design guarantees

- **No forged words.** A record checks only with a signature by a browser key that one of the author's passkeys
  delegated, as their identity stood when the host took it (sections 4 and 5). A host, a friend, a group or anyone
  passing a record along can't make one that checks.
- **No quiet edits, drops or reordering.** Each list entry's running head covers everything before it, and readers
  recompute every head and check the host's signature on the end (section 6). A host that rewrites anything a reader
  has already checked shows up as a fork to that reader (6.11). An emptied entry must be explained by a signed
  `delete` or `remove` in what the reader reads; otherwise the list doesn't check (`unexpected`).
- **Records stay where they belong.** A record names its host and item, and its fingerprint is its id, so it can't be
  replayed onto another list or another site, and a second copy is a `duplicate`.
- **Hosts are caught out by their own receipts.** A writer keeps the host's signed receipt for each record and asks
  later what became of it (section 8.11); mention receipts let a third person check the host showed them the same
  thread (section 9.4). A host's `mine` list lets a writer see records signed as them that their own site never sent.
- **Slow identity changes.** Removing a passkey, changing the recovery key or moving takes effect 7 days after each
  reader first sees it, and the recovery key can cancel a change made with a stolen passkey (section 4.4). Two
  different documents at the same place freeze the identity at that reader.
- **Signed calls are bound to their receiver and moment.** `@target-uri` must be the receiver's own address and
  `created` within 5 minutes, so a call can't be sent on to another site or kept for later.

### 12.3 What it doesn't guarantee

- **A host can refuse anyone's records**, quietly. The writer is told; other readers aren't. It's the host's item or
  group.
- **A host can show different people different versions** of a conversation if they never compare notes. The `seen`
  rule (5.6) means a record from one version can't join the other without showing, and receipts and mention receipts
  catch the cases where a writer or someone mentioned is shown something else, but two readers who each only read
  their own version won't find out.
- **The newest entries can be rewritten** by a host until someone has checked past them.
- **`taken` times are the host's word.** Readers don't check that they rise or that they're in the past. The edit
  window and a poll's closing go by them.
- **A host can invent people.** Signatures stop it forging real people, not making new identities that comment, vote
  or join. Pages show people the reader doesn't know by their signed name, and warn when it looks like a
  friend's.
- **A group's members take the group's word about some things**: that an admin still held the role when they acted
  (only the group checks `role_at`), and the group's name, about and settings, which aren't signed.
- **A host sees who reads what.** Every read is a signed call naming the reader, and photos load from the host.
- **Signed words are provable.** A copy of a record, a fat note or a receipt proves who wrote what, for good. Honest
  sites drop deleted words; a dishonest one keeps them. Content is salted (5.1), so a deleted short comment can't be
  guessed from its record.
- **Replays within 5 minutes.** Signed calls carry no nonce. The same call can be sent again to the same site, with the
  same body, while `created` is within 5 minutes. Records are idempotent: a record is known by its
  fingerprint, and a repeat is a `duplicate`. A replay still counts against the caller's allowance, and a replayed
  `POST /_join/…/accept` uses up one of the link's 100 requests.
- **Passkey proofs are only as fresh as the site that asked for them.** The signing site makes each nonce and spends it
  once; a reader checking a stored proof later can't tell when it was made (3.6).
- **Links to files are bearer links.** Anyone holding a per-friend link can load the file until it expires (24 to 48
  hours), though it stops at once if the friend is removed. The longer plain links for an owner's profile picture and
  cover work for anyone who has them for up to 7 days (8.12).
- **An automatic site check hands over a read token.** It lets the checking site read the code of every Worker in the
  checked site's Cloudflare account, not only afterwrd's, for up to an hour (11.4). That is one reason to keep afterwrd
  in a Cloudflare account of its own.
- **Requests use up the free plan before any check runs.** Every request that reaches a Worker counts towards
  Cloudflare's daily limit, refused or not. Per-caller allowances (2.6) hold back a greedy friend or member, not a
  flood from anyone who knows the address.
- **Parsing is lenient.** Signed JSON is read with `JSON.parse`, so repeated keys are read last-one-wins (3.1). A second
  implementation must read them the same way or refuse them.

### 12.4 Whoever runs the site

Whoever runs a site (its owner, normally; or someone with their Cloudflare login, their update grant or their server)
can do anything the site can: read everything on it, act as its host, sign calls as it, and show its owner anything.
They can't sign as the owner without the owner's passkey or browser key. A release signed with the release key runs on
every site that updates itself, so that key is the most valuable one in the system; friends' site checks confirm that
a site runs a signed release, not that the release is honest.

## 13. Versioning

This is protocol version 2. The number is in every tag (`afterwrd <kind> 2\n`) and in `v` in every signed or protocol
object, and readers refuse any other. There is no version negotiation and no fallback: a site speaks exactly one
version.

Within version 2, things can be added without a new number, as long as a site that doesn't know them is safe ignoring
them:

- Receivers ignore fields they don't know in request bodies and replies.
- Identity documents and records may carry fields a reader doesn't know: they're signed, so nobody can add or remove
  them on the way, and a reader that doesn't know one ignores it.
- New calls can be added. A site that doesn't have one answers 404 for anything under `/_p/`, `/_group/` or
  `/_member/`, never the sign-in page.

Anything that changes which bytes are signed, how a signature or fingerprint is made, or how an existing field is read,
needs a new version number, in every tag, so that nothing signed under one version can be read as the other.

A site still on afterwrd 1 calls the old way: anything under `/_peer/`, or `/_group/` and `/_member/` with
`Authorization: Bearer` and no `Signature-Input`. Such a call is answered `410` with `{"error": "This site has moved to
afterwrd 2. …"}` (or "This group has moved…"), so the older site shows its owner why, and forgets nothing: afterwrd 1
reads a `401` as "they removed you". This goes once users have come over, with the rest of what's only for afterwrd 1.

`GET /_version` gives which build of the code is answering, and `GET /_group/ping` gives a group's release version and
protocol number. Neither is negotiated, and nothing about how a call is checked depends on them.

## 14. Prior art

afterwrd borrows from several designs. Where it differs, it's usually because it has a different goal: a few dozen
friends and small groups, private by default, each site on a free plan.

| Design | What afterwrd takes from it | Where afterwrd differs |
|---|---|---|
| **AT Protocol** (Bluesky) | Identities that outlive addresses; everything a person writes signed by keys their identity names; a recovery key that outranks the others for a while after a change | No public repositories, relays or firehose. Nothing is public except the identity document. Records live with the item they belong to, on that item's host, not in the writer's own repository. Identities are documents served by the person's own site, with no central directory like PLC |
| **Secure Scuttlebutt** | Append-only, signed, hash-linked logs; readers checking everything themselves | One list per item, kept by its host, not one feed per author. Nothing is gossiped: sites only talk to friends and groups |
| **Certificate Transparency** | Signed heads over an append-only list, so a host that rewrites or forks its list can be caught; receipts as promises to include | A running hash over entries instead of a Merkle tree: lists are small (capped), so readers check whole pages rather than inclusion proofs. No public auditors or gossip between readers |
| **Keybase sigchains** | A chain of signed identity documents, each naming the one before; devices added and removed by signed links | Only passkeys and a recovery code; no third-party proofs |
| **RFC 9421** (HTTP Message Signatures) and **RFC 9530** (Digest fields) | Signed calls between sites, as specified, with Ed25519 | A fixed profile: the covered components, the tag and the time window are all fixed (section 2.3) |
| **WebAuthn** (passkeys) | The owner's devices sign identity changes and delegations, so the site itself can't | Several statements are signed with one passkey prompt (section 3.6) |
| **ActivityStreams 2.0** | The shapes used for the shared Facebook archive and albums (section 8) | Not ActivityPub: no inboxes, outboxes, actors, WebFinger or public objects. Posts and comments are signed records, not ActivityStreams |
| **Matrix** | One conversation as an ordered, signed list that several servers read | One host per item decides the order, and readers check the host; there's no state resolution between servers |
| **Diaspora\* relayables** | Comments signed by their author and passed on by the post's author, who is the only one others take them from | Read by friends' sites, not pushed as copies; exact signed bytes, not a joined string; the post's host also orders the comments and signs where the list is up to |
| **FEP-171b** (Conversation Containers; Streams, Hubzilla, Mitra) | A conversation as an ordered collection owned by whoever started it; only what the owner takes is part of it; removals open, not silent | Nothing in FEP-171b signs the collection, so a reader can't tell what was left out or reordered; afterwrd's running head, `seen`, `prev` and signed heads let readers check that |
| **FEP-8c13** (Context-Authority Routing, draft, June 2026) | The server hosting the first post as the authority for its thread; each reply carrying its writer's own proof; restricted threads read only by signed, actor-bound requests | Its order is "implementation-defined" and the thread isn't signed as a whole; afterwrd's readers pull and check the whole list rather than being sent copies |
| **Nostr NIP-29** (relay-based groups) | A group living on one host that signs its state; admins acting by signed events; private and closed groups | NIP-29's order is the relay's say-so and its roles are relay policy; afterwrd's members list is built from members' own signed joins and admins' signed decisions, checked by every reader |
| **FEP-1b12** (group federation; Lemmy) | A group passing on its members' posts exactly as they signed them, so it can't speak for them | Membership in FEP-1b12 is a plain follow, with no signed list; afterwrd groups are private |
| **Atproto Spaces** (permissioned data, alpha, August 2026) | Data that isn't public, read straight from where it's kept rather than through relays; honest that it's access control, not encryption | Spaces keep records in each author's own repository; afterwrd keeps a conversation with the item it's under, so one host's signed list says what's in it |
| **Interaction policies** (GoToSocial; FEP-5624, draft) | Saying who may reply, per post | afterwrd's answer to "whose policy counts" is the item's host: comments off is its own choice, refused at the host (section 5.7) |

## Appendix: every call

Calls between sites only. The owner's own pages and actions (`/_admin/…`, sign-in, the Update page) go between the
owner's browser and their own site, and aren't part of the protocol.

### On a person's site

| Call | Who may call | Section |
|---|---|---|
| `GET /.well-known/afterwrd` | anyone, unsigned | 4.5 |
| `GET /_version` | anyone, unsigned | 2.4, 11.2 |
| `GET /_connect/<token>` | a browser with the link | 8.2 |
| `GET /_connect/<token>/info` | a site, unsigned | 8.2 |
| `POST /_connect/<token>/accept` | a site, signed | 8.2 |
| `POST /_connect/ask` | a site, signed | 8.3 |
| `POST /_p/introduce` | an approved friend | 8.5 |
| `POST /_p/ask-through` | an approved friend | 8.5 |
| `POST /_p/disconnect` | a friend, approved or waiting | 8.6 |
| `GET /_p/items?since=<t>` | an approved friend | 8.7 |
| `GET /_p/items/<id>[?after=<n>]` | an approved friend who may see the item | 8.8 |
| `POST /_p/records` | an approved friend | 8.10 |
| `POST /_p/records/check` | an approved friend | 8.11 |
| `POST /_p/report` | an approved friend | 8.15 |
| `POST /_p/reports/check` | anyone, unsigned (by report id) | 8.15 |
| `GET /_p/posts[?page=<n>]`, `GET /_p/posts/<key>` | an approved friend | 8.13 |
| `GET /_p/albums`, `GET /_p/albums/<key>[?page=<n>]` | an approved friend | 8.13 |
| `GET /_p/photos/<sha256>` | an approved friend | 8.13 |
| `GET` or `HEAD /files/<sha256>?exp=<t>&sig=<s>` | a browser with a link this site signed, or the site's group copying a photo | 8.12, 10.10 |
| `POST /_p/notes` | an approved friend, or a group the owner has joined | 9.1 |
| `POST /_p/mention` | the site of someone whose comment mentions the owner | 9.4 |
| `POST /_p/check-request`, `/_p/check-token`, `/_p/check-soon`, `/_p/checked`, `/_p/check-failed` | an approved friend on Cloudflare | 11.5 |
| `GET /_check/<token>`, `POST /_check/<token>/start`, `GET /_check/done`, `POST /_check/finish`, `POST /_check/audit` | the browser of whoever opens a check link (on Cloudflare only) | 11.3 |
| `POST /_member/removed` | a group the owner has joined | 10.5 |
| `POST /_p/before` | an approved friend, bringing comments over from afterwrd 1 | not specified (section 8) |

### On a group's site

| Call | Who may call | Section |
|---|---|---|
| `GET /.well-known/afterwrd` | anyone, unsigned | 4.5, 10.2 |
| `GET /_group/ping` | anyone, unsigned | 10.2 |
| `POST /_group/claim` | the site that made the group, once | 10.2 |
| `POST /_group/identity` | the site that claimed it, once | 10.2 |
| `GET /_join/<token>` | a browser with the link | 10.4 |
| `GET /_join/<token>/info` | a site with the link, unsigned | 10.4 |
| `POST /_join/<token>/accept` | a site with the link, signed | 10.4 |
| `GET /_group/members`, `GET /_group/members/list[?after=<n>]` | members | 10.6 |
| `POST /_group/records` | members, and people waiting | 10.7 |
| `GET /_group/admin/members`, `POST /_group/admin/link`, `/about`, `/here`, `/end` | admins (`end`: the owner) | 10.8 |
| `GET /_group/admin/reports`, `POST /_group/admin/reports/leave` `{about, word?}` | admins | 8.15, 10.8 |
| `POST /_group/admin/unremove` `{person}` | admins | 10.8, 10.15 |
| `GET /_p/items?since=<t>`, `?before=<t>`, `?id=<id>` | members | 10.9 |
| `GET /_p/items/<id>[?after=<n>]`, `GET /_p/items/<id>/dates/<date>[?after=<n>]` | members | 10.9 |
| `POST /_p/items` | members | 10.9 |
| `POST /_p/records` | members | 10.9 |
| `POST /_p/records/check` | members | 10.9 |
| `POST /_p/report` | members | 8.15 |
| `POST /_p/reports/check` | anyone, unsigned (by report id) | 8.15 |
| `POST /_p/people` | members | 10.9 |
| `GET` or `HEAD /files/<sha256>?exp=<t>&sig=<s>` | a browser with a link the group signed for a member | 10.10 |
| `POST /_group/rejoin/point`, `POST /_group/rejoin`, `POST /_group/before`, `GET /_p/items?old=<n>` | for a group from afterwrd 1: its old members' and writers' sites (30 days after it came over), and members | not specified (10.1) |
