// Reads a watch product page, extracts specs, and stores its photos in Supabase Storage.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { parsePage } from "./parse.js"; // deployed copy imports the same file from jsDelivr, pinned to a commit

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

function safeUrl(u: string): URL | null {
  try {
    const x = new URL(u);
    if (x.protocol !== "https:" && x.protocol !== "http:") return null;
    const h = x.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^[\d.]+$/.test(h) || h.includes(":") || h.startsWith("[")) return null;
    if (x.port && x.port !== "443" && x.port !== "80") return null;
    return x;
  } catch { return null; }
}
async function fetchSafe(start: string, accept: string, max: number) {
  let url = start;
  for (let i = 0; i < 5; i++) {
    const x = safeUrl(url);
    if (!x) throw new Error("bad_url");
    const r = await fetch(x, { redirect: "manual", headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "en,ar;q=0.8" }, signal: AbortSignal.timeout(15000) });
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) { url = new URL(loc, x).toString(); await r.body?.cancel(); continue; }
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.byteLength > max) throw new Error("too_large");
    return { status: r.status, url, type: r.headers.get("content-type") || "", buf };
  }
  throw new Error("too_many_redirects");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const body = await req.json().catch(() => ({}));
    let uid: string | null = null, isAdmin = false;
    const tok = req.headers.get("x-admin-token");
    if (tok) {
      const { data } = await admin.from("app_private").select("value").eq("key", "admin_token").single();
      if (!data || data.value !== tok) return json({ error: "unauthorized" }, 401);
      isAdmin = true;
    } else {
      const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const { data, error } = await admin.auth.getUser(jwt);
      if (error || !data?.user) return json({ error: "unauthorized" }, 401);
      uid = data.user.id;
    }
    const target = safeUrl(String(body.url || ""));
    if (!target) return json({ error: "bad_url" }, 400);

    // 1) the page itself, 2) Shopify's product JSON, 3) a public reader service for sites that block servers.
    let html = "", finalUrl = target.toString(), via = "direct", lastErr = "";
    try {
      const page = await fetchSafe(target.toString(), "text/html,application/xhtml+xml", 5e6);
      if (page.status < 400) { html = new TextDecoder().decode(page.buf); finalUrl = page.url; } else lastErr = "status " + page.status;
    } catch (e) { lastErr = String((e as Error)?.message || e); }

    let shop: Record<string, unknown> | null = null;
    const fu = new URL(finalUrl);
    if (/\/products\/[^/]+/.test(fu.pathname)) {
      const p = fu.pathname.replace(/\/$/, "");
      try {
        const r = await fetchSafe(fu.origin + p + ".json", "application/json", 3e6);
        if (r.status === 200) shop = JSON.parse(new TextDecoder().decode(r.buf)).product || null;
      } catch { /* not a Shopify store */ }
      if (shop) {
        try {
          const r = await fetchSafe(fu.origin + p + ".js", "application/json", 3e6);
          if (r.status === 200) shop._available = JSON.parse(new TextDecoder().decode(r.buf)).available;
        } catch { /* availability unknown */ }
      }
    }
    if (!html && !shop) {
      try {
        const key = Deno.env.get("JINA_API_KEY");
        const r = await fetch("https://r.jina.ai/" + target.toString(), { headers: { "X-Return-Format": "html", Accept: "text/html", ...(key ? { Authorization: "Bearer " + key } : {}) }, signal: AbortSignal.timeout(40000) });
        if (r.ok) { html = await r.text(); via = "reader"; } else lastErr += " | reader " + r.status;
      } catch (e) { lastErr += " | reader " + String((e as Error)?.message || e); }
    }
    if (!html && !shop) return json({ error: "blocked", detail: lastErr }, 502);
    const info = parsePage(html, finalUrl, shop) as Record<string, unknown> & { images: string[] };

    const want = Math.max(0, Math.min(Number(body.max_images ?? 6), 10));
    const saved: string[] = [];
    const folder = uid || "seed";
    // Admin calls may name the exact photos to store (for example a product gallery read separately).
    const sources: string[] = isAdmin && Array.isArray(body.image_urls) ? body.image_urls.map(String) : info.images;
    for (const src of sources.slice(0, want * 2)) {
      if (saved.length >= want) break;
      try {
        let r = await fetchSafe(src, "image/avif,image/webp,image/png,image/jpeg,image/*", 9e6).catch(() => null);
        if (!r || r.status !== 200) r = await fetchSafe("https://wsrv.nl/?url=" + encodeURIComponent(src), "image/*", 9e6);
        const ct = (r.type.split(";")[0] || "").trim().toLowerCase();
        if (r.status !== 200 || !/^image\/(jpeg|png|webp|gif|avif)$/.test(ct)) continue;
        const path = `${folder}/${crypto.randomUUID()}.${ct.split("/")[1].replace("jpeg", "jpg")}`;
        const up = await admin.storage.from("watch-images").upload(path, r.buf, { contentType: ct, upsert: false });
        if (up.error) continue;
        saved.push(admin.storage.from("watch-images").getPublicUrl(path).data.publicUrl);
      } catch { /* skip this image */ }
    }
    info.savedImages = saved;
    info.finalUrl = finalUrl;
    info.via = via;

    if (isAdmin && body.watch_id) {
      const { data: row } = await admin.from("watches").select("data").eq("id", String(body.watch_id)).single();
      if (row) {
        const d = (row.data || {}) as Record<string, unknown>;
        const images = (body.replace_images ? saved : ([] as string[]).concat((d.images as string[]) || [], saved)).slice(0, 12);
        await admin.from("watches").update({ data: { ...d, images, imageId: images[0] || null } }).eq("id", String(body.watch_id));
      }
    }
    return json({ ok: true, info });
  } catch (e) {
    return json({ error: "server", detail: String((e as Error)?.message || e) }, 500);
  }
});
