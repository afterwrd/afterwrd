// A made-up social network shaped like Facebook's, for the scale test (net.mjs --model social), the same every time
// for the same seed:
// - Friend counts as Facebook's: a median of about 200 and an average of about 330 (Pew Research, 2014: median 200,
//   average 338), so most people have 100–400 and a few have thousands; never more than everyone, or Facebook's 5,000.
// - People belong to a few overlapping circles (a family, a workplace, a school, a town, a club), and most friends come
//   from them, so friends have friends in common; the rest are long-range. Busier people belong to more circles.
// - Groups grow out of circles: their members are mostly the owner's circles, then their friends, then anyone.
// The few with the most friends are the outliers (role "hub"): Home, posting to everyone and their CPU are measured for
// them one by one. Everyone else is role "leaf"; the groups are role "group".

/** A small seeded random number generator (mulberry32): the same network for the same seed. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const normal = (random) => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());

/** Picks by weight, quickly, many times over (cumulative weights and a binary search). */
function picker(weights, random) {
  const sums = new Float64Array(weights.length);
  let total = 0;
  weights.forEach((w, i) => { total += w; sums[i] = total; });
  return () => {
    const x = random() * total;
    let lo = 0;
    let hi = sums.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sums[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}

/**
 * The network: `people` people (0…people-1), each with `circles` (indexes into circles) and a target `degree`; the
 * friendships as pairs [a, b] (a < b); and groups of the given sizes, each with an owner and members.
 * @param {{ people: number, seed?: number, median?: number, sigma?: number, outliers?: number, local?: number,
 *   groups?: number[] }} options
 */
export function socialNetwork({ people, seed = 1, median = 200, sigma = 0.9, outliers = 10, local = 0.8, groups = [] }) {
  const random = seeded(seed);
  const cap = Math.min(5000, people - 1);
  // Friend counts: lognormal (median `median`; sigma 0.9 gives an average of about 1.5 times that, as Facebook's).
  const degree = Array.from({ length: people }, () => Math.max(2, Math.min(cap, Math.round(median * Math.exp(sigma * normal(random))))));

  // Circles: families (4–15), workplaces and schools (20–150), towns and clubs (50–400). Each person is in some, more
  // the more friends they have; the outliers span many.
  const kinds = [{ min: 4, max: 15, share: 0.5 }, { min: 20, max: 150, share: 0.35 }, { min: 50, max: 400, share: 0.15 }];
  const memberships = degree.map((d) => Math.max(2, Math.round(2 + Math.log2(d / 25))));
  const slots = memberships.reduce((a, n) => a + n, 0);
  const circles = [];
  let filled = 0;
  while (filled < slots) {
    const r = random();
    const kind = r < kinds[0].share ? kinds[0] : r < kinds[0].share + kinds[1].share ? kinds[1] : kinds[2];
    const size = Math.min(people, Math.round(kind.min + (kind.max - kind.min) * random() ** 2));
    circles.push({ size, members: [] });
    filled += size;
  }
  const inCircles = Array.from({ length: people }, () => []);
  const pickPerson = picker(memberships, random);
  for (const [c, circle] of circles.entries()) {
    const chosen = new Set();
    for (let tries = 0; chosen.size < circle.size && tries < circle.size * 20; tries++) chosen.add(pickPerson());
    circle.members = [...chosen];
    for (const p of circle.members) inCircles[p].push(c);
  }

  // Friendships: each person reaches out for half their count (others reach out to them for the rest), `local` of it
  // within their circles (more likely to someone with many friends), the rest to anyone.
  const pickAnyone = picker(degree, random);
  const key = (a, b) => (a < b ? a * people + b : b * people + a);
  const edges = new Set();
  const have = new Uint32Array(people);
  const add = (a, b) => {
    if (a === b || have[a] >= degree[a] || have[b] >= degree[b]) return false;
    const k = key(a, b);
    if (edges.has(k)) return false;
    edges.add(k);
    have[a]++;
    have[b]++;
    return true;
  };
  for (let p = 0; p < people; p++) {
    const want = Math.ceil(degree[p] / 2);
    const mine = inCircles[p].flatMap((c) => circles[c].members);
    for (let made = 0, tries = 0; made < want && tries < want * 10; tries++) {
      const other = random() < local && mine.length ? mine[Math.floor(random() * mine.length)] : pickAnyone();
      if (add(p, other)) made++;
    }
  }
  // Then anyone still well short is topped up from friends of friends (as people meet through others), then anyone.
  const friends = Array.from({ length: people }, () => []);
  for (const k of edges) {
    const a = Math.floor(k / people);
    const b = k % people;
    friends[a].push(b);
    friends[b].push(a);
  }
  for (let p = 0; p < people; p++) {
    for (let tries = 0; have[p] < degree[p] * 0.9 && tries < degree[p] * 10; tries++) {
      const via = friends[p].length ? friends[p][Math.floor(random() * friends[p].length)] : null;
      const other = via !== null && friends[via].length && random() < 0.7 ? friends[via][Math.floor(random() * friends[via].length)] : pickAnyone();
      if (add(p, other)) {
        friends[p].push(other);
        friends[other].push(p);
      }
    }
  }
  const pairs = [...edges].map((k) => [Math.floor(k / people), k % people]);
  const realised = friends.map((f) => f.length);

  // The outliers: those with the most friends.
  const byFriends = [...realised.keys()].sort((a, b) => realised[b] - realised[a]);
  const hubs = new Set(byFriends.slice(0, outliers));

  // Groups, biggest first: owned by people with a middling count (so a group's cost is its own), except one in the
  // middle owned by the biggest outlier (a group and a busy person on one account). Members: the owner's circles, then
  // their friends, then anyone.
  const sizes = [...groups].sort((a, b) => b - a);
  const middling = byFriends.slice(Math.floor(people * 0.4), Math.floor(people * 0.6));
  const madeGroups = sizes.map((size, i) => {
    const owner = i === Math.floor(sizes.length / 2) ? byFriends[0] : middling[Math.floor(random() * middling.length)];
    const members = new Set([owner]);
    const pool = [...new Set(inCircles[owner].flatMap((c) => circles[c].members))];
    for (const from of [pool, friends[owner]]) {
      for (const p of [...from].sort(() => random() - 0.5)) {
        if (members.size >= size) break;
        members.add(p);
      }
    }
    for (let tries = 0; members.size < Math.min(size, people) && tries < size * 20; tries++) members.add(pickAnyone());
    members.delete(owner);
    return { size, owner, members: [...members] };
  });

  return { degree: realised, circles: circles.map((c) => c.members), inCircles, pairs, hubs, groups: madeGroups };
}

/** A summary of friend counts, to print and to keep: quantiles, the average, and how many have over 500 and 1,000. */
export function describe(counts) {
  const sorted = [...counts].sort((a, b) => a - b);
  const q = (x) => sorted[Math.min(sorted.length - 1, Math.floor(x * sorted.length))];
  return { people: counts.length, median: q(0.5), average: Math.round(counts.reduce((a, b) => a + b, 0) / counts.length),
    p10: q(0.1), p90: q(0.9), p99: q(0.99), most: sorted.at(-1), over500: counts.filter((c) => c > 500).length,
    over1000: counts.filter((c) => c > 1000).length, friendships: counts.reduce((a, b) => a + b, 0) / 2 };
}
