// Events (events.js, calendar.js): an event on a post, its answers and guests, the form, and the calendars (Events,
// and a group's). Views only draw: they read nothing and change nothing.

import { dateKey, datesOf, dayName, eventDay, eventDays, eventTime, eventWhen, finishedAt, monthAround, monthWeeks, repeatChoices, repeatWords, today, weekAround } from "../calendar.js";
import { asset, icon } from "./nav.js";
import { html, raw } from "./html.js";
import { groupBase, groupHead } from "./groups.js";
import { groupItemCard } from "./items.js";
import { page } from "./layout.js";

// --- events in groups (calendar.js) ---------------------------------------------------------------------------------

const ANSWER_LABELS = [["going", "Going"], ["maybe", "Maybe"], ["no", "Can't go"]];

function dateTile(e) {
  const d = eventDay(e);
  return html`<span class="date-tile" aria-hidden="true"><span>${d.month}</span><strong>${d.day}</strong></span>`;
}

/**
 * An event (in a group's post, a friend's, or the owner's own): when and where, who's coming, and the owner's answer.
 * `href`: its own page. `full` (on that page): who's coming by name, adding it to a calendar (`ics`), changing it
 * (`edit`) and calling it off (`cancel`: the form's action), as allowed. `answer`: where an answer goes ({ action,
 * hidden }), or null for the host, who has none. `note`: who can see it, under the title.
 */
export function eventBlock(ctx, e, { href, full = false, answer = null, ics = null, edit = null, cancel = null, cancelNote = "", note = "", cancelSign = "" }) {
  const over = finishedAt(e) < Date.now() / 1000;
  const back = ctx.url.pathname + ctx.url.search;
  // Signed events (views/items.js) name the owner here with `me`, and mark answers given before it last changed.
  const names = (list) => list.map((x, i) => (x.me || x.from === ctx.url.origin ? (i ? "you" : "You") : x.name)
    + (x.earlier ? " (said before it changed)" : "")).join(", ");
  const counts = [e.going.length && `${e.going.length} going${youKnow(e.going)}`, e.maybe.length && `${e.maybe.length} maybe${youKnow(e.maybe)}`,
    e.invited && `${e.invited} invited`].filter(Boolean).join(" · ");
  const lists = [["Going", e.going], ["Maybe", e.maybe], ["Can't go", e.cantGo ?? []], ["Not answered yet", e.waiting ?? []]];
  return html`<div class="event${e.cancelled_at ? " cancelled" : ""}">
  <div class="event-head">
    ${dateTile(e)}
    <div class="event-what">
      <a class="event-title" href="${href}">${e.title}</a>
      ${e.cancelled_at ? html`<span class="badge as-written">Called off</span>` : over ? html`<span class="badge as-written">Over</span>` : ""}
      <p class="meta"><time>${eventWhen(e, ctx.zone)}</time>${e.place && html`<br>${e.place}`}</p>
      ${counts && html`<p class="meta">${counts}</p>`}
      ${note && html`<p class="meta">${note}</p>`}
    </div>
  </div>
  ${answer && !e.cancelled_at && !over && html`<form method="post" action="${answer.action}" class="answers" aria-label="Are you going?" data-inplace${raw(answer.sign ?? "")}>
    <input type="hidden" name="back" value="${back}">
    ${Object.entries(answer.hidden ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
    ${ANSWER_LABELS.map(([value, label]) => html`<button class="chip${e.answer === value ? " primary" : ""}" name="answer" value="${value}"
      aria-pressed="${e.answer === value ? "true" : "false"}">${label}</button>`)}
  </form>`}
  ${full && html`<dl class="answered">
    ${lists.filter(([, list]) => list.length).map(([label, list]) => html`<dt>${label}</dt><dd>${names(list)}</dd>`)}
  </dl>
  <div class="actions-row">
    ${ics && !e.cancelled_at && html`<a class="chip" href="${ics}" download>${raw(icon("calendar"))}<span>Add to my calendar</span></a>`}
    ${edit && !e.cancelled_at && !over && html`<a class="chip" href="${edit}">Change it</a>`}
    ${cancel && !e.cancelled_at && !over && html`<form method="post" action="${cancel}" data-inplace
      data-confirm="${cancelNote}" data-confirm-ok="Call it off"${raw(cancelSign)}>
      <input type="hidden" name="back" value="${back}"><button class="chip">Call it off</button></form>`}
  </div>`}
</div>`;
}

/**
 * Friends to tick, to invite to an event, with a box to find one by name when there are many. `none`: what to say if
 * there's nobody to invite.
 */
export function guestPicker(friends, { none = "" } = {}) {
  if (!friends.length) return none && html`<p class="meta">${none}</p>`;
  return html`<fieldset class="guest-picker">
  <legend>Who's invited</legend>
  ${friends.length > 8 && html`<input type="search" class="guest-filter" placeholder="Find a friend" aria-label="Find a friend">`}
  <div class="guest-options">${friends.map((f) => html`<label><input type="checkbox" name="guest" value="${f.id}"><span>${f.name}</span></label>`)}</div>
  <p class="meta">Only the friends you invite see the event. Everyone invited sees who's going and who might.</p>
</fieldset>
<script>
  for (const box of document.querySelectorAll(".guest-filter")) {
    box.addEventListener("input", () => {
      const want = box.value.trim().toLowerCase();
      for (const label of box.parentElement.querySelectorAll(".guest-options label")) label.hidden = !label.textContent.toLowerCase().includes(want);
    });
  }
</script>`;
}

/** On the owner's own event's page, for an event from before signing: who was invited, and their answers, as they were. */
export function guestsBlock(ctx, p) {
  const e = p.event;
  const answers = { going: "Going", maybe: "Maybe", no: "Can't go" };
  // What became of an invitation not yet answered: their site may be too old to take it, or not answering.
  const waiting = (g) => (g.delivery === "refused" ? "Their site didn't take the invitation: it may need updating"
    : g.delivery === "unreachable" ? "Their site couldn't be reached, so they haven't been told" : "Not answered yet");
  const guests = [...e.going.map((g) => [g, "going"]), ...e.maybe.map((g) => [g, "maybe"]), ...e.cantGo.map((g) => [g, "no"]),
    ...e.waiting.map((g) => [g, null])];
  return html`<details class="guests" id="guests-${p.id}" open>
  <summary>Who's invited (${guests.length})</summary>
  ${guests.length ? html`<ul class="guest-list">${guests.map(([g, answer]) => html`<li>
    <span class="name">${g.name}</span> <span class="meta">${answer ? answers[answer] : waiting(g)}</span>
  </li>`)}</ul>` : html`<p class="meta">Nobody.</p>`}
</details>`;
}

/**
 * A repeating event in a signed group's post (step 6d), as repeatingBlock draws one: its next date (or the one asked
 * for) on a card, every date still to come on its own page, each answered on its own. Each form is signed for that
 * date's own list: `sign(kind, d)` gives a form's data-sign-* attributes ("answer"; "calloff", or "" if the owner here
 * may not call that date off; "cancel-all" for calling off the whole of it, or ""). The page shows the dates' answers
 * as the group sends them, apart from the one opened (?date=, or the next), read from the group and checked.
 */
export function repeatingSigned(ctx, e, { base, relay, full = false, sign, edit = null }) {
  const back = ctx.url.pathname + ctx.url.search;
  const at = Date.now() / 1000;
  const asked = ctx.url.searchParams.get("date");
  const dates = datesOf(e, full || asked ? {} : { from: at }).map((d) => ({ ...d, over: finishedAt(d) < at }));
  if (!dates.length) dates.push(...datesOf(e).slice(-1).map((d) => ({ ...d, over: true })));
  const next = dates.find((d) => d.date === asked) ?? dates.find((d) => !d.over && !d.cancelled_at) ?? dates.at(-1);
  const over = dates.every((d) => d.over);
  const names = (list) => list.map((x, i) => (x.me ? (i ? "you" : "You") : x.name) + (x.earlier ? " (said before it changed)" : "")).join(", ");
  const counts = (d) => [d.going.length && `${d.going.length} going${youKnow(d.going)}`, d.maybe.length && `${d.maybe.length} maybe${youKnow(d.maybe)}`]
    .filter(Boolean).join(" · ");
  const answers = (d, label) => html`<form method="post" action="${relay}" class="answers" aria-label="${label}" data-inplace${raw(sign("answer", d))}>
    <input type="hidden" name="back" value="${back}">
    ${ANSWER_LABELS.map(([value, words]) => html`<button class="chip${d.answer === value ? " primary" : ""}" name="answer" value="${value}"
      aria-pressed="${d.answer === value ? "true" : "false"}">${words}</button>`)}
  </form>`;
  const open = (d) => !e.cancelled_at && !d.cancelled_at && !d.over;
  const all = sign("cancel-all", null);
  return html`<div class="event repeating${e.cancelled_at ? " cancelled" : ""}">
  <div class="event-head">
    ${dateTile(next)}
    <div class="event-what">
      <a class="event-title" href="${base}">${e.title}</a>
      ${e.cancelled_at ? html`<span class="badge as-written">Called off</span>` : over ? html`<span class="badge as-written">Over</span>` : ""}
      <p class="meta">${repeatWords(e)}${e.place && html`<br>${e.place}`}</p>
      ${!over && !e.cancelled_at && html`<p class="meta">${next.date === asked ? "" : "Next: "}<time>${eventWhen(next, ctx.zone)}</time>${next.cancelled_at ? " · called off" : ""}
        ${counts(next) && ` · ${counts(next)}`}</p>`}
      <p class="meta">Everyone in the group can see it.</p>
    </div>
  </div>
  ${!full && open(next) && answers(next, `Are you going on ${dayName(eventDayParts(next))}?`)}
  ${full && html`<ol class="event-dates">${dates.filter((d) => !d.over || d.date === asked).map((d) => html`<li id="d-${d.date}" class="${d.cancelled_at ? "off" : ""}">
    <div class="date-line"><time>${eventWhen(d, ctx.zone)}</time>
      ${d.cancelled_at ? html`<span class="badge as-written">Called off</span>` : counts(d) && html`<span class="meta">${counts(d)}</span>`}</div>
    ${open(d) && answers(d, `Are you going on ${dayName(eventDayParts(d))}?`)}
    ${(d.going.length > 0 || d.maybe.length > 0 || d.cantGo.length > 0) && html`<dl class="answered">
      ${[["Going", d.going], ["Maybe", d.maybe], ["Can't go", d.cantGo]].filter(([, list]) => list.length)
        .map(([label, list]) => html`<dt>${label}</dt><dd>${names(list)}</dd>`)}</dl>`}
    ${open(d) && sign("calloff", d) && html`<form method="post" action="${relay}" data-inplace class="call-off-date"${raw(sign("calloff", d))}
      data-confirm="Call off ${dayName(eventDayParts(d))}? Everyone going that day will be told. The other dates stay." data-confirm-ok="Call it off">
      <input type="hidden" name="back" value="${back}"><button class="chip">Call off this date</button></form>`}
  </li>`)}</ol>
  <div class="actions-row">
    ${!e.cancelled_at && html`<a class="chip" href="${base}/event.ics" download>${raw(icon("calendar"))}<span>Add to my calendar</span></a>`}
    ${edit && !e.cancelled_at && !over && html`<a class="chip" href="${edit}">Change it</a>`}
    ${all && !e.cancelled_at && !over && html`<form method="post" action="${relay}" data-inplace${raw(all)}
      data-confirm="Call off every date of this event? Everyone going to any of them will be told." data-confirm-ok="Call it all off">
      <input type="hidden" name="back" value="${back}"><button class="chip">Call it all off</button></form>`}
  </div>`}
</div>`;
}

/** The day one date of an event is on, where it's held: { year, month, day }. */
const eventDayParts = (e) => { const [year, month, day] = eventDays(e)[0].split("-").map(Number); return { year, month, day }; };

/** The owner's own event from before signing, in their post (see eventBlock): read-only, and theirs alone for now. */
export function ownEventBlock(ctx, p, { full = false } = {}) {
  return eventBlock(ctx, p.event, { href: `/posts/${p.key}`, full, ics: `/posts/${p.key}/event.ics`,
    note: "Your event, from before signing. Only you can see it for now, and it can't be changed." });
}

/**
 * Adding or changing an event. Its times are in `values.zone`, or, for a new one, the browser's own time zone.
 * `repeats`: whether it may repeat (in a group); "only" when changing a signed one that does, which can't stop.
 * @param {{ action: string, back: string, values?: Record<string, string>, text?: string, submit: string, guests?: any, repeats?: boolean | "only", sign?: string }} options
 */
export function eventForm({ action, back, values = {}, text = "", submit, guests = "", repeats = false, sign = "" }) {
  return html`<form class="stack event-form" method="post" action="${action}"${raw(sign)}>
  <input type="hidden" name="back" value="${back}">
  <input type="hidden" name="zone" value="${values.zone ?? ""}" data-zone>
  <label><span class="field">What's happening</span><input name="title" required maxlength="200" value="${values.title ?? ""}"></label>
  <div class="when-row">
    <label><span class="field">Day</span><input type="date" name="start_date" required value="${values.start_date ?? ""}"></label>
    <label><span class="field">Time <span class="meta">(none for all day)</span></span><input type="time" name="start_time" value="${values.start_time ?? ""}"></label>
  </div>
  <div class="when-row">
    <label><span class="field">Ends <span class="meta">(if it runs on)</span></span><input type="date" name="end_date" value="${values.end_date ?? ""}"></label>
    <label><span class="field">Until <span class="meta">(optional)</span></span><input type="time" name="end_time" value="${values.end_time ?? ""}"></label>
  </div>
  <label><span class="field">Where <span class="meta">(optional)</span></span><input name="place" maxlength="300" value="${values.place ?? ""}"></label>
  ${repeats && html`<div class="when-row repeat-row">
    <label><span class="field">Repeats</span><select name="repeat">
      ${repeats !== "only" && html`<option value="">Doesn't repeat</option>`}
      ${repeatChoices(values.start_date ?? "").map(([value, words]) => html`<option value="${value}" ${values.repeat === value && raw("selected")}>${words}</option>`)}
    </select></label>
    <label><span class="field">Until <span class="meta">(a year if blank)</span></span><input type="date" name="repeat_until" value="${values.repeat_until ?? ""}"></label>
  </div>`}
  <label><span class="field">More about it <span class="meta">(optional)</span></span><textarea name="text" rows="3" maxlength="5000">${text}</textarea></label>
  ${guests}
  <div class="actions-row"><button class="chip primary">${submit}</button></div>
</form>
<script>
  for (const input of document.querySelectorAll("input[data-zone]")) {
    try { input.value ||= Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
  }
  // The ways it can repeat say which day: "Every week on Tuesday", "the second Tuesday", "the last Friday".
  for (const form of document.querySelectorAll("form.event-form")) {
    const day = form.querySelector("input[name=start_date]");
    const pick = form.querySelector("select[name=repeat]");
    if (!pick) continue;
    const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const nths = ["first", "second", "third", "fourth"];
    const th = (n) => n + (n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th");
    const ways = (y, m, d) => {
      const wd = names[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
      const n = Math.ceil(d / 7);
      return { weekly: "Every week on " + wd, fortnightly: "Every two weeks on " + wd, "monthly-date": "Every month on the " + th(d),
        "monthly-day": n <= 4 ? "Every month on the " + nths[n - 1] + " " + wd : null,
        "monthly-last": d + 7 > new Date(Date.UTC(y, m, 0)).getUTCDate() ? "Every month on the last " + wd : null };
    };
    const label = () => {
      const m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(day.value); // \\d: this is inside a template string
      if (!m) return;
      const words = ways(Number(m[1]), Number(m[2]), Number(m[3]));
      for (const [value, text] of Object.entries(words)) {
        let option = pick.querySelector('option[value="' + value + '"]');
        if (!option) { option = document.createElement("option"); option.value = value; pick.append(option); }
        option.textContent = text || "";
        option.hidden = option.disabled = !text;
      }
      if (pick.selectedOptions[0]?.disabled) pick.value = "";
    };
    day.addEventListener("change", label);
    label();
  }
</script>`;
}

// --- calendars: the owner's (Events) and each group's ----------------------------------------------------------------

const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const ANSWER_WORDS = { going: "You're going", maybe: "You might go", no: "You can't go" };

/**
 * A month as a grid, Monday first: each day with its events (on a wide screen, the start of each; on a phone, a dot
 * each), linking to that day's list under it. `items`: events as the calendar shows them, each with `href`, `kind`
 * (own, friend or group) and `answer`. `base`: the page's own address, for the month and day links.
 */
function calendarGrid(ctx, items, { month, day, base }) {
  const around = monthAround(month);
  const now = today(ctx.zone);
  const byDay = new Map();
  for (const e of items) for (const key of eventDays(e)) byDay.set(key, [...(byDay.get(key) ?? []), e]);
  const link = (q) => `${base}?${q}`;
  const cls = (e) => ["cal-event", `cal-${e.kind}`, e.cancelled_at && "off", !e.answer && e.kind !== "own" && "unanswered"].filter(Boolean).join(" ");
  return html`<section class="calendar" aria-labelledby="cal-month">
  <header class="cal-head">
    <a class="chip" href="${link(`month=${around.prev}`)}" aria-label="The month before">‹</a>
    <h2 id="cal-month">${around.name}</h2>
    <a class="chip" href="${link(`month=${around.next}`)}" aria-label="The month after">›</a>
    ${(now.year !== month.year || now.month !== month.month || day) && html`<a class="chip" href="${base}">Today</a>`}
  </header>
  <table class="cal-grid">
    <thead><tr>${WEEK.map((d) => html`<th scope="col"><abbr title="${d}">${d[0]}</abbr><span>${d.slice(1)}</span></th>`)}</tr></thead>
    <tbody>${monthWeeks(month).map((week) => html`<tr>${week.map((d) => {
      const list = byDay.get(d.key) ?? [];
      const classes = ["cal-day", !d.inMonth && "out", d.key === dateKey(now) && "today", day && d.key === dateKey(day) && "chosen", list.length && "busy"]
        .filter(Boolean).join(" ");
      return html`<td class="${classes}">
        <a class="cal-num" href="${link(`month=${around.key}&day=${d.key}`)}"${d.key === dateKey(now) && raw(' aria-current="date"')}
          aria-label="${d.day} ${around.name.split(" ")[0]}${list.length ? `, ${list.length} event${list.length > 1 ? "s" : ""}` : ""}">${d.day}</a>
        ${list.length > 0 && html`<ul class="cal-events">${list.slice(0, 3).map((e) => html`<li class="${cls(e)}"><a href="${e.href}">
          ${eventTime(e) && html`<span class="cal-time">${eventTime(e)}</span> `}${e.title}</a></li>`)}
          ${list.length > 3 && html`<li class="cal-more"><a href="${link(`month=${around.key}&day=${d.key}`)}">+${list.length - 3} more</a></li>`}</ul>
        <span class="cal-dots" aria-hidden="true">${list.slice(0, 4).map((e) => html`<span class="${cls(e)}"></span>`)}</span>`}
      </td>`;
    })}</tr>`)}</tbody>
  </table>
  <p class="cal-key meta"><span class="cal-own">Yours</span> <span class="cal-friend">A friend's</span> <span class="cal-group">A group's</span>
    <span class="unanswered">Not answered</span></p>
</section>`;
}

/** Month, Week or List, for a calendar at `base`, `view` being the one shown. */
function calendarSwitch(base, view) {
  return html`<nav class="tabs cal-views" aria-label="Show the calendar by">
  ${[["month", "Month"], ["week", "Week"], ["list", "List"]].map(([key, label]) =>
    html`<a href="${key === "month" ? base : `${base}?view=${key}`}" ${key === view && raw('aria-current="page"')}>${label}</a>`)}
</nav>`;
}

/** A week's heading, with the weeks either side and back to this one. */
function weekHead(ctx, week, base) {
  const around = weekAround(week);
  const now = dateKey(today(ctx.zone));
  return html`<header class="cal-head">
  <a class="chip" href="${base}?view=week&week=${around.prev}" aria-label="The week before">‹</a>
  <h2 id="cal-week">${around.name}</h2>
  <a class="chip" href="${base}?view=week&week=${around.next}" aria-label="The week after">›</a>
  ${!around.days.some((d) => d.key === now) && html`<a class="chip" href="${base}?view=week">This week</a>`}
</header>`;
}

/**
 * The days of a week (from its Monday), each with what's on it: `entry(e)` draws each one (a row on Events, a card
 * on a group's calendar).
 */
function weekDays(ctx, items, week, entry) {
  const now = dateKey(today(ctx.zone));
  return html`<ol class="cal-week">${weekAround(week).days.map((d) => {
    const list = items.filter((e) => eventDays(e).includes(d.key));
    return html`<li class="cal-week-day${d.key === now ? " today" : ""}">
      <h3>${dayName(d)}${d.key === now && html` <span class="badge">Today</span>`}</h3>
      ${list.length ? entry(list) : html`<p class="meta">Nothing on.</p>`}
    </li>`;
  })}</ol>`;
}

/** Everything still to come, by the month it starts in: `entry(list)` draws each month's. */
function upcomingByMonth(items, entry, empty = "Nothing coming up.") {
  const months = [];
  for (const e of items) {
    const d = eventDay(e);
    if (months.at(-1)?.[0] !== d.monthKey) months.push([d.monthKey, d.monthName, []]);
    months.at(-1)[2].push(e);
  }
  return months.length ? months.map(([, name, list]) => html`<h2 class="month">${name}</h2>${entry(list)}`) : html`<p class="empty">${empty}</p>`;
}

/** Events as rows: date tile, title, when, where, whose, and the owner's answer. */
function eventRows(ctx, list) {
  return html`<ul class="plan-list">${list.map((e) => html`<li class="${e.cancelled_at ? "off" : ""}"><a href="${e.href}">
    ${dateTile(e)}
    <span class="what"><strong>${e.title}</strong>
      <span class="meta">${eventWhen(e, ctx.zone)}${e.place && ` · ${e.place}`}</span>
      <span class="meta">${e.who}${e.kind !== "own" && ` · ${ANSWER_WORDS[e.answer] ?? (e.kind === "friend" ? "Invited: not answered yet" : "Not answered")}`}</span></span>
    ${e.cancelled_at && html`<span class="badge as-written">Called off</span>`}
  </a></li>`)}</ul>`;
}

/** The events on a calendar's chosen day, or in its month, as a list: date tile, title, when, where and whose. */
function calendarList(ctx, items, { month, day }) {
  const want = day ? [dateKey(day)] : null;
  const prefix = monthAround(month).key;
  const shown = items.filter((e) => eventDays(e).some((k) => (want ? want.includes(k) : k.startsWith(prefix))));
  const heading = day ? dayName(day) : monthAround(month).name;
  return html`<section class="cal-list" aria-label="Events: ${heading}">
  <h2>${heading}</h2>
  ${shown.length ? eventRows(ctx, shown) : html`<p class="empty">${day ? "Nothing on that day." : "Nothing this month."}</p>`}
</section>`;
}

/** An invitation still to answer, with the three answers right there. */
function invitationCard(ctx, e) {
  // Its answer is signed here (views/items.js), and passed on by this site.
  const signed = raw(` data-sign="answer" data-sign-item="${e.key}" data-sign-host="${e.list.host}" data-sign-seen-n="${e.list.seen.n}"`
    + ` data-sign-seen-h="${e.list.seen.h}" data-sign-prev="${e.list.mine ?? ""}" data-sign-version="${e.version}"`);
  return html`<li class="card invitation" id="inv-${e.connection}-${e.key}" data-region="">
  <a class="what" href="${e.href}">${dateTile(e)}<span><strong>${e.title}</strong>
    <span class="meta">${eventWhen(e, ctx.zone)}${e.place && ` · ${e.place}`}</span>
    <span class="meta">${e.who} invited you</span></span></a>
  <form method="post" action="${e.relay}" class="answers" aria-label="Are you going to ${e.title}?"${signed}>
    <input type="hidden" name="back" value="/events"><input type="hidden" name="connection" value="${e.connection}">
    <input type="hidden" name="target" value="${e.key}">
    ${ANSWER_LABELS.map(([value, label]) => html`<button class="chip" name="answer" value="${value}">${label}</button>`)}
  </form>
</li>`;
}

/** Events: invitations to answer, the owner's calendar, and making an event. */
export function eventsPage(ctx, { view, month, day, week, items, invitations, friends, pushKey }) {
  return page(ctx, "Events", html`
<div class="feed-head">
  <h1>Events</h1>
  <a class="chip primary" href="#make">${raw(icon("calendar"))}<span>Make an event</span></a>
</div>
${invitations.length > 0 && html`<section class="invitations">
  <h2>Invitations</h2>
  <ul class="invitation-list">${invitations.map((e) => invitationCard(ctx, e))}</ul>
</section>`}
${calendarSwitch("/events", view)}
${view === "month" ? html`${calendarGrid(ctx, items, { month, day, base: "/events" })}${calendarList(ctx, items, { month, day })}`
    : view === "week" ? html`<section class="calendar" aria-labelledby="cal-week">${weekHead(ctx, week, "/events")}
      ${weekDays(ctx, items, week, (list) => eventRows(ctx, list))}</section>`
    : html`<section class="cal-upcoming" aria-label="Coming up">${upcomingByMonth(items, (list) => eventRows(ctx, list))}</section>`}
<details class="card add-event" id="make">
  <summary>Make an event</summary>
  <p class="meta">Only the friends you invite see it, on their own sites. They're told you've invited them, and those who
  haven't said no are told if it changes or is called off. Nothing else is sent.</p>
  ${eventForm({ action: "/_admin/items", back: "/events", submit: "Make the event", sign: ' data-sign="event-new"',
    guests: guestPicker(friends, { none: "You have no friends on afterwrd to invite yet. You can still make it, and invite people later." }) })}
</details>
${notificationsSwitch(pushKey)}
<script>
  // "Make an event" opens the form.
  if (location.hash === "#make") document.getElementById("make").open = true;
  document.querySelector('a[href="#make"]').addEventListener("click", () => { document.getElementById("make").open = true; });
</script>`);
}

/**
 * Notifications on this device (push.js; public/static/notifications.js does the asking): only for invitations, and
 * for changes to events the owner hasn't said no to. Without scripts it only says it's checking.
 */
function notificationsSwitch(pushKey) {
  return html`<section class="card notify" id="notify" data-key="${pushKey}">
  <h2>Notifications on this device</h2>
  <p class="meta">Only when a friend invites you to an event, an event you haven't said no to changes or is called off,
  or someone mentions you (or writes @here in a group you're in): never for other posts, comments or anything else.</p>
  <p id="notify-status">Checking this device…</p>
  <div class="row">
    <button class="chip primary" data-do="on" hidden>Turn on notifications</button>
    <button class="chip" data-do="off" hidden>Turn them off</button>
  </div>
  <label id="notify-preview" hidden><input type="checkbox"> Show what it's about on the lock screen (otherwise just who it's from)</label>
  <label id="notify-mentions" hidden><input type="checkbox"> Mentions too (otherwise only events)</label>
  <p class="meta" id="notify-android" hidden>If they only turn up when you unlock your phone, Android is saving battery: set
  Chrome's battery use to <strong>Unrestricted</strong> (Settings → Apps → Chrome → Battery). afterwrd's notifications
  come through Chrome.</p>
  <p class="error" id="notify-error" role="alert"></p>
</section>
<script src="${asset("/static/notifications.js")}" type="module"></script>`;
}

/**
 * A group's calendar: a month of its events on the grid, the month's (or a chosen day's) events under it to answer,
 * and adding one. The group lists 100 to come and the 30 most recent; earlier months may be missing some.
 */
export function groupCalendarPage(ctx, { membership: g, group: info, upcoming, past, view, month, day, week, from, to }) {
  if (info) g.ownerFrom = info.ownerFrom;
  // A group's events are its posts, drawn as they are on its page, and added signed.
  const ownerPerson = info?.people?.find((p) => p.origin === info.ownerFrom)?.person ?? null;
  const base = `${groupBase(g)}/calendar`;
  const posts = [...past.slice().reverse(), ...upcoming];
  // Every date, a repeating event's each on its own, with the owner's answer to it.
  // Only the dates this view shows are worked out: a group may hold many events that repeat.
  const items = posts.flatMap((p) => datesOf(p.event, { from, to }).map((d) => ({ ...d, kind: "group", who: info?.name ?? g.name,
    href: `${groupBase(g)}/posts/${p.id}${d.date ? `?date=${d.date}` : ""}` })));
  const want = (p) => datesOf(p.event, { from, to }).flatMap(eventDays).some((k) => (day ? k === dateKey(day) : k.startsWith(monthAround(month).key)));
  const shown = posts.filter(want);
  // A month before the oldest event the group still lists (past is newest first) may have had others.
  const missing = past.length >= 30 && monthAround(month).key < eventDays(past.at(-1).event)[0].slice(0, 7);
  const card = (p) => groupItemCard(ctx, g, p, { ownerPerson });
  const at = Date.now() / 1000;
  // The month: the grid, then its events as cards to answer; a week, or what's to come: each date as a row.
  const shownView = view === "week" ? html`<section class="calendar" aria-labelledby="cal-week">${weekHead(ctx, week, base)}
      ${weekDays(ctx, items, week, (list) => eventRows(ctx, list))}</section>`
    : view === "list" ? html`<section class="cal-upcoming" aria-label="Coming up">${upcomingByMonth(items.filter((e) => finishedAt(e) >= at),
      (list) => eventRows(ctx, list))}</section>`
    : html`${calendarGrid(ctx, items, { month, day, base })}
${missing && html`<p class="meta">The group only lists its 30 most recent events: older ones aren't shown.</p>`}
<h2 class="month">${day ? dayName(day) : monthAround(month).name}</h2>
${shown.length ? html`<div class="feed">${shown.map(card)}</div>` : html`<p class="empty">${day ? "Nothing on that day." : "Nothing this month."}</p>`}`;
  return page(ctx, `${info?.name ?? g.name}: calendar`, html`
${groupHead(ctx, g, info, "calendar")}
${!g.closed_at && html`<details class="card add-event" ${!upcoming.length && raw("open")}>
  <summary>Add an event</summary>
  <p class="meta">Everyone in the group will see it here. No one is sent anything about it; those who say they're
  going, or might, are told if it changes or is called off.</p>
  ${eventForm({ action: `/_groups/${g.id}/items`, back: base, submit: "Add the event", repeats: true,
    sign: ` data-sign="event-new" data-sign-host="${g.identity}" data-sign-group="${g.id}" data-sign-to="/_groups/${g.id}/items"` })}
</details>`}
${calendarSwitch(base, view)}
${shownView}`);
}

/** " (3 you know)", when some of `list` (answers) aren't people the owner here knows (names.js); otherwise nothing. */
function youKnow(list) {
  if (!list.length || list[0].known === undefined) return "";
  const n = list.filter((x) => x.known).length;
  return n < list.length ? ` (${n} you know)` : "";
}
