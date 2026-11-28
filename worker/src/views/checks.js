// How a friend's check of a site is shown (checks.js does the checking): the result, everything from Cloudflare
// escaped, and when the site was last checked.
import { when } from "../checks.js";
import { escape } from "../util.js";

/** What a check found, as HTML (everything from Cloudflare escaped). `whose`: "yours" for the person checked, else "theirs". */
export function resultHtml(r, whose = "theirs", by = null) {
  const site = escape(r.site ? new URL(r.site).host : "");
  const your = whose === "yours" ? "your" : "their";
  const Your = whose === "yours" ? "Your" : "Their";
  // Which site was checked, and by whom, first: with one person playing both parts it's easy to lose track.
  const lines = [`<p class="check-who">Site checked: <b>${site}</b>${r.account ? ` <span class="meta">(Worker ${escape(r.script ?? "")}, Cloudflare account ending ${escape(r.account)})</span>` : ""}`
    + (by ? `<br>Checked by: <b>${escape(by.name)}'s site</b> <span class="meta">(${escape(by.host)})</span>` : "") + "</p>"];
  const say = (good, words) => lines.push(`<p class="check-${good ? "good" : "bad"}">${good ? "✓" : "✗"} ${words}</p>`);
  if (r.problem === "missing") say(false, `No Worker called <b>${escape(r.script)}</b> in the Cloudflare account that was allowed. Was it the account ${site} is in?`);
  else if (r.problem === "several") say(false, `More than one account that was allowed has a Worker called <b>${escape(r.script)}</b>. Check again, allowing only the account ${site} is in.`);
  else if (r.problem === "unreadable") say(false, `Cloudflare wouldn't hand over the code of <b>${escape(r.script)}</b>.`);
  else {
    if (r.code === "matches") say(true, `${Your} site is running exactly <b>afterwrd ${escape(r.version)}</b>, every file the same as the published release.`);
    else if (r.code === "different") {
      say(false, `${Your} site's code is <b>not</b> the published afterwrd ${escape(r.version)}. Don't use it yet: see <a href="/help#checks">what to do</a>.`);
      lines.push(`<ul class="check-files">${(r.files ?? []).map((f) => `<li>${escape(f.name)}: ${escape(f.why)}</li>`).join("")}</ul>`);
    } else if (r.code === "no-release") say(false, `It says it's afterwrd ${escape(r.version)}, but there's no such release.`);
    else if (r.code === "release-unavailable") say(false, `Couldn't download afterwrd ${escape(r.version)} from GitHub to compare with. Check again later.`);
    else say(false, "This Worker doesn't look like afterwrd: its version couldn't be read.");
    for (const p of r.problems ?? []) say(false, escape(p));
    if (!(r.problems ?? []).length && r.code === "matches") say(true, "It's connected to exactly what afterwrd uses, and hands out its files only through its code.");
    const v = r.versions;
    if (v && !v.none) {
      const since = v.from ? ` since ${escape(when(v.from))}` : "";
      const which = (list) => list.map((u) => `version ${escape(String(u.number ?? "?"))}, ${escape(when(u.at))}`).join("; ");
      const code = (v.unknown ?? []).filter((u) => !u.files && !u.wired);
      const files = (v.unknown ?? []).filter((u) => u.files);
      const wired = (v.unknown ?? []).filter((u) => u.wired);
      if (code.length) {
        say(false, `${code.length === 1 ? "One version" : `${code.length} versions`} of ${your} site's code uploaded or made live${since} ${code.length === 1 ? "wasn't" : "weren't"}
          a signed afterwrd release (${which(code)}). Something other than afterwrd changed ${your} site's code, even if only for a while.`);
      }
      if (files.length) {
        say(false, `${files.length === 1 ? "One version" : `${files.length} versions`} of ${your} site uploaded or made live${since} let Cloudflare send
          ${your} site's files without its code checking them first (${which(files)}). afterwrd never sets it up that way: something
          other than afterwrd changed it, even if only for a while.`);
      }
      if (wired.length) {
        say(false, `${wired.length === 1 ? "One version" : `${wired.length} versions`} of ${your} site uploaded or made live${since} wired the
          site's storage to another Worker, which would see everything it keeps (${which(wired)}). afterwrd never does that: something
          other than afterwrd changed it, even if only for a while.`);
      }
      if (code.length || files.length || wired.length) { /* said */ } else if (v.more) say(false, `There were more uploads to ${your} site's code${since} than one check looks at.`);
      else say(true, `Every version of ${your} site's code uploaded or made live${since} was a signed afterwrd release (${v.checked} ${v.checked === 1 ? "version" : "versions"}).`);
    }
    if (r.newer) lines.push(`<p class="meta">afterwrd ${escape(r.newer)} is out: worth updating.</p>`);
  }
  lines.push(`<p class="meta">Checked by itself ${escape(when(r.checkedAt))}, read-only, with a one-hour pass ${your} site handed over.</p>`);
  return lines.join("\n");
}

/** "Last checked by Sam Taylor's site on 9 Nov 2026 (afterwrd 0.34.0)." or "You last checked it yourself on …". */
export function checkedWords(last) {
  const day = new Date(last.checked_at * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });
  return last.name === null
    ? `You last checked it yourself, on ${day}.`
    : `Last checked by ${last.name}'s site on ${day}${last.version ? ` (afterwrd ${last.version})` : ""}.`;
}

