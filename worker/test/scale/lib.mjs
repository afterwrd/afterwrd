// What drive.mjs uses to act as each site's owner, without a browser (docs/scale-test-plan.md): HTTP to the site
// through its workerd's router, with its cookies; the server's tools (owner links); and a passkey made in software.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { Agent, request } from "node:http";

const agent = new Agent({ keepAlive: true, maxSockets: 256 });

/** A process's machine (net.mjs --machines): its address on the private network, or this computer's. */
export const machineOf = (proc) => proc.machine ?? "127.0.0.1";
/** Where process `i`'s tools (selfhost/tools.js) listen: on its machine, so drive.mjs can reach them from the first. */
export const toolsAddress = (proc, i) => `${machineOf(proc)}:${9400 + i}`;
/** Where the first machine takes the others' measuring lines (start.mjs). */
export const STATS_PORT = 9300;
const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** A minimal CBOR encoder: whole numbers, byte strings, text and maps, which is all a passkey's answer needs. */
function cbor(value) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  if (value instanceof Map) {
    return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  }
  throw new Error(`cbor: can't encode ${typeof value}`);
}

/**
 * A passkey for `rpId`, made here: what a phone would do when the site asks for one (attestation "none"). `saved`
 * (from its `saved()`) brings back one made earlier, so a later step can sign with it (afterwrd 2: groups' identities).
 */
export function makePasskey(rpId, saved = null) {
  const privateKey = saved ? createPrivateKey(saved.key) : generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const publicKey = createPublicKey(privateKey);
  const jwk = publicKey.export({ format: "jwk" });
  const id = saved ? Buffer.from(saved.id, "base64url") : randomBytes(16);
  return {
    id,
    privateKey,
    saved: () => ({ id: b64url(id), key: privateKey.export({ format: "pem", type: "pkcs8" }) }),
    /** The browser's answer to navigator.credentials.create(options). */
    register(options, origin) {
      const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }));
      const coseKey = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]);
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(id.length);
      const authData = Buffer.concat([
        createHash("sha256").update(rpId).digest(),
        Buffer.from([0x45]), // user present, user verified, credential included
        Buffer.alloc(4), // sign count
        Buffer.alloc(16), // AAGUID
        idLength, id, cbor(coseKey),
      ]);
      const attestationObject = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
      return { id: b64url(id), rawId: b64url(id), type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {},
        response: { clientDataJSON: b64url(clientData), attestationObject: b64url(attestationObject), transports: ["internal"] } };
    },
    /** The browser's answer to navigator.credentials.get(options). */
    login(options, origin, counter) {
      const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
      const count = Buffer.alloc(4);
      count.writeUInt32BE(counter);
      const authData = Buffer.concat([createHash("sha256").update(rpId).digest(), Buffer.from([0x05]), count]);
      const signature = sign("sha256", Buffer.concat([authData, createHash("sha256").update(clientData).digest()]), privateKey);
      return { id: b64url(id), rawId: b64url(id), type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {},
        response: { clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(signature), userHandle: null } };
    },
  };
}

/**
 * One site as its owner (or a stranger) sees it: requests through its workerd's router at `machine`:`port`, with
 * cookies kept. Answers {status, headers, text, json(), ms}.
 */
export class Site {
  constructor(host, machine, port) {
    this.host = host;
    this.machine = machine;
    this.port = port;
    this.origin = `https://${host}`;
    this.cookies = new Map();
  }

  /** @param {{ method?: string, body?: any, form?: Record<string, any>, headers?: Record<string, string>, timeout?: number }} [options] */
  fetch(path, { method = "GET", body, form, headers = {}, timeout = 120_000 } = {}) {
    let payload;
    const sent = { Host: this.host, Accept: "text/html", ...headers };
    if (form) {
      payload = new URLSearchParams(Object.entries(form).flatMap(([k, v]) => [v].flat().map((x) => [k, String(x)]))).toString();
      sent["Content-Type"] = "application/x-www-form-urlencoded";
    } else if (body !== undefined && !(Buffer.isBuffer(body) || typeof body === "string")) {
      payload = JSON.stringify(body);
      sent["Content-Type"] = "application/json";
      sent.Accept = headers.Accept ?? "application/json";
    } else payload = body;
    if (method !== "GET") sent.Origin = this.origin;
    if (this.cookies.size) sent.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const req = request({ agent, host: this.machine, port: this.port, path, method, headers: sent, timeout }, (res) => {
        for (const cookie of res.headers["set-cookie"] ?? []) {
          const [pair] = cookie.split(";");
          const at = pair.indexOf("=");
          const name = pair.slice(0, at);
          const value = pair.slice(at + 1);
          if (/Max-Age=0/i.test(cookie) || value === "") this.cookies.delete(name);
          else this.cookies.set(name, value);
        }
        const chunks = [];
        // A connection reset while the answer's coming in fails this request, not the whole run (a full run's setup
        // stopped at 290,000 friendships on one).
        res.on("error", reject);
        res.on("aborted", () => reject(new Error(`${method} ${this.host}${path}: the answer was cut off`)));
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode, headers: res.headers, text, ms: performance.now() - started,
            json: () => JSON.parse(text) });
        });
      });
      req.on("timeout", () => req.destroy(new Error(`${method} ${this.host}${path} timed out`)));
      req.on("error", reject);
      req.end(payload);
    });
  }

  /** Becomes the owner's signed-in device, from a device link (tools.js), with a passkey made here. */
  async signInWith(link) {
    const token = new URL(link).pathname.split("/").pop();
    this.passkey = makePasskey(this.host);
    const options = await this.fetch("/_auth/register/options", { method: "POST", body: { token } });
    if (options.status !== 200) throw new Error(`${this.host}: register options ${options.status} ${options.text.slice(0, 200)}`);
    const response = this.passkey.register(options.json(), this.origin);
    const verified = await this.fetch("/_auth/register/verify", { method: "POST", body: { token, response } });
    if (verified.status !== 200) throw new Error(`${this.host}: register verify ${verified.status} ${verified.text.slice(0, 200)}`);
  }
}

/** Calls the server's tools (selfhost/tools.js) at `address` (toolsAddress). */
export function tools(address, path, body) {
  const at = address.lastIndexOf(":");
  return new Promise((resolve, reject) => {
    const req = request({ host: address.slice(0, at), port: Number(address.slice(at + 1)), path, method: body ? "POST" : "GET",
      headers: { Host: "tools", "Content-Type": "application/json" }, timeout: 60_000 }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("error", reject);
      res.on("data", (c) => { text += c; });
      res.on("end", () => {
        try {
          const data = JSON.parse(text);
          if (res.statusCode !== 200) reject(new Error(data.error ?? text));
          else resolve(data);
        } catch {
          reject(new Error(`tools ${path}: ${res.statusCode} ${text.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

/** Runs `work` on each item, `limit` at a time. */
export async function pool(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await work(items[i], i);
    }
  }));
  return results;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The CPU time `host`'s isolate (its Worker and all its objects) used while `work` ran, from V8's sampling profiler
 * through workerd's inspector (start.mjs gives process i the address 127.0.0.1:9230+i). Returns {result, cpuMs,
 * wallMs}. Everything the site did in that time counts, background work included, as Cloudflare's meter would.
 */
export async function withCpu(proc, host, work, intervalUs = 100) {
  const ws = new WebSocket(`ws://127.0.0.1:${9230 + proc}/site-${host.replace(/[^a-z0-9]/g, "")}`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`No inspector for ${host}`));
  });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && waiting.has(message.id)) {
      waiting.get(message.id)(message);
      waiting.delete(message.id);
    }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    waiting.set(++id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send("Profiler.enable");
  await send("Profiler.setSamplingInterval", { interval: intervalUs });
  await send("Profiler.start");
  const started = performance.now();
  let result;
  try {
    result = await work();
  } finally {
    var wallMs = performance.now() - started;
    var { result: { profile } } = await send("Profiler.stop");
    ws.close();
  }
  // No samples are taken while the isolate waits (on another site, say), so the sample after a wait carries the whole
  // gap in its time: each sample counts for at most a few intervals.
  const idle = new Set(profile.nodes.filter((n) => n.callFrame.functionName === "(idle)").map((n) => n.id));
  const cap = Math.max(4 * intervalUs, 500);
  let us = 0;
  profile.samples.forEach((node, i) => {
    if (!idle.has(node)) us += Math.min(profile.timeDeltas[i] ?? 0, cap);
  });
  return { result, cpuMs: Math.round(us / 100) / 10, wallMs: Math.round(wallMs) };
}
