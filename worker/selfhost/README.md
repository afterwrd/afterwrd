# afterwrd on your own server

The easy way to have an afterwrd site is the install page, <https://afterwrd.app/>, which puts it in a free Cloudflare
account of your own. If you'd rather run it yourself, on a home server, a Raspberry Pi or a rented one, this is how.
It's the same afterwrd, running on workerd (the open-source engine Cloudflare's Workers run on), and it can be friends
and share groups with sites on Cloudflare.

You need:

- a server with Docker and Docker Compose, on x86 or ARM;
- an address for your site (a domain or subdomain you control: `me.example.com`), pointing at the server;
- ports 80 and 443 reachable from the internet, for Caddy to get certificates and for your friends' sites to reach
  yours. Behind a home router that can't forward ports, use Cloudflare Tunnel or Tailscale Funnel instead of Caddy,
  sending your site's address to `afterwrd:8080`.

## Setting it up

1. Make a folder, and put [compose.yaml](compose.yaml) and [Caddyfile](Caddyfile) in it.
2. Change `me.example.com` in both to your site's address.
3. Start it:
   ```sh
   docker compose up -d
   ```
4. Make yourself the owner:
   ```sh
   docker compose exec afterwrd owner "Your Name"
   ```
   Open the link it gives you on your phone or computer, and make a passkey.

That's it. Bringing your Facebook years, friends and everything else work as on any afterwrd site.

## Moving from a site on Cloudflare

Who you are, your friends, and your posts, photos, comments, polls, events and Facebook years can come with you:

1. Update your old site, and run the same version here (`docker compose pull && docker compose up -d`).
2. On this one, before you post or import anything: *Import* → *Bring everything over*. It asks to move your identity
   here, and you agree on your old site. The move takes 7 days, and you can cancel it until then.
3. Then, on your old site, *Download everything*, with *Include photos and videos* ticked, and choose that zip here.

Your friends' sites follow you to the new address. Groups don't come with it: ask your groups to invite your new
address. Your old site stays, saying where you've gone, until you delete it.

## Day to day

| | |
| --- | --- |
| Add another phone or computer | *Your devices* on your site, or `docker compose exec afterwrd owner` |
| Lost every device you sign in with | `docker compose exec afterwrd recover`, and open the link on the one you're using |
| Update | your site's *Update* page says when there's a new release; then `docker compose pull && docker compose up -d` |
| Back up | everything is in the `afterwrd-data` volume (stop afterwrd first for a clean copy); *Download everything* on your site works too |
| See what's running | `docker compose exec afterwrd sites`, `docker compose logs afterwrd` |

## Groups

A group is its own small site, at its own address, on the same server:

1. Point an address at the server for it, say `walkers.example.com`, and add it to the Caddyfile (there's an example
   there); then `docker compose restart caddy`.
2. `docker compose exec afterwrd new-group walkers.example.com` starts its site and gives you a setup code.
3. On your site: *Groups* → *Start a group*, with that address and code.

To delete a group, delete it on your site first (its members are told), then remove its site and data:
`docker compose exec afterwrd delete-group walkers.example.com`.

## What's different from Cloudflare

- **Friends' checks don't work either way.** On Cloudflare, friends' sites ask Cloudflare whether your site is exactly
  the published afterwrd and tell you if it isn't. Nothing outside your server can say what runs on it, so a
  self-hosted site can't be checked, and friends' sites say so. Keeping it safe is up to you: keep the server updated,
  and keep who can get into it to yourself.
- **No automatic updates.** Pull the new image when your site says there's one.
- **Calls out go to public addresses only.** Your site never connects to your home network, the server's own local
  addresses or a cloud server's metadata address, whatever address a friend's site gives it, as on Cloudflare.
- **Keep afterwrd's container to itself.** Don't publish its port 8080, or run it with `network_mode: host` or in a
  shared network namespace: only Caddy (or your tunnel) should reach it, over the compose network.
- **Photos are limited by your disk**, not by Cloudflare's free 5 GB.

## Building the image yourself

From the `worker` folder of the repository: `docker build -f selfhost/Dockerfile -t afterwrd .`, then use `image:
afterwrd` in compose.yaml.
