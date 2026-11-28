-- Check links are gone (2.4, security review 2026-11 M10): a friend's check by hand, through a link they were sent to
-- Cloudflare's Allow page. Being sent such a link is now always something to be wary of. The links this site made,
-- what those checks found (including what they read of friends' Cloudflare audit logs), and friends' requests for one
-- go with them. Friends' automatic checks (friendchecks.js) are kept apart, in friend_checks and checked.
DROP TABLE IF EXISTS site_checks;
DROP TABLE IF EXISTS check_requests;
