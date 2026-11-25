// Getting help (docs/safety-plan.md 3.5): where to turn when something's wrong that afterwrd can't put right. The same
// words on every site (/help: views/home.js helpPage) and on afterwrd.app (/help/: central/site.js), from here.
// Each organisation's name, link, numbers and hours were checked against its own website on CHECKED. Check them again
// there before changing any, and move CHECKED on. (Not checked from here, as police.uk refused automated reading: 101
// and police.uk; checked by hand before release.)
import { html } from "./html.js";

export const CHECKED = "25 November 2026";

/** A phone number, to call with a tap on a phone. */
const tel = (number) => html`<a class="tel" href="tel:${number.replace(/\s/g, "")}"><strong>${number}</strong></a>`;

/** The page's words, after its heading: the same on a site and on afterwrd.app. */
export const helpBody = () => html`<p class="lede">afterwrd has no company behind it that reads posts or takes them down. Each person
looks after their own posts, and each group's admins look after their group. When something's wrong that they can't or
won't put right, or that's too serious to leave to them, these are the people to turn to. They're in the UK; elsewhere,
your local police and services.</p>

<section id="children">
  <h2>A child at risk</h2>
  <ul>
    <li><a href="https://www.ceop.police.uk/">CEOP</a>, part of the National Crime Agency, is for children and young people
      worried about sexual abuse online, or about how someone has been talking to them online.</li>
    <li>The <a href="https://www.iwf.org.uk/en/uk-report/">Internet Watch Foundation</a> takes reports of pictures or videos
      of children being sexually abused, found online. You can report anonymously. Don't save or pass on what you've
      found, even to show someone.</li>
    <li>If it's somewhere private, such as an afterwrd site or group, tell the police too, on ${tel("101")}: the
      Internet Watch Foundation can't see private places.</li>
  </ul>
</section>

<section id="images">
  <h2>Intimate pictures shared without consent</h2>
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
  <h2>Bullying or harassment</h2>
  <ul>
    <li>The <a href="https://www.nationalbullyinghelpline.co.uk/contact.html">National Bullying Helpline</a> gives free,
      confidential advice on bullying of every kind, including online and at work: ${tel("0300 323 0169")}.</li>
    <li>Threats, and harassment that won't stop, can be crimes: tell the police on ${tel("101")}, or at
      <a href="https://www.police.uk/">police.uk</a>.</li>
    <li>Keep a record first: a screenshot of what was said, and when, before you remove it, block someone or leave.</li>
  </ul>
</section>

<section id="elsewhere">
  <h2>Harmful content elsewhere online</h2>
  <p><a href="https://reportharmfulcontent.com/">Report Harmful Content</a> helps you report it to the site or app it's on,
  with each one's rules and how to report there. afterwrd has no company to report to: on afterwrd, it's the site's owner
  or the group's admins, or the people on this page.</p>
</section>

<section id="low">
  <h2>Feeling low, or worried about someone</h2>
  <p><a href="https://www.samaritans.org/how-we-can-help/contact-samaritan/">Samaritans</a> are there to talk to, any time,
  day or night, for free: ${tel("116 123")}. In Welsh: ${tel("0808 164 0123")}.</p>
</section>

<section id="afterwrd">
  <h2>On afterwrd itself</h2>
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

<p class="meta">Checked against each organisation's own website on ${CHECKED}.</p>`;
