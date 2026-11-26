// Help (/help on every site: views/home.js helpPage; /help/ on afterwrd.app: central/site.js), the same words in both,
// from here: how afterwrd works, staying safe (docs/safety-plan.md 3.5: where to turn when something's wrong that afterwrd
// can't put right), and what to do when something isn't working.
// Each organisation's name, link, numbers and hours were checked against its own website on CHECKED. Check them again
// there before changing any, and move CHECKED on. (No police numbers or links: people know how to reach the police.)
import { html } from "./html.js";

export const CHECKED = "25 November 2026";

/** A phone number, to call with a tap on a phone. */
const tel = (number) => html`<a class="tel" href="tel:${number.replace(/\s/g, "")}"><strong>${number}</strong></a>`;

/**
 * The page's words, after its heading: the same on a site and on afterwrd.app. `version`: the site's, to say in
 * "Something not working?" (afterwrd.app's own pages say theirs in their footer).
 */
export const helpBody = ({ version = null } = {}) => html`<nav class="contents" aria-label="On this page">
  <a href="#how">How afterwrd works</a> · <a href="#site">Looking after your site</a> · <a href="#safe">Staying safe</a> ·
  <a href="#bugs">Something not working?</a>
</nav>

<section id="how">
  <h2>How afterwrd works</h2>
  <h3>Your site</h3>
  <p>Your afterwrd site is yours: it runs in your own Cloudflare account (or on your own server), and there's no company in
  the middle. Only you sign in to it, with a passkey: your face, fingerprint or phone PIN, nothing to remember. Your friends
  see your things from their own sites, never by signing in to yours.</p>
  <h3>Friends</h3>
  <p>Go to <strong>Friends</strong>, then <strong>Add a friend</strong>: make a link to send someone, or paste a link a friend
  sent you. Nothing is shared until you've approved them. Once you're friends, you can introduce friends to each other.
  Someone who comments on a friend's post, or is in a group with you, can be asked from their name: tap it. Friends see
  your old Facebook posts and photos only if you switch that on, under <strong>Friends can see</strong> on Memories.</p>
  <h3>Posts and comments</h3>
  <p>Write a post on Home or Your profile, with photos if you like: all your friends see it, and nobody else. You can change
  what you wrote for 15 minutes, until someone replies, and delete it any time. Comment on friends' posts from your own Home.
  On your own posts, the ⌄ menu lets you remove anyone's comment, or turn comments off.</p>
  <h3>Groups</h3>
  <p>Start a group from <strong>Groups</strong>, or join one with an invite link someone sends you. Its admins decide who's in,
  and can write the group's rules. Each group has a site of its own, in its owner's Cloudflare account (or on their
  server).</p>
  <h3>Events</h3>
  <p>Make an event from <strong>Events</strong> and invite the friends you choose; only they see it, and say whether they're
  going. Groups can have events too, for everyone in them.</p>
  <h3>Notifications</h3>
  <p>Replies, mentions, invitations and changes to events show under <strong>Notifications</strong>. Your phone buzzes only for
  events and when someone mentions you, and only if you've said yes on that device, in <strong>Your devices</strong> (behind your picture). afterwrd
  never nags.</p>
  <h3>Your devices</h3>
  <p>Each phone or computer you sign in on is listed in <strong>Your devices</strong>. What you write is signed by the device
  you write it on, so nobody else, not even your site's host, can write as you. To add a device, make a link in <strong>Your
  devices</strong> and open it there; then, on a device that already signs, choose <strong>Let it sign for you</strong>.</p>
  <h3>Updates</h3>
  <p>afterwrd keeps itself up to date if you let it: <strong>Update</strong> (behind your picture) installs only releases signed
  with afterwrd's own key, a few days after they're out. If you let them, your friends' sites check that yours is running a real release.</p>
  <h3>Your things are yours</h3>
  <p><strong>Download everything</strong> gives you all of it, to keep or to bring to another site. Nothing you post is used for
  anything else, and nobody is shown adverts.</p>
</section>

<section id="site">
  <h2>Looking after your site</h2>
  <h3>Your Cloudflare account is the key to your site</h3>
  <p>Anyone who gets into it can get into your site. Give it a strong password you use nowhere else, turn on two-step sign-in
  (in Cloudflare: My Profile → Authentication), and keep its backup codes somewhere safe. If you can, keep an account just
  for afterwrd.</p>
  <h3>Your recovery code</h3>
  <p>If you lose every phone and computer that signs for you, your recovery code lets you sign again (it takes 7 days, and
  any devices you still have are told, in case it isn't you). Your site doesn't keep it: write it down, or keep it in your
  password manager. You can use it, or make a new one, in <strong>Your devices</strong>.</p>
  <h3>Your devices</h3>
  <p>Open device links only on your own phones and computers. If <strong>Your devices</strong> lists one you don't recognise,
  remove it, or sign out everywhere.</p>
  <h3>Updates and friends' checks</h3>
  <p>Let afterwrd update itself, and let your friends' sites check yours: both are on the <strong>Update</strong> page. A
  check looks at whether your site is running exactly a signed afterwrd release, set up as afterwrd sets it up, and
  whether every version of its code uploaded since the last check was one too. A check you ask a friend for by link
  also reads your Cloudflare account's log, to see that apps and API tokens did only what installing, updating and
  groups do.</p>
  <h3 id="checks">If a check finds something</h3>
  <p>Home tells you, and <strong>Update</strong> shows what it found.</p>
  <ul>
    <li><strong>"Couldn't check"</strong> usually means your site or Cloudflare was busy. There's nothing to do unless it
      keeps happening.</li>
    <li><strong>"Needs a look"</strong>:
      <ol>
        <li>Read what it found. If the check was on an older afterwrd than your site runs now, it checks again within a day
          or so.</li>
        <li>If you didn't change anything in Cloudflare yourself, then until it's sorted, don't post or import anything
          private, and don't open device links.</li>
        <li>Sign in to Cloudflare. Check your password and two-step sign-in, and look in the account's Audit Log (under
          Manage Account) for sign-ins or changes you didn't make. Remove any API tokens (My Profile → API Tokens) or
          Connected Applications (My Profile → Connected Applications) you don't recognise.</li>
        <li>Tell us privately, at <a href="mailto:security@afterwrd.app">security@afterwrd.app</a>, with what it found.
          We'll help you put it right.</li>
      </ol></li>
    <li>A site you've only just installed, and haven't used yet? Start again cleanly instead: see
      <a href="https://afterwrd.app/check/#wrong">what to do with a new site</a>.</li>
    <li>If your site's check of a friend's finds something, Home says so: let them know, so they can look.</li>
  </ul>
</section>

<section id="safe">
  <h2>Staying safe</h2>
  <p class="lede">afterwrd has no company behind it that reads posts or takes them down. Each person looks after their own
  posts, and each group's admins look after their group. When something's wrong that they can't or won't put right, or
  that's too serious to leave to them, these are the people to turn to. They're in the UK; elsewhere, your local police and
  services.</p>
<section id="children">
  <h3>A child at risk</h3>
  <ul>
    <li><a href="https://www.ceop.police.uk/">CEOP</a>, part of the National Crime Agency, is for children and young people
      worried about sexual abuse online, or about how someone has been talking to them online.</li>
    <li>The <a href="https://www.iwf.org.uk/en/uk-report/">Internet Watch Foundation</a> takes reports of pictures or videos
      of children being sexually abused, found online. You can report anonymously. Don't save or pass on what you've
      found, even to show someone.</li>
    <li>If it's somewhere private, such as an afterwrd site or group, tell the police too: the Internet Watch Foundation
      can't see private places.</li>
  </ul>
</section>

  <section id="images">
  <h3>Intimate pictures shared without consent</h3>
  <ul>
    <li>The <a href="https://revengepornhelpline.org.uk/how-can-we-help/how-to-get-in-touch/">Revenge Porn Helpline</a>
      gives confidential advice to adults in the UK affected by intimate image abuse, including help getting pictures
      taken down: ${tel("0345 6000 459")}, 10am to 4pm, Monday to Friday (not bank holidays), or
      help@revengepornhelpline.org.uk. Under 18? It has a page for you on the same site.</li>
    <li><a href="https://stopncii.org/">StopNCII.org</a>: if you're the person in the picture, were 18 or over when it was
      taken, and still have it, it makes a fingerprint of it on your own device (the picture isn't sent anywhere), so
      platforms that take part can stop it being shared there. afterwrd sites aren't among them.</li>
  </ul>
</section>

  <section id="bullying">
  <h3>Bullying or harassment</h3>
  <ul>
    <li>The <a href="https://www.nationalbullyinghelpline.co.uk/contact.html">National Bullying Helpline</a> gives free,
      confidential advice on bullying of every kind, including online and at work: ${tel("0300 323 0169")}.</li>
    <li>Threats, and harassment that won't stop, can be crimes, and you can report them to the police.</li>
    <li>Keep a record first: a screenshot of what was said, and when, before you remove it, block someone or leave.</li>
  </ul>
</section>

  <section id="elsewhere">
  <h3>Harmful content elsewhere online</h3>
  <p><a href="https://reportharmfulcontent.com/">Report Harmful Content</a> helps you report it to the site or app it's on,
  with each one's rules and how to report there. afterwrd has no company to report to: on afterwrd, it's the site's owner
  or the group's admins, or the people on this page.</p>
</section>

  <section id="low">
  <h3>Feeling low, or worried about someone</h3>
  <p><a href="https://www.samaritans.org/how-we-can-help/contact-samaritan/">Samaritans</a> are there to talk to, any time,
  day or night, for free: ${tel("116 123")}. In Welsh: ${tel("0808 164 0123")}.</p>
</section>

  <section id="afterwrd">
  <h3>On afterwrd itself</h3>
  <ul>
    <li>On your own posts, you can remove anyone's comment, or turn comments off.</li>
    <li>Mute someone to stop seeing their posts, and stay friends. Block them to stop hearing from them at all. Neither is
      told.</li>
    <li>Something in a group worries you? <strong>Tell the admins</strong>, from its ⌄ menu. Someone else's comment on a
      friend's post? Tell that friend, the same way. Only they see it, whoever wrote it isn't told, and you can choose not
      to be named.</li>
    <li>In a group, its admins can remove posts, comments and members, and anyone can leave.</li>
  </ul>
</section>
  <p class="meta">Checked against each organisation's own website on ${CHECKED}.</p>
</section>

<section id="bugs">
  <h2>Something not working?</h2>
  <ol>
    <li><strong>Update first.</strong> Many problems are already fixed in a newer release: see <strong>Update</strong>, behind
      your picture.</li>
    <li><strong>Tell us.</strong> Email <a href="mailto:hello@afterwrd.app">hello@afterwrd.app</a>, or, if you have a GitHub
      account, <a href="https://github.com/afterwrd/afterwrd/issues">open an issue</a>. Say what you were doing, what you
      expected and what happened instead, and which phone or computer and browser you were using. A screenshot helps.
      ${version ? html`This site runs afterwrd <strong>${version}</strong>.` : html`Your site's version is at the bottom of the menu behind your picture.`}</li>
    <li>Please don't send passwords, recovery codes or anything private, and don't post other people's names or words in a
      public issue.</li>
    <li><strong>A security problem?</strong> Don't post it in public: email <a href="mailto:security@afterwrd.app">security@afterwrd.app</a>
      instead.</li>
  </ol>
</section>`;
