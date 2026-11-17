// The server's own tools (afterwrd.mjs, run with `docker compose exec afterwrd …`): making the owner, a link to add a
// device, and getting back in after losing every device. It listens only inside the container (config.mjs), and
// works on each site's database through that site's own database object (d1.js), as the site itself does, rather
// than opening the file behind the site's back.
//   env.SITES  {"<host>": ["<database binding>", "<site binding>"]} for each person's site: its Database, and the site
//   POST /owner   {host, name?}  makes `name` the owner of a new site, or (no name) a link for another device
//   POST /recover {host}         signs every device out; the link it gives makes a passkey that replaces the others
//   GET  /sites                  the sites this server runs now
import { d1 } from "./d1.js";

const LINK_SECONDS = 3600; // a device link gives owner access, so it's short-lived (as admin.js DEVICE_LINK_SECONDS)

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const now = () => Math.floor(Date.now() / 1000);
const randomToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A new device link for the owner: [the link, the hash of its token]. */
async function deviceLink(db, host, userId) {
  const token = randomToken();
  const hash = await sha256(token);
  await db.prepare("INSERT INTO device_links (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(hash, userId, now() + LINK_SECONDS).run();
  return [`https://${host}/_auth/device/${token}`, hash];
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const sites = env.SITES;
    if (request.method === "GET" && url.pathname === "/sites") return json({ sites: Object.keys(sites) });
    if (request.method !== "POST") return json({ error: "Not found." }, 404);
    const body = await request.json().catch(() => ({}));
    const host = String(body.host ?? "").toLowerCase();
    if (!Object.hasOwn(sites, host)) return json({ error: `There's no person's site at ${host || "that address"} on this server.` }, 404);
    const [database, site] = sites[host];
    // A visit first, so a brand-new site has made its tables (migrate.js runs on every site's first request).
    await (await env[site].fetch(`https://${host}/_version`)).body?.cancel();
    const db = d1(env[database]);
    const owner = await db.prepare("SELECT id, name FROM users LIMIT 1").first();

    if (url.pathname === "/owner") {
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
      if (name && owner) return json({ error: `This site already has an owner, ${owner.name}. For another device, leave out the name.` }, 409);
      if (!name && !owner) return json({ error: "No owner yet. Give your name." }, 409);
      // Not while getting back in waits for its new passkey (as admin.js refuses): a link made now would skip "the new
      // passkey replaces all the others".
      const waiting = owner && await db.prepare("SELECT value FROM settings WHERE key = 'recovering'").first();
      if (waiting && JSON.parse(waiting.value).until > now()) {
        return json({ error: "Someone is getting back into your site without a passkey: use the link recover gave, or run recover again." }, 409);
      }
      const user = owner ?? await db.prepare("INSERT INTO users (name, created_at) VALUES (?, ?) RETURNING id, name").bind(name, now()).first();
      const [link] = await deviceLink(db, host, user.id);
      return json({ name: user.name, link, minutes: LINK_SECONDS / 60 });
    }

    if (url.pathname === "/recover") {
      if (!owner) return json({ error: "This site has no owner yet, so there's nothing to get back into." }, 409);
      // As getting back in through Cloudflare does (recover.js): every device is signed out and its notifications
      // turned off, older device links go, and until this one is used (or runs out) the older passkeys can't sign in.
      // When it's used, the passkey it makes replaces all the others (auth.js, recover.js recoveryDone).
      const [link, hash] = await deviceLink(db, host, owner.id);
      await db.batch([
        db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(owner.id),
        db.prepare("DELETE FROM push_devices"),
        db.prepare("DELETE FROM device_links WHERE user_id = ? AND used_at IS NULL AND token_hash != ?").bind(owner.id, hash),
        db.prepare("UPDATE settings SET value = json_remove(value, '$.early') WHERE key = 'auto_update'"),
        db.prepare("INSERT INTO settings (key, value) VALUES ('recovering', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1")
          .bind(JSON.stringify({ link: hash, at: now(), until: now() + LINK_SECONDS })),
      ]);
      return json({ name: owner.name, link, minutes: LINK_SECONDS / 60 });
    }
    return json({ error: "Not found." }, 404);
  },
};
