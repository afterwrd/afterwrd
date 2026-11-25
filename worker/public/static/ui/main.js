// What every signed-in page does in the browser (nav.js loads this, as a module): each part is a file of its own, run in
// this order, the same on every page. Without scripts, every form still works the plain way.
//
//   confirm.js   asking first, in afterwrd's own box (window.askFirst too)
//   look.js      the Dark / Light / Auto switch
//   menus.js     the small V menus, and Edit opening the words
//   drafts.js    what you're writing, kept on this device until it's sent (window.afterwrdSent)
//   inplace.js   comments, edits, deletes, answers and notices sent without a new page
//   arriving.js  a page opened at something (#c12) showing it below the header
//   search.js    drop-downs you can type into
//   autosubmit.js lists that send their form when one's picked
//   mentions.js  @ in a post or comment box: picking someone to mention
//   app.js       the home-screen app: the service worker, and Add to home screen
//   groupsign.js a group's signed members list: joining, letting in, removing, admins, leaving
//   back.js      back closes an open menu first, as in an app
//   viewer.js    the photo viewer: next and previous don't add to history; ✕ goes back where it was opened
//   tabs.js      the header's tabs work as an app's: back from any of them is Home
import "./confirm.js";
import "./look.js";
import "./menus.js";
import "./drafts.js";
import "./inplace.js";
import "./arriving.js";
import "./search.js";
import "./autosubmit.js";
import "./mentions.js";
import "./app.js";
import "./threads.js";
import "./groupsign.js";
import "./back.js";
import "./viewer.js";
import "./tabs.js";
