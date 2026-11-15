// afterwrd-etag: a placeholder Worker that never answers anything. scripts/sign.mjs uploads each release's code to
// it as a version that's never made live, only to read back the etag Cloudflare gives that code (the same in every
// account), which goes into the signed list for friends' checks. Deploy it once into the afterwrd account:
//   CLOUDFLARE_ACCOUNT_ID=<the afterwrd account's id> npx wrangler deploy -c scripts/etag-worker/wrangler.jsonc
export default { fetch() { return new Response(null, { status: 404 }); } };
