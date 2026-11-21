// Moving a whole afterwrd site here (src/move.js): reads another site's Download everything zip on this computer,
// then sends this site its photos, videos and thumbnails (skipping any already here), its rows, and asks it to put
// them all in at once, so nothing is half-moved. Before that, a site with an identity moves it (src/movein.js): this
// site's passkey asks, and the owner agrees on their old site.
/* global zip */
import { MEDIA_TYPES } from "./schema.js";
import { passkeySigns } from "../passkey.js";
import { fingerprintOf, fromB64url } from "../signed.js";
import { keyAllowed, newBrowserKey } from "../browserkey.js";

const ROWS_PER_REQUEST_BYTES = 150_000;
const PARALLEL = 4;
const FILE_BATCH = 200;

/** @type {(id: string) => any} the page's own elements */
const $ = (id) => document.getElementById(id);
let chosen = null;

$("zip")?.addEventListener("change", (e) => {
  chosen = /** @type {HTMLInputElement} */ (e.target).files[0] ?? null;
  $("go").disabled = !chosen;
  $("error").textContent = "";
});
$("go")?.addEventListener("click", () => run().catch(fail));

// --- the identity: asking, then checking the old site has agreed ------------------------------------------------------

$("ask")?.addEventListener("submit", (e) => {
  e.preventDefault();
  $("error").textContent = "";
  ask().catch((error) => { $("error").textContent = error.name === "NotAllowedError" ? "Cancelled, or no passkey was chosen. Try again." : error.message; });
});
async function ask() {
  const start = await api("/move/identity/start", { from: $("from").value });
  const response = await passkeySigns(start.nonce, [await fingerprintOf("move", fromB64url(start.request))], start.allow);
  const { go } = await api("/move/identity/finish", { request: start.request, response });
  location.assign(go);
}
document.addEventListener("click", (e) => {
  const button = /** @type {HTMLElement} */ (e.target).closest?.("button[data-move]");
  if (!button) return;
  e.preventDefault();
  $("error").textContent = "";
  const what = /** @type {HTMLButtonElement} */ (button).dataset.move;
  (what === "forget" ? api("/move/identity/forget", {}).then(() => location.reload()) : check(true))
    .catch((error) => { $("error").textContent = error.message; });
});
/** Reads the old site's identity again; reloads if the move has got further. */
async function check(saying) {
  const { stage } = await api("/move/identity/fetch", {});
  if (stage === "agree") {
    if (saying) $("error").textContent = "Your old site hasn't agreed yet. Open it, and agree there.";
    return;
  }
  location.reload();
}
// Back from agreeing on the old site: see straight away.
if ($("agree")) check(false).catch(() => {});

function step(text) {
  document.querySelector("#steps li:last-child")?.classList.add("done");
  const li = document.createElement("li");
  li.textContent = text;
  $("steps").append(li);
  progress(0, 1, "");
}

function progress(done, total, text) {
  $("bar").max = total || 1;
  $("bar").value = done;
  $("status").textContent = text;
}

function fail(error) {
  console.error(error);
  $("error").textContent = `${error.message} Nothing has been moved yet.`;
  if ($("go")) $("go").disabled = false;
  window.onbeforeunload = null;
}

async function api(path, body, { method = "POST", type = "application/json", attempts = 3 } = {}) {
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await fetch(`/_admin/import${path}`, {
        method,
        headers: { "Content-Type": type },
        body: type === "application/json" ? JSON.stringify(body) : body,
      });
    } catch (error) {
      if (attempt >= attempts) throw new Error(`Lost connection to the site (${error.message}).`);
    }
    if (response?.ok) return response.json();
    if (response && response.status < 500 && response.status !== 429) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `The site said ${response.status}.`);
    }
    if (attempt >= attempts) throw new Error(`The site kept failing (${response?.status ?? "no response"}).`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

async function keysApi(path, body) {
  const response = await fetch(`/_admin/keys${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `The site said ${response.status}.`);
  return data;
}

async function eachLimited(items, limit, work) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

/** The download's files by path below its top folder (the one holding site/about.json). */
async function readZip(file) {
  zip.configure({ useWebWorkers: false });
  const entries = (await new zip.ZipReader(new zip.BlobReader(file)).getEntries()).filter((e) => !e.directory);
  const about = entries.find((e) => /(^|\/)site\/about\.json$/.test(e.filename));
  if (!about) {
    throw new Error("This isn't a download this version of afterwrd can move: make a new one from Download everything on your old site.");
  }
  const prefix = about.filename.slice(0, about.filename.length - "site/about.json".length);
  const files = new Map(entries.filter((e) => e.filename.startsWith(prefix)).map((e) => [e.filename.slice(prefix.length), e]));
  const text = (path) => files.get(path)?.getData(new zip.TextWriter("utf-8"));
  // Photos and videos (media/) and thumbnails (site/thumbs/), by fingerprint, with the type their extension gives.
  const stored = new Map();
  for (const [path, entry] of files) {
    const match = /^(?:media|site\/thumbs)\/([0-9a-f]{64})(\.\w+)?$/.exec(path);
    if (match) stored.set(match[1], { entry, type: MEDIA_TYPES[match[2]?.toLowerCase()] });
  }
  return { about: JSON.parse(await text("site/about.json")), text, stored };
}

async function run() {
  $("go").disabled = true;
  $("error").textContent = "";
  $("steps").replaceChildren();
  $("progress").hidden = false;
  window.onbeforeunload = () => "The move is still running.";

  step("Reading your download");
  const download = await readZip(chosen);
  const { about } = download;
  const { tables } = await api("/move/check", { about });
  const data = {};
  for (const table of tables) {
    const text = await download.text(`site/${table}.json`);
    data[table] = text ? JSON.parse(text) : [];
  }
  const postCount = data.posts.length + (data.items ?? []).filter((i) => i.type === "post").length;
  progress(1, 1, `From ${new URL(about.site).host}: ${postCount.toLocaleString("en-GB")} posts, ${data.media.length.toLocaleString("en-GB")} photos and videos`);

  step("Sending photos and videos");
  const types = new Map();
  for (const m of data.media) {
    if (m.hash) types.set(m.hash, m.type);
    if (m.thumb_hash && !types.has(m.thumb_hash)) types.set(m.thumb_hash, null);
  }
  // The profile picture and cover are photos too (the site checks the settings themselves).
  for (const s of data.settings) if (/^(profile|cover)_hash$/.test(s.key) && !types.has(s.value)) types.set(s.value, null);
  const hashes = [...types.keys()];
  const absent = hashes.filter((h) => !download.stored.has(h));
  if (absent.length) {
    throw new Error(about.media === false
      ? "This download was made without photos and videos. Make it again with Include photos and videos ticked."
      : `${absent.length} photos and videos are missing from this download. Make it again from your old site.`);
  }
  let sent = 0;
  for (let i = 0; i < hashes.length; i += FILE_BATCH) {
    const { missing } = await api("/missing", { hashes: hashes.slice(i, i + FILE_BATCH) });
    await eachLimited(missing, PARALLEL, async (hash) => {
      const { entry, type } = download.stored.get(hash);
      const kind = types.get(hash) ?? type;
      if (!kind) throw new Error("The download has a file this site can't store.");
      await api(`/files/${hash}`, await entry.getData(new zip.BlobWriter(kind)), { method: "PUT", type: kind });
    });
    sent = Math.min(i + FILE_BATCH, hashes.length);
    progress(sent, hashes.length, `${sent.toLocaleString("en-GB")} of ${hashes.length.toLocaleString("en-GB")}`);
  }

  step("Sending posts, comments and the rest");
  await api("/move/start", { about });
  const total = tables.reduce((n, t) => n + data[t].length, 0);
  let done = 0;
  for (const table of tables) {
    for (const batch of rowBatches(data[table])) {
      await api("/move/rows", { table, rows: batch });
      done += batch.length;
      progress(done, total, `${done.toLocaleString("en-GB")} of ${total.toLocaleString("en-GB")} rows`);
    }
  }

  // With an identity, every post's list is checked against it before anything is taken (src/movein.js).
  if (about.person) {
    step("Checking your posts and comments");
    let after = "";
    let lists = 0;
    const total = data.lists?.filter((l) => !l.deleted_at).length ?? 0;
    do {
      ({ next: after } = await api("/move/verify", { about, after }));
      lists = Math.min(total, lists + 20);
      progress(lists, total, `${lists.toLocaleString("en-GB")} of ${total.toLocaleString("en-GB")}`);
    } while (after);
  }

  step("Putting it all in place");
  await api("/move/finish", { about });
  // This browser signed in before the identity was here, so it can't sign yet: one prompt, as at sign-in (keys.js).
  if (about.person) {
    step("Letting this browser sign for you here");
    window.onbeforeunload = null;
    try {
      const key = await newBrowserKey();
      const start = await keysApi("/browser/start", { browserKey: key.publicKey });
      const response = await passkeySigns(start.nonce, [await fingerprintOf("delegation", fromB64url(start.delegation))], start.allow);
      const done = await keysApi("/browser/finish", { delegation: start.delegation, response });
      await keyAllowed(key, done.person, done.expires);
    } catch {
      $("error").textContent = "Everything has moved, but this browser can't sign for you yet: sign out and in again before you post.";
    }
  }
  document.querySelector("#steps li:last-child").classList.add("done");
  progress(1, 1, "");
  $("status").innerHTML = about.person
    ? 'Done: you\'ve moved, with your friends. Their sites find you here as they hear (within the hour), and your old site tells anyone who looks there where you\'ve gone. <a href="/">Go to Home</a>.'
    : 'Done: everything is here. <a href="/posts">See your posts</a>, then <a href="/friend">add your friends again</a>.';
  window.onbeforeunload = null;
}

function* rowBatches(rows) {
  let batch = [];
  let bytes = 0;
  for (const row of rows) {
    const size = JSON.stringify(row).length;
    if (batch.length && bytes + size > ROWS_PER_REQUEST_BYTES) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(row);
    bytes += size;
  }
  if (batch.length) yield batch;
}
