// Pure page parser: no network, no Deno APIs, so it can be tested with node.
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decode(s) {
  return String(s || "").replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === "#") {
      const c = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(c) ? String.fromCodePoint(c) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}
export function toText(html) {
  return decode(String(html || "")
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d|dt|dd|section|table|ul|ol|span)>/gi, "\n")
    .replace(/<(td|th)[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}
function meta(html, key) {
  const re = new RegExp("<meta[^>]+(?:property|name|itemprop)=[\"']" + key.replace(/[:.]/g, "\\$&") + "[\"'][^>]*>", "i");
  const m = re.exec(html);
  if (!m) return null;
  const c = /content=["']([^"']*)["']/i.exec(m[0]);
  return c ? decode(c[1]).trim() : null;
}
function ldProducts(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let j;
    try { j = JSON.parse(m[1].trim()); } catch { continue; }
    const stack = [j];
    while (stack.length) {
      const x = stack.pop();
      if (!x || typeof x !== "object") continue;
      if (Array.isArray(x)) { stack.push(...x); continue; }
      const t = [].concat(x["@type"] || []);
      if (t.some((v) => /^(Product|ProductGroup|IndividualProduct)$/i.test(String(v)))) out.push(x);
      if (x["@graph"]) stack.push(x["@graph"]);
    }
  }
  return out;
}
function imgList(v) {
  return [].concat(v || []).map((x) => (typeof x === "string" ? x : x && (x.url || x.contentUrl))).filter(Boolean);
}
const num = (s) => { const v = parseFloat(String(s).replace(",", ".")); return Number.isFinite(v) ? v : null; };
function first(texts, res, lo, hi, mul = 1) {
  for (const t of texts) {
    if (!t) continue;
    for (const re of res) {
      const m = re.exec(t);
      if (m) { const v = num(m[1]); if (v !== null && v * mul >= lo && v * mul <= hi) return Math.round(v * mul * 100) / 100; }
    }
  }
  return null;
}
const MM = "(?:mm|مم|ملم|م\\.م)";
const COLORS = [
  ["navy|كحلي", "#1F2A44"], ["blue|أزرق|ازرق", "#1F4E8C"], ["black|أسود|اسود", "#1A1B1D"], ["white|أبيض|ابيض|ivory|cream", "#ECEBE6"],
  ["silver|فضي", "#C9CDD1"], ["grey|gray|رمادي|anthracite|slate", "#6B7178"], ["green|أخضر|اخضر|olive", "#2F5D46"], ["brown|بني|chocolate", "#5A3A22"],
  ["salmon|سلمون", "#E7A589"], ["champagne|شمبين|gold|ذهبي", "#CBB27C"], ["red|أحمر|burgundy", "#8C2232"], ["orange|برتقالي", "#D2691E"], ["pink|وردي", "#E3B5BE"],
];
function colorOf(title, text) {
  const hay = [title, (/(\w+)\s+dial/i.exec(text || "") || [])[1], (/(?:dial|المينا)\s*[:\-]?\s*([^\n|,]{2,30})/i.exec(text || "") || [])[1]];
  for (const h of hay) {
    if (!h) continue;
    for (const [re, hex] of COLORS) if (new RegExp("\\b(?:" + re + ")", "i").test(h)) return hex;
  }
  return null;
}
const CAL = /\b(ETA[\s-]?\d{4}(?:-\d)?|Sellita\s?SW\s?\d{3}(?:-\d)?|SW\s?\d{3}(?:-\d)?|Miyota\s?\w{4}|Seiko\s?NH\d{2}A?|NH\d{2}A?|Powermatic\s?80(?:\.\d{3})?|Soprod\s?\w{3,6}|La\s?Joux[\s-]Perret\s?\w{2,6}|L\d{3}(?:\.\d)?|MT\d{4}|H-\d{2}|Cal(?:iber|ibre)?\.?\s?[A-Z]?\d{2,5}[A-Z]?(?:[.-]\d+)?)\b/i;

export function parsePage(html, url, shop) {
  const ld = ldProducts(html)[0] || null;
  const offers = ld ? [].concat(ld.offers || [])[0] || null : null;
  const pageTitle = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || "").trim();
  const title = (shop && shop.title) || (ld && ld.name) || meta(html, "og:title") || pageTitle.split(/\s[|–-]\s/)[0] || "";
  let brand = (shop && shop.vendor) || (ld && (typeof ld.brand === "string" ? ld.brand : ld.brand && ld.brand.name)) || meta(html, "product:brand") || meta(html, "og:brand") || "";
  brand = decode(brand).trim();
  const desc = toText((shop && shop.body_html) || (ld && ld.description) || meta(html, "og:description") || "");
  const body = toText((/<body[^>]*>([\s\S]*)<\/body>/i.exec(html) || [, html])[1]).slice(0, 60000);
  const T = [desc, body];
  let model = decode(title).trim();
  if (brand && model.toLowerCase().startsWith(brand.toLowerCase())) model = model.slice(brand.length).replace(/^[\s\-–|:]+/, "");

  const caseMm = first([title, desc, body], [
    new RegExp("(?:case\\s*(?:diameter|size|width)|diameter|قطر(?:\\s*العلبة)?|حجم\\s*العلبة)[^\\d]{0,25}(\\d{2}(?:[.,]\\d{1,2})?)\\s*" + MM, "i"),
    new RegExp("(\\d{2}(?:[.,]\\d{1,2})?)\\s*" + MM + "\\s*(?:case|diameter|wide)", "i"),
  ], 20, 55) ?? first([title], [new RegExp("(\\d{2}(?:[.,]\\d)?)\\s*" + MM, "i")], 20, 55);
  const thickMm = first(T, [new RegExp("(?:thickness|case\\s*height|height|سماكة|السماكة|سمك)[^\\d]{0,25}(\\d{1,2}(?:[.,]\\d{1,2})?)\\s*" + MM, "i")], 4, 25);
  const lugToLugMm = first(T, [new RegExp("lug[\\s-]*to[\\s-]*lug[^\\d]{0,25}(\\d{2}(?:[.,]\\d{1,2})?)", "i")], 30, 65);
  const lugMm = first(T, [new RegExp("(?:lug\\s*width|strap\\s*width|band\\s*width|bracelet\\s*width|between\\s*(?:the\\s*)?lugs|عرض\\s*(?:ال)?سير|عرض\\s*(?:ال)?حزام)[^\\d]{0,25}(\\d{2})", "i")], 10, 30);
  const waterM = first(T, [/(\d{1,3})\s*(?:atm|bar)\b/i], 1, 600, 10) ??
    first(T, [/(?:water[\s-]*resist\w*|\bwr\b|مقاوم\w*\s*(?:لل)?(?:ماء|مياه))[^\d]{0,30}(\d{2,4})\s*(?:m\b|meters|metres|متر|م\b)/i, /(\d{2,4})\s*(?:m|meters|metres)\s*(?:water|wr)\b/i], 10, 6000);
  const powerH = first(T, [/power[\s-]*reserve[^\d]{0,30}(\d{2,3})\s*(?:h\b|hours|hrs|ساعة)/i, /(\d{2,3})[\s-]*(?:h|hours?|hrs)\b[^\n]{0,25}power[\s-]*reserve/i, /احتياطي\s*(?:ال)?طاقة[^\d]{0,25}(\d{2,3})/], 20, 1000) ??
    first(T, [/power[\s-]*reserve[^\d]{0,30}(\d{1,2})\s*days?/i], 20, 1000, 24);

  const all = desc + "\n" + body;
  let kind = null;
  if (/hand[\s-]*(?:wound|winding)|manual[\s-]*wind|تعبئة\s*يدوية/i.test(all)) kind = "تعبئة يدوية";
  if (/automatic|self[\s-]*winding|أوتوماتيك|اوتوماتيك/i.test(desc) || (!kind && /automatic|self[\s-]*winding/i.test(body))) kind = "أوتوماتيك";
  if (!kind && /\bquartz\b|كوارتز/i.test(all)) kind = "كوارتز";
  if (!kind && /\bsolar\b|eco[\s-]*drive/i.test(all)) kind = "شمسية";
  const cal = ((CAL.exec(desc) || CAL.exec(body) || [])[1] || "").replace(/^cal(?:iber|ibre)?\.?\s*/i, "");
  const movement = [kind, cal.trim()].filter(Boolean).join(" ") || null;
  const crystal = /sapphire|سافير|ياقوت/i.test(all) ? "سافير" : /hesalite|acrylic|plexi/i.test(all) ? "أكريليك" : /mineral/i.test(all) ? "زجاج معدني" : null;
  let date = null;
  if (/no[\s-]*date|without\s*date|بدون\s*تاريخ/i.test(all)) date = false;
  else if (/date\s*(?:window|display|at\s*\d|function)|day[\s-]*date|نافذة\s*التاريخ/i.test(all)) date = true;

  let ref = String((ld && (ld.mpn || ld.sku)) || "").trim();
  if (!/\d/.test(ref) || ref.length < 4 || ref.length > 26) ref = "";
  if (!ref) { const m = /(?:reference|ref\.?|model\s*(?:no\.?|number)|المرجع|الرقم\s*المرجعي)\s*[:#]?\s*([A-Z0-9][A-Z0-9.\-\/]{3,24})/i.exec(all); if (m && /\d/.test(m[1])) ref = m[1]; }

  const hay = (title + " " + desc).toLowerCase();
  const category = /div(?:e|er|ing)\b|غوص|غواص/.test(hay) ? "diver" : /pilot|flieger|aviat|طيار/.test(hay) ? "pilot" : /dress|رسمي/.test(hay) ? "dress" : /chrono|sport|رياضي|gmt/.test(hay) ? "sport" : null;

  let price = null, currency = null, available = null;
  if (shop && shop.variants && shop.variants[0]) price = num(shop.variants[0].price);
  if (price === null && offers) price = num(offers.price ?? offers.lowPrice);
  if (price === null) price = num(meta(html, "product:price:amount") || meta(html, "og:price:amount") || "");
  currency = (offers && offers.priceCurrency) || meta(html, "product:price:currency") || meta(html, "og:price:currency") ||
    ((/Shopify\.currency\s*=\s*\{\s*"active"\s*:\s*"([A-Z]{3})"/.exec(html) || [])[1]) || null;
  if (shop && typeof shop._available === "boolean") available = shop._available;
  else if (offers && offers.availability) available = !/OutOfStock|SoldOut|Discontinued/i.test(String(offers.availability));

  let images = [];
  if (shop && shop.images) images = shop.images.map((i) => i.src);
  images = images.concat(imgList(ld && ld.image), imgList(meta(html, "og:image")));
  const seen = new Set();
  images = images.map((s) => {
    try {
      const u = new URL(s.startsWith("//") ? "https:" + s : s, url);
      if (/\/cdn\/shop\/|cdn\.shopify\.com/.test(u.href)) u.searchParams.set("width", "1400");
      return u.href;
    } catch { return null; }
  }).filter((s) => { if (!s) return false; const k = s.split("?")[0]; if (seen.has(k)) return false; seen.add(k); return true; });

  return {
    title: decode(title).trim(), brand, model, ref, category, dialColor: colorOf(title, desc + "\n" + body.slice(0, 20000)), caseMm, thickMm, lugToLugMm, lugMm, waterM, powerH,
    movement, crystal, date, price, currency, available, images, description: desc.slice(0, 600),
    siteName: meta(html, "og:site_name") || null,
  };
}
