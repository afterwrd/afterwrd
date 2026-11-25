# afterwrd

A small, private social network of your own, with your Facebook years brought along. Post and share photos, comment,
make events, and connect with friends who have their own afterwrd site; your Facebook download (posts, photos, comments, likes,
friends) comes too, under *Memories*. Only you sign in to your site; friends see it from their own. It runs in your own
free Cloudflare account (or on a server of your own), so no one else holds your data. Setting it up on Cloudflare needs
no terminal, no GitHub account and no card.

afterwrd isn't affiliated with or endorsed by Meta. It only reads the "Download your information" file Facebook
gives you; it never signs in to Facebook or fetches anything from it.

**Finding your way round.** *Home* is your posts and your friends' together, with a box to write in; *Photos*,
*Friends*, *Groups*, *Events* and *Notifications* sit beside it. Your picture (top right) opens your profile, *Memories*
(everything from Facebook, with "On this day"), your tools: *Your devices*, *Add to home screen*, *Import*,
*Download everything* and *Update*, and *Help*: how afterwrd works, where to turn when something's wrong, and what to
do when something isn't working (it's on <https://afterwrd.app/help/> too).

**The app, and events on your phone.** Add afterwrd to your phone's home screen and it opens like an app. Turn on
notifications on the *Events* page and it can tell you, even with the phone locked, when a friend invites you to an
event, or one you haven't said no to changes or is called off, when someone mentions you (each phone can turn
mentions off), and when someone thinks something on your post, or in a group you help run, might be illegal (a few a
day at most). Nothing else: never posts, comments or likes. (There are no messages between friends: WhatsApp, Signal and the like do that better.) The
notification is encrypted for your phone by your own site, so the phone's push service (Apple's or Google's) passes it
on without being able to read it; there's no afterwrd server in between.

## What it looks like

Home, with your posts and friends' together (friends' posts come from their own sites):

<img src="docs/screenshots/home-desktop.png" alt="Home: a post with a photo of a birthday cake and friends' comments, beside a list of friends" width="760">

A friend's page, read from their site; a group with its events; and on a phone, Home and a group's calendar:

<img src="docs/screenshots/friend-desktop.png" alt="A friend's page: their post with three photos and a comment" width="370"> <img src="docs/screenshots/group-desktop.png" alt="A book club group: two events with Going, Maybe and Can't go, and a post with a comment" width="370">

<img src="docs/screenshots/home-phone.png" alt="Home on a phone" width="240"> <img src="docs/screenshots/calendar-phone.png" alt="A group's calendar on a phone" width="240">

<sub>The people and photos are made up (`npm run test:e2e -- screenshots` makes these pictures from local sites).</sub>

## How sites talk to each other

Each site is its own: friends' and groups' sites ask it for what their owner may see, in calls their own site signs.
Everything anyone writes is signed in their own browser, and the site that keeps a conversation signs where it's up
to, so no site can change, invent or quietly drop what someone else said. To keep Home quick, a site keeps a short-lived copy of each friend's newest posts; everything else is read
when you look. [PROTOCOL.md](PROTOCOL.md) describes the requests and what's sent,
for anyone curious or wanting to build something that talks to afterwrd.

## How afterwrd is made

afterwrd is written using an AI coding assistant (Anthropic's Claude), which has written all of its code. The
direction, and the decisions that shape it, are carefully considered human ones:
- what afterwrd is for, and what it deliberately isn't;
- keeping it private by default: friends see only what you share, from their own sites;
- one person per site, free to run, with no server to look after;
- calm, with no nudges or "X is going" notifications;
- every feature, and every one left out.

Because of that, it's built to be checked rather than trusted:

- **All the code is public**, under the GNU Affero General Public License, and every release is built from a tagged
  commit.
- **More than 1,200 automated checks** run real copies of afterwrd on one computer, talking to each other as friends' sites
  and groups do, including deliberately forged and hostile requests. They run before every release.
- **Security reviews at each major step,** by separate AI agents reading the code without having written it. Every
  real finding has been fixed. There hasn't yet been a review by a human security expert, and one would be very
  welcome.
- **How sites talk to each other is written down** in [PROTOCOL.md](PROTOCOL.md), so the design can be examined and
  criticised on its own terms.

Found a problem? Please [open an issue](https://github.com/afterwrd/afterwrd/issues). For anything security-related,
[report it privately](https://github.com/afterwrd/afterwrd/security/advisories/new) instead, so it can be fixed before
it's public (see [SECURITY.md](SECURITY.md)).

## Install your own

Two ways: in a free Cloudflare account of your own (the easy way, and the one most people take), or on your own
server.

### In your own Cloudflare account

You need a free Cloudflare account and a few minutes, on a phone or a computer. Bringing your Facebook years is optional,
and can be done any time.

1. **Make a Cloudflare account** at <https://dash.cloudflare.com/sign-up>. An email address is all it asks
   for; don't add a card. If you already use Cloudflare for other things, make a new account just for afterwrd:
   installing and updating ask for permission over every Worker and database in the account, for an hour, so in an
   account of its own that's only afterwrd.
2. **Install.** Stay signed in to Cloudflare, open <https://afterwrd.app/> and press *Install*. afterwrd's installer at
   <https://install.afterwrd.app/> connects to your Cloudflare account (you press *Allow* on Cloudflare's page; it lasts
   an hour and nothing is kept), asks your name (and makes your address from it, `afterwrd.<your-name>.workers.dev`,
   if the account hasn't one yet), and puts afterwrd there.
3. **Make yourself the owner.** The installer sends you straight to your new site: give your name and create a
   passkey (your face, fingerprint or device PIN; there's no password). Next comes your recovery code: it's made in
   your browser and shown once, and your site doesn't keep it, so write it down somewhere safe. One more face,
   fingerprint or PIN then sets up your identity, the keys everything you write is signed with. It then asks whether
   your site may keep itself up to date and let friends' sites check it's genuine. Then write a post, add photos, and connect with friends
   from *Friends*.
4. **Optional: bring your Facebook years.** On Facebook's *Download your information* page, choose your
   profile, *All available information*, format **JSON**, media quality *High*. Facebook emails you when it's
   ready (from minutes to a day). Then choose *Import* in afterwrd's menu, pick the zip file(s), tick what to
   bring and press *Import and publish*. Your browser reads the download; only what you tick is uploaded. If you tick
   *Friends*, your Facebook friends then appear on *Friends*, each with an *Invite* button that makes a message to send
   them.

Connecting uses Cloudflare's own sign-in for apps: afterwrd is a registered app there, and you can see or revoke what
you've allowed under *My Profile* → *Connected Applications*. The installer runs in the maintainer's Cloudflare account,
so it's one more thing to trust; it installs only a release signed with afterwrd's own key, and checks every file it
downloads against that release's signed list, so what's installed is exactly the signed release. Cloudflare's free plan allows 5 GB of photos and videos. To check a
release for yourself, see [Check it yourself](SECURITY.md#check-it-yourself).

### On your own server

afterwrd doesn't need Cloudflare. With Docker on a server of your own (a home server, a Raspberry Pi or a rented one)
and an address for your site, a [Docker image](worker/selfhost/README.md) runs the same afterwrd on workerd, the
open-source engine Cloudflare's Workers run on, with Caddy in front for HTTPS. It can be friends and share groups with
sites on Cloudflare. Friends' sites can't check a self-hosted site (nothing outside your server can say what runs on
it), so keeping it safe is up to you. See [worker/selfhost/README.md](worker/selfhost/README.md).

### Keeping it safe

- **Turn on two-factor authentication for your Cloudflare account** (My Profile → Authentication). Anyone who gets
  into that account can see your whole site.
- **Keep your recovery code somewhere safe**, away from your devices. It's what gets you signing again if you lose
  every device that signs for you (see *Your devices*, below), and only it can cancel a change made with it.
- **Only open a device link on your own phone or computer**: whoever opens it first can sign in as you, so it works
  once and lasts an hour. It can't post or comment as you until a device that already signs for you lets it.
  *Your devices* can cancel unused links, remove a passkey or sign out everywhere.
- **Approve only friends you know.** A friend link can be passed on, so each one only asks: nothing is
  shared until you approve the request on *Friends*.
- **Photo locations are removed** from photos you post, and left out of a Facebook import unless you tick *Photo
  locations*; they can show where you live.
- **Keep it up to date.** With automatic updates on (asked when you set up, or turned on from the *Update* page, one
  *Allow*), the site installs each signed release by itself after a few days, or straight away with *Install it now*,
  its groups following. Otherwise the *Update* page installs a newer signed release, keeping your passkeys, friends
  and archive. Home says so when an update fixes a security problem. To hear about every release, *Watch* the repository
  on GitHub (*Custom* → *Releases*) or follow its [releases feed](https://github.com/afterwrd/afterwrd/releases.atom).
- **Let your friends' sites check it.** One more *Allow* (read-only), and a few times a week a friend's afterwrd site
  checks yours is exactly a signed release, with nothing else uploaded in its place since the last check. A finding
  shows on both your Homes.
- **Watch for new devices.** When a passkey is added, Home on your other devices says so for two weeks. If it
  wasn't you, remove it in *Your devices*. Removing a device that signs for you, or using your recovery code, takes 7
  days, and every device says so until then, with a way to cancel, so someone who gets hold of one of your devices
  can't quietly lock you out.
- **Lost every device you sign in with?** *Lost your device?* on the sign-in page gets you back in, as long as you
  can still sign in to the Cloudflare account your site is in: Cloudflare is asked for an hour's access to change its
  Workers (your site uses it only to prove it's in that account, by making its running version live again), then it
  signs every device out and lets you make a passkey on the one you're using. That gets you signed in; to sign posts
  and comments again, use your recovery code in *Your devices*.
- **Use a Cloudflare account just for afterwrd** if you use Cloudflare for anything else (see step 1).

(On your own server, some of this is different: see [worker/selfhost/README.md](worker/selfhost/README.md).)

## Using your site

`worker/` is the Worker that runs your site; only you sign in, with a passkey. You import from a page on the site
itself: your browser reads the Facebook download and uploads only the sections you choose. Everything goes into your
site's own Durable Objects (SQLite inside each): the posts, people and the rest into the site's own object, which
builds its pages right next to them, and photos and videos into a set of their own. Cloudflare's free plan covers it
with no card needed: Workers and SQLite-backed Durable Objects only, no R2 or Zero Trust. (A site still gets a D1
database, which sites from before 0.57.0 kept everything in; it's left as it was, a safety copy, and a later version
stops making it.)

Once it's installed, nothing needs the terminal:

- **Import** again whenever you have a newer download, or to change what's published. Files already on the
  site aren't uploaded again, and files the new import doesn't use are deleted. Friends see the old version
  until the new one is complete.
- **Your devices** adds another phone or computer: make a one-time link there and open it on the new device, which
  makes its passkey; then press *Let it sign for you* on the device you made the link with, and the new one asks once
  more so its browser can sign too. It also removes a passkey (never your last one), signs out everywhere, and keeps
  your recovery code: *Use my recovery code* if you've lost every device that signs for you (the passkeys on your site
  then become the ones that sign, after 7 days), or make a new one. Only the owner signs in; there's no inviting
  others to your site, because friends see it from their own.
- **Signed, and checked.** Everything you post, comment, vote or answer is signed in your own browser before it
  leaves it, and the site that keeps a conversation signs the order it took things in. Your site checks every
  signature and the whole conversation when it shows you a friend's or group's post: a comment someone's site has
  changed is hidden and says it didn't pass its check, and one quietly left out makes the conversation say it doesn't
  add up. So no site, yours included, can change what someone else wrote or put words in their mouth.
- **Photos and albums.** *Add photos* (on Photos) puts photos into a new or existing album, optionally shared
  as a post so friends see them on their Home. Albums you make can be renamed, described or deleted, and photos added
  here can be deleted. Any photo can be made your profile picture or cover, or upload one for it; they head
  your profile, and friends see your picture beside your posts.
- **New posts.** Write posts with up to 20 photos from the box on *Home* (or your profile). A post can carry a poll
  (polls are open: everyone who can see one sees who chose what), mention friends by typing @, and be shown to all
  your friends or only those you choose. Each photo in a post has its own page and comments. You can change a post or
  comment for 15 minutes, until someone else replies; it's marked *Edited*, with what it said before. Photos are resized to at most 2560px in the browser before uploading, which also removes the
  details phones hide in them (such as where a photo was taken), and they're collected in a *Posted on
  afterwrd* album. Importing again keeps them; deleting a post deletes its photos and comments.
- **Update** (marked when a new signed release is out) shows what's new and installs it: press *Connect Cloudflare*,
  *Allow* on Cloudflare's page, and it goes ahead, switching straight back if the new version doesn't work, and your
  groups follow. With automatic updates on, it says when the release will install itself, with *Install it now*. It's
  also where automatic updates and friends' checks are turned on or off, with what's coming next, what last happened,
  and what your site's checks of your friends' sites found. The connection lasts an hour and nothing is kept; sites updated
  from versions before 0.20.0 are offered *Forget it* for the token they used to remember.
- **Download everything** (the download icon) saves the whole site as one zip: posts, photos and videos,
  albums, comments (those written here, and yours on friends' sites), polls, events, earlier versions of edited posts
  and comments, likes, friends and connections, as
  [ActivityStreams](https://www.w3.org/TR/activitystreams-core/) JSON, the open format the fediverse uses, with
  every photo and video, and `signed.json`: what proves your posts and comments are as you wrote them. Everything
  has a permanent address on your site, so two friends' downloads agree on which comment replied to which post. The
  README inside explains the files. Keys and sign-in details are never included.
- **Moving your site** to a new address (one on your own server, say) keeps who you are. On the new site, *Import* →
  *Bring everything over* asks to move your identity there; you agree on your old site, and after 7 days (you can
  cancel until then) your Download everything zip brings your posts, comments and friends in, every post checked on
  the way. Friends' sites follow you to the new address, and your old site says where you've gone. Groups don't come:
  join them again from the new site.
- **Friends** (the owner's alone) is one list: friends on afterwrd first, each with their posts and photos, then
  everyone from the Facebook download, marked *on afterwrd*, *invited*, or with an *Invite* button. Invite makes a
  friend link for that person (it lasts 30 days) and a message to send; when it's used you'll see who the invite
  was for, and approving links them to their Facebook self. Otherwise, say which Facebook friend an afterwrd friend
  is (matching names are suggested; nothing is linked without you), and their page links to your Facebook history
  together. Requests to be friends show on *Home* and at the top of *Friends* (with a count in the menu) for *Approve* or
  *Decline*, with why they came: a link, a group you're both in, a friend in common, or a friend's introduction.
- **Without a link.** A group's *Members* page has *Ask to be friends* by each member you're not friends with (the site
  asked checks with the group that you're in it), and so does a member's name on their comment. The name of someone who
  commented on a friend's post asks them too: your friend's site passes it on, if they're its owner's friend as well,
  and they see "You're both friends with …" (it never says who isn't). A friend's name leads to their page. *Introduce* on a friend's card tells them and another friend about
  each other, with a note if you like; each sees it on *Home* and *Friends* and can ask. Someone you decline or remove can't ask again
  this way (you still can). There's no "people you may know": it would reveal who your friends' friends are.
- **Adding friends.** *Friends → Add a friend* makes a one-time friend link (30 days) inside a message to
  send. Someone with an afterwrd site pastes it into *Add a friend* on their own site (or opens it and says where their site is), and confirms there. Someone without one
  presses *Set up your own afterwrd*: the installer carries the link along (after the `#`, so no server sees it),
  and their new site asks them to confirm as soon as they've made their passkey. Then you approve their request. Connections are mutual, and make you friends: *Home* shows the newest posts written
  on each friend's site, and either of you can read the other's posts and photos (everything they've published)
  without leaving your own site: press their name. Comments you make are stored on your friend's site, with a
  copy kept on yours. Their photos and videos load straight from their site through links it makes for your site alone,
  which last a day or two and stop working if either of you removes the other. Friends see what you've
  written on afterwrd, plus any parts of your Facebook download you chose to publish when importing. Either of you can press *Remove friend* on the other's page,
  which ends it all at once. If a friend's site stops answering for a day, Home stops mentioning it and *Friends*
  says so instead, so you can remove them. Two sites in the same Cloudflare account can connect too.
- **Groups.** Each group is its own small site: *Groups → Start a group* makes it a Worker of its own, with its own
  database, in your Cloudflare account (you *Connect Cloudflare* and *Allow*, for an hour; on your own server, a command
  there makes it). It runs afterwrd in group mode: it holds the group and nothing else, and no one signs in to it.
  You and its members use it from your own sites, so being in a group isn't being friends, and a group can do nothing
  on its members' sites but send them notes about the group and say when they've been removed. Make an invite link on its *Members* page and send it round: anyone with an afterwrd site
  can use it for 14 days, but each use is only a request, and the group's admins let people in (up to 1,000
  members). Joining, letting people in, admins and leaving are each signed by whoever did them, so anyone in the group
  can check who's in and who decided. The owner can make members admins, and admins can remove people and delete
  anything in the group, signed, so it says who removed what; *Remove and clear up* also removes everything that
  person wrote there, and someone removed can't ask to join again unless an admin lets them. A group can have rules,
  shown to anyone before they ask to join. Members can post (with up to 8 photos, which are copied
  to the group), comment and vote, all signed by whoever wrote it, and a copy of their own words stays on their site.
  Your site keeps a group's newest posts, asking it what's new in the background, and checks each conversation when
  you open it. Polls in a group are open to everyone in it. The owner can close a group: everyone in it is told, it
  stays readable for 30 days so people can delete what they wrote, and then it goes. Nothing is sent round when someone posts,
  unless it mentions someone (and *@here*, for the group's admins, tells everyone): a comment sends a quiet note only to the people who wrote that post or commented on it, which shows in their
  *Notifications*. Each group has a *Calendar*: any member can add an event, and members say whether they're
  going. Adding one sends nothing to anyone; if you've said you're going, or might, you're told when its time, place
  or name changes or it's called off, and it's on your *Events* calendar. An event can repeat (every week, every two
  weeks, or monthly on the same date or weekday, for up to a year): people answer each date, and one date can be
  called off on its own. Only whoever added an event can
  change it; they, and the group's admins, can call it off. *Add to my calendar* downloads it for your phone's or
  computer's own calendar. The *Update* page brings your groups up to your site's version, and deleting a group removes its
  Worker and database. A free Cloudflare account holds about 9 groups besides your site (10 databases in all).
- **Events.** *Events → Make an event* makes one on your own site and invites the friends you tick: only they see
  it, from their own sites, where it shows in *Notifications* and on their *Events* page. They answer Going, Maybe or
  Can't go, and everyone invited sees who's going, who might and who can't. Change it or call it off, and everyone invited who hasn't said no is told. You can
  invite more people later, or quietly take an invitation back. *Events* also shows a calendar of everything you could
  go to, your own events, friends' and your groups', by month, week or as a list.
- **Comments.** You and your friends (from their own sites) can comment under a post or photo made on afterwrd;
  they sit behind *Comments* and open where you are. Friends can delete their own. On your own posts and photos you
  can remove anyone else's comment from its menu (everyone who can see the post sees that you did), and turn comments
  off, or back on, for any post. A deleted or removed comment's words are gone for good. *Notifications* lists comments on
  your posts and photos, comments on friends' posts and photos you've commented on too, mentions, invitations, changes
  to events you're going to, and comments in your groups, with a count in the menu of those that are new to you.
  Comments stay if you remove a friend, until you delete them.
- **What you wrote elsewhere.** Your site keeps its own signed record of what you've written on friends' posts and in
  groups, and checks on it in the background (daily for a week, weekly for three months, then monthly). If something
  of yours was removed, *Notifications* says who removed it, from what they signed, or that the site left it out with
  nothing signed saying why. Home warns you if something signed as you turns up that your site never sent.
- **People you don't know, and blocking.** On friends' posts, people you don't know are shown as "friend of"
  your friend, and a name that looks like one of your friends' is flagged. You can block someone from a comment, a
  group's members or a friend request: you stop seeing what they write and hearing from them, quietly, and blocking a
  friend ends the friendship. Lighter than that, *Mute* leaves someone's posts off Home, and folds them away in groups,
  without unfriending them; they aren't told, and *Friends* lists who you've muted.
- **Telling someone.** In a group, *Tell the admins* (in the menu on a post or comment) tells them something's wrong,
  with a note if you like, and you choose whether they see it was you; on a friend's post you can tell your friend
  about someone else's comment the same way. It goes to them alone, never to anyone central. They see it under *Things
  to look at* and can remove it or leave it with a word back, and you hear in *Notifications* what they did.
- **Fair shares.** Each friend's, member's or group's site may make 2,000 calls a day to yours and have 50,000 rows
  read for it, and one person can leave at most 200 posts, comments, votes and answers a day on one site (deleting
  their own always goes through). Mentions and replies from any one person reach your *Notifications* at most 20
  times a day, and your phone 5. If your Cloudflare account has been over half a free daily limit on 3 days in a
  week, Home says so, with how much your site and each of your groups used.
- **Keeping up, quietly.** When you post or comment, your site sends your friends' sites a short note (a new post
  to all of them; a comment only to those who commented on the same thing), in batches of 40, trying again for a
  few hours if a site is down. Home shows each friend's newest posts as their site last sent them, and asks again in
  the background (those who've posted lately first, then a few others in turn, as one request may only call 50 other
  sites on the free plan). While a page is open and in view, it
  checks your own site every 30 seconds: the counts in the menu update, and a small bar offers to show new posts
  or comments. Nothing moves until you choose, and none of it is pushed to your phone.
- **The look.** Dark, Light or Auto (following your phone or computer), behind your picture.

**What's published.** Only what the chosen sections show; the rest never leaves your computer. With the
default (posts and photos):
- comments are published only when a photo is attached to them;
- likes and your friends list stay on your computer;
- people appear by name only where a post or photo mentions them, without friendship dates.

Files over 95 MB (the most Cloudflare accepts in one upload) are left out with a note. The free plan allows
5 GB of photos and videos in all.

**Releasing.** Bump `version` in `worker/package.json`, commit, then tag and push:
```sh
git tag -a v<version> -m "afterwrd <version>" && git push origin v<version>
```
A GitHub Action (`.github/workflows/release.yml`) builds the release from the tagged code and publishes it with
every file attached, and another (`image.yml`) builds and publishes the self-hosted image. To build a release locally
instead:
`npm run release -- --base https://github.com/afterwrd/afterwrd/releases/download/v<version>` in `worker/`.
Then the release is signed with afterwrd's release key: from a checkout at the tag,
`npm ci --ignore-scripts && node scripts/sign.mjs <version>` in `worker/` adds it to `signatures/index.json`, which is
committed to `main`. Until it's signed, no site installs or offers it, and the installer doesn't use it.

**Licences.** After adding, removing or upgrading a dependency, run `npm run notices` in `worker/` and commit the
updated `public/static/licenses.txt`, which carries the licences of everything installed with afterwrd. The release
won't build while it's out of date, or if the Worker bundles a package it doesn't cover.

**Developing and testing.** In `worker/`: `npm install`. To try the site locally: `npm run dev` (the site brings its
database up to date on its first request: apply migrations that way, not with `wrangler d1 migrations apply`, which
only knows the `.sql` ones), then `npm run owner -- "Test" --local`, open the device link it prints and make a passkey,
and import at `http://localhost:8787/_admin/import`. Passkeys work on `localhost` but not on `127.0.0.1`.
`npm run check` runs the type checks (also run on every push), and `npm run test:e2e` the end-to-end tests (see
[worker/test/e2e/README.md](worker/test/e2e/README.md)).

## What the import does

- Fixes Facebook's text encoding (`JÃ¡nos` → `János`, broken emoji).
- Parses summary lines such as *"Sam Taylor commented on Jo Bloggs's photo."*
  into an owner and a kind (post, photo, comment, reel…), so comments and likes
  can be grouped by person even when the post itself isn't in your export.
- Merges Facebook's two like/reaction formats (a newer one with URLs, an older
  one with only summary lines) by timestamp.
- Folds in group posts and group comments, which live in a separate folder.
- Links each photo or video to its album, post or comment.
- Records each photo's dimensions and makes a thumbnail, used by the grids; the full image is only loaded in the
  viewer.
- Picks your current profile picture from the profile update history, and your
  cover photo as the newest upload in the "Cover photos" album (Facebook
  doesn't record cover changes).

## Data model

What's written on afterwrd is signed records, kept in signed lists ([PROTOCOL.md](PROTOCOL.md) says exactly how);
your Facebook download stays as it came, in tables of its own, and an import replaces only those.

| Table                    | What                                                                          |
|--------------------------|-------------------------------------------------------------------------------|
| `own_identity`, `delegations` | Your identity (your passkeys', recovery code's and site's keys), and the browsers that may sign for you |
| `identities`             | Other people's identities, as checked                                         |
| `items`, `item_photos`   | Posts, photos, polls and events: yours, or on a group's site, the group's     |
| `lists`, `list_pages`, `checkpoints` | Each item's records (comments, edits, deletes, votes, answers) in the order its site took them, with that site's signed running fingerprint |
| `copies`                 | Friends' and groups' items and conversations, kept as your site checked them  |
| `sent`                   | What you've signed and sent elsewhere, with the receipt that it was taken     |
| `connections`            | Your friends, by identity                                                     |
| `groups`, `group_members`| Groups you're in or run; on a group's site, its members                       |
| `notices`, `blocks`, `mutes` | Notifications, and people you've blocked or muted                         |
| `reports`, `reports_sent`| What's been raised with you (or a group's admins), and what you've raised     |
| `media`, `albums`        | Photos and videos (by fingerprint), and your albums                           |
| `posts`                  | Your Facebook posts (`source` says where each came from)                      |
| `facebook_people`        | Everyone named in the download; `friend_since` set for current friends        |
| `facebook_post_tags`     | People tagged in your Facebook posts                                          |
| `facebook_comments`      | Your comments and replies on Facebook, with whose thing they were on          |
| `facebook_reactions`     | Your likes and reactions on Facebook                                          |
| `facebook_tagged_photos` | Other people's photos you're tagged in (links only, no images)                |

The rest are in [worker/migrations/](worker/migrations/). What was written on afterwrd 1 (in `posts`, `comments`,
`polls` and the like) is there only to bring things over to afterwrd 2, and most of it is cleared out once the 30 days
for that are up.

## Known limitations

- Facebook identifies people only by name, so two friends with the same name
  are merged into one person.
- Facebook's download sometimes keeps only a comment's summary line, not its text; those comments are shown with a
  note saying so.
- Photos you're tagged in are links back to Facebook, not images.

## Licence

afterwrd is free software, licensed under the [GNU Affero General Public License v3.0 or later](LICENSE).
Anyone can use it, change it and share it, free. If you change it and let other people use your version over a
network, you must offer them its source code under the same licence, so it can't be taken private.

**No warranty.** afterwrd is provided as is, without any warranty (sections 15 and 16 of the licence say so in full).
You run your own site, in your own Cloudflare account or on your own server, and are responsible for it, including
keeping it up to date. Think carefully about what you import, and turn on two-factor authentication for your Cloudflare
account.

afterwrd includes other open-source projects under their own licences (MIT, BSD, Apache 2.0 and the SIL Open Font
Licence), listed with their full texts in [worker/public/static/licenses.txt](worker/public/static/licenses.txt),
which every afterwrd site also serves at `/static/licenses.txt`.
