// alexa-kitchen — the Alexa custom skill endpoint for MyRecipes.
//   "Alexa, open Henschel Kitchen" ... "put tacos on Tuesday" ... "that's all"
//   "Alexa, ask Henschel Kitchen what's for dinner tomorrow"
// Invocation names tried and dropped: "the kitchen" (Alexa sends "tell the
// kitchen" to the Kitchen device group as an announcement) and "the recipe
// book" (Alexa+ opens its own saved-recipes feature). "tell ..." is always an
// announcement on this account, so it is "ask" or "open".
// Writes calendar rows; the app's shopping list derives from the calendar.
// Auth: Alexa request signature (cert chain URL + Signature-256), timestamp,
// and the skill id in alexa_config. verify_jwt is off because Alexa sends no JWT.
import { createClient } from "npm:@supabase/supabase-js@2";
import * as x509 from "npm:@peculiar/x509@1.12.3";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const TZ = "America/Chicago";

// ── request verification ─────────────────────────────────────────────────────
let cfgCache: { at: number; v: Record<string, string> } | null = null;
async function config() {
  if (cfgCache && Date.now() - cfgCache.at < 60_000) return cfgCache.v;
  const { data } = await sb.from("alexa_config").select("key,value");
  const v: Record<string, string> = {};
  (data || []).forEach((r: any) => v[r.key] = r.value);
  cfgCache = { at: Date.now(), v };
  return v;
}
const certCache = new Map<string, { key: CryptoKey; notAfter: number }>();
function certUrlOk(u: string) {
  try {
    const url = new URL(u);
    const path = url.pathname.replace(/\/+/g, "/");
    return url.protocol === "https:" && url.hostname.toLowerCase() === "s3.amazonaws.com" &&
      (url.port === "" || url.port === "443") && path.startsWith("/echo.api/") && !path.includes("/../");
  } catch { return false; }
}
async function verifyAlexa(req: Request, raw: string): Promise<string | null> {
  const certUrl = req.headers.get("signaturecertchainurl") || "";
  const sig = req.headers.get("signature-256") || "";
  if (!certUrlOk(certUrl)) return "bad cert url";
  if (!sig) return "no signature";
  let entry = certCache.get(certUrl);
  if (!entry || entry.notAfter < Date.now()) {
    const pem = await (await fetch(certUrl)).text();
    const leafPem = pem.split(/(?=-----BEGIN CERTIFICATE-----)/)[0];
    const cert = new x509.X509Certificate(leafPem);
    const now = Date.now();
    if (now < cert.notBefore.getTime() || now > cert.notAfter.getTime()) return "cert expired";
    const san = cert.getExtension(x509.SubjectAlternativeNameExtension);
    const names = (san?.names.items || []).map((n: any) => String(n.value).toLowerCase());
    if (!names.includes("echo-api.amazon.com")) return "cert san mismatch";
    const key = await crypto.subtle.importKey("spki", cert.publicKey.rawData, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    entry = { key, notAfter: cert.notAfter.getTime() };
    certCache.set(certUrl, entry);
  }
  const sigBytes = Uint8Array.from(atob(sig), c => c.charCodeAt(0));
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", entry.key, sigBytes, new TextEncoder().encode(raw));
  return ok ? null : "signature mismatch";
}

// ── dates (all in Central time) ──────────────────────────────────────────────
function todayISO() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function hourNow() {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hour12: false }).format(new Date())) % 24;
}
function daysBetween(a: string, b: string) { return Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5); }
function spokenDay(iso: string) {
  const diff = daysBetween(todayISO(), iso);
  const d = new Date(iso + "T12:00:00Z");
  const wd = d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff > 1 && diff < 7) return wd;
  const md = d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  return `${wd}, ${md}`;
}
// AMAZON.DATE -> YYYY-MM-DD, or a note that it isn't a single day.
function resolveDate(v?: string): { iso?: string; vague?: boolean } {
  if (!v) return {};
  if (v === "PRESENT_REF") return { iso: todayISO() };
  const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return { iso: m[1] };
  return { vague: true }; // weeks, weekends, months
}
// Same cut-offs as the app's "Made it" button.
function slotForNow() { const h = hourNow(); return h < 10 ? "breakfast" : h < 15 ? "lunch" : "dinner"; }

// ── slots ────────────────────────────────────────────────────────────────────
function slotVal(intent: any, name: string): string | undefined {
  const s = intent?.slots?.[name];
  if (!s) return undefined;
  const r = s.resolutions?.resolutionsPerAuthority?.find((a: any) => a.status?.code === "ER_SUCCESS_MATCH");
  return (r?.values?.[0]?.value?.name ?? s.value ?? undefined) || undefined;
}
function rawVal(intent: any, name: string): string | undefined { return intent?.slots?.[name]?.value || undefined; }

// ── recipe matching ──────────────────────────────────────────────────────────
const STOP = new Set(["the", "a", "an", "and", "with", "of", "recipe", "some", "my", "our", "style", "eds", "ed's"]);
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(w => w.length > 1 && !STOP.has(w)).map(w => w.replace(/(ies)$/, "y").replace(/(es|s)$/, ""));
type Cand = { id: string; title: string; servings: number | null; rating: number | null; staple: boolean; score: number; sim: number; final?: number };
async function findRecipe(spoken: string): Promise<{ pick?: Cand; ask?: Cand[] }> {
  const { data, error } = await sb.rpc("match_recipe_candidates", { q: spoken, n: 12 });
  if (error) throw error;
  const qw = words(spoken);
  const cands: Cand[] = (data || []).map((c: any) => {
    const tw = new Set(words(c.title));
    const cover = qw.length ? qw.filter(w => tw.has(w) || [...tw].some(t => t.startsWith(w) || w.startsWith(t) && t.length > 3)).length / qw.length : 0;
    return { ...c, final: 0.5 * c.score + 0.5 * cover + 0.1 * c.sim };
  }).filter((c: Cand) => c.final! >= 0.55).sort((a: Cand, b: Cand) => b.final! - a.final! || (b.rating || 0) - (a.rating || 0) || a.title.length - b.title.length);
  if (!cands.length) return {};
  const norm = (s: string) => words(s).join(" ");
  const exact = cands.find(c => norm(c.title) === norm(spoken));
  if (exact) return { pick: exact };
  const close = cands.filter(c => cands[0].final! - c.final! < 0.04);
  if (close.length === 1) return { pick: cands[0] };
  // A clear favourite among near-ties: a staple, or rated higher.
  const top = [...close].sort((a, b) => (b.staple ? 1 : 0) - (a.staple ? 1 : 0) || (b.rating || 0) - (a.rating || 0));
  if ((top[0].staple && !top[1].staple) || (top[0].rating || 0) > (top[1].rating || 0)) return { pick: top[0] };
  return { ask: close.slice(0, 3) };
}
const ORD: Record<string, number> = { first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2, last: -1 };
function pickOption(spoken: string, opts: Cand[]): Cand | undefined {
  const raw = spoken.toLowerCase().split(/\s+/);
  for (const w of raw) if (w in ORD) return ORD[w] < 0 ? opts[opts.length - 1] : opts[ORD[w]];
  const qw = words(spoken).filter(w => !["one", "that", "thi", "kind", "version", "with"].includes(w));
  if (!qw.length) return undefined;
  const hits = opts.map(o => { const tw = new Set(words(o.title)); return qw.filter(w => tw.has(w) || [...tw].some(t => t.startsWith(w))).length; });
  const best = Math.max(...hits);
  return best > 0 && hits.filter(h => h === best).length === 1 ? opts[hits.indexOf(best)] : undefined;
}
function sayTitle(t: string) { return t.replace(/\(.*?\)/g, "").replace(/[“”"]/g, "").replace(/\s+-\s+/g, ", ").replace(/&/g, "and").trim(); }
function orList(a: string[]) { return a.length <= 1 ? a.join("") : a.slice(0, -1).join(", ") + ", or " + a[a.length - 1]; }
function andList(a: string[]) { return a.length <= 1 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]; }

// ── responses ────────────────────────────────────────────────────────────────
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function speak(text: string, opts: { end?: boolean; reprompt?: string; directives?: any[]; attrs?: any } = {}) {
  const r: any = { outputSpeech: { type: "SSML", ssml: `<speak>${esc(text)}</speak>` }, shouldEndSession: opts.end !== false };
  if (opts.reprompt) { r.reprompt = { outputSpeech: { type: "SSML", ssml: `<speak>${esc(opts.reprompt)}</speak>` } }; r.shouldEndSession = false; }
  if (opts.directives) { r.directives = opts.directives; r.shouldEndSession = false; }
  return { version: "1.0", sessionAttributes: opts.attrs || {}, response: r };
}
// Ask a follow-up question. The answer comes back as AnswerIntent (or the same
// intent again) and is merged onto the pending request in handle().
function elicit(intent: any, slot: string, text: string, attrs?: any) {
  return speak(text, { reprompt: text, attrs: { ...(attrs || {}), pending: { intent: intent.name, slots: intent.slots || {}, ask: slot } } });
}
function filled(slots: any) {
  const out: any = {};
  for (const [k, v] of Object.entries(slots || {})) if ((v as any)?.value) out[k] = v;
  return out;
}

// ── calendar ─────────────────────────────────────────────────────────────────
async function addMeal(date: string, slot: string, recipe: Cand, servings: number) {
  const { error } = await sb.from("calendar").upsert(
    // added_at now + deleted_at null: a voice add deliberately revives a meal deleted earlier.
    { date, slot, recipe_id: recipe.id, servings, leftover: false, updated_at: new Date().toISOString(), added_at: new Date().toISOString(), deleted_at: null },
    { onConflict: "date,slot,recipe_id" });
  if (error) throw error;
}
async function mealsOn(date: string, slot?: string) {
  let q = sb.from("calendar").select("slot,recipe_id,leftover").eq("date", date).is("deleted_at", null);
  if (slot) q = q.eq("slot", slot);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data || []) as any[];
  const ids = [...new Set(rows.map(r => r.recipe_id))];
  if (ids.length) {
    const { data: rs } = await sb.from("recipes").select("id,title").in("id", ids);
    const t = new Map((rs || []).map((r: any) => [r.id, r.title]));
    rows.forEach(r => r.title = t.get(r.recipe_id));
  }
  return rows;
}

// Resolve the Recipe slot, or return a response asking about it.
async function recipeFromIntent(intent: any, attrs: any, ask: string): Promise<{ recipe?: Cand; resp?: any }> {
  const spoken = rawVal(intent, "Recipe") || slotVal(intent, "Recipe");
  if (!spoken) return { resp: elicit(intent, "Recipe", ask, attrs) };
  if (attrs.recipe && attrs.recipe.spoken === spoken) return { recipe: attrs.recipe.cand };
  // Answering "which one?": choose among the options just read out.
  if (Array.isArray(attrs.options) && attrs.options.length) {
    const opts: Cand[] = attrs.options;
    const choice = pickOption(spoken, opts);
    attrs.options = undefined;
    if (choice) { attrs.recipe = { spoken, cand: choice }; return { recipe: choice }; }
  }
  const m = await findRecipe(spoken);
  if (m.pick) { attrs.recipe = { spoken, cand: m.pick }; return { recipe: m.pick }; }
  if (m.ask) {
    const names = m.ask.map(c => sayTitle(c.title));
    attrs.options = m.ask;
    return { resp: elicit(intent, "Recipe", `I have a few like that: ${orList(names)}. Which one?`, attrs) };
  }
  return { resp: elicit(intent, "Recipe", `I couldn't find ${spoken} in the recipe book. What's it called?`, attrs) };
}

async function handle(body: any) {
  const req = body.request || {};
  const attrs = body.session?.attributes || {};
  // Inside an opened skill ("Alexa, open Henschel Kitchen") keep listening, so
  // several things can be said in a row. Alexa+ otherwise takes the
  // conversation back and answers follow-ups itself, wrongly. A one-shot
  // ("Alexa, ask Henschel Kitchen what's for dinner") still ends after one answer.
  const inSession = body.session?.new === false;
  const done = (text: string) => inSession ? speak(`${text} Anything else?`, { reprompt: "Anything else?" }) : speak(text);
  if (req.type === "LaunchRequest")
    return speak("Henschel Kitchen. Say something like, put tacos on Tuesday, we made spaghetti, or what's for dinner.", { reprompt: "What do you want to plan?" });
  if (req.type === "SessionEndedRequest") return { version: "1.0", response: {} };
  if (req.type !== "IntentRequest") return speak("Sorry, I didn't get that.");

  let intent = req.intent || {};
  // "that's all" / "no thanks" can land in the bare {Recipe} answer slot.
  const said = (rawVal(intent, "Recipe") || "").trim();
  if (/^(that'?s (all|it)|no( thanks| thank you)?|nope|nothing( else)?|i'?m (done|good)|done|all done|stop|cancel|exit|never ?mind|we'?re good)$/i.test(said))
    return speak("Okay.");
  // Stitch an answer onto the question that was asked.
  if (attrs.pending && (intent.name === "AnswerIntent" || intent.name === attrs.pending.intent)) {
    intent = { name: attrs.pending.intent, slots: { ...attrs.pending.slots, ...filled(intent.slots) } };
    delete attrs.pending;
  } else if (intent.name === "AnswerIntent") {
    intent = { name: "PlanMealIntent", slots: intent.slots };
  }
  delete attrs.pending;
  switch (intent.name) {
    case "PlanMealIntent": {
      const r = await recipeFromIntent(intent, attrs, "What should I put on the calendar?");
      if (r.resp) return r.resp;
      const recipe = r.recipe!;
      const d = resolveDate(slotVal(intent, "Day"));
      if (!d.iso) return elicit(intent, "Day", d.vague ? `Which day for ${sayTitle(recipe.title)}?` : "What day?", attrs);
      if (daysBetween(todayISO(), d.iso) < 0) return elicit(intent, "Day", "That day's already gone. What day?", attrs);
      const slot = slotVal(intent, "Meal") || "dinner";
      const spokenN = Number(slotVal(intent, "Servings"));
      const servings = spokenN > 0 && spokenN < 100 ? spokenN : (recipe.servings || 4);
      await addMeal(d.iso, slot, recipe, servings);
      return done(`Done. ${sayTitle(recipe.title)} for ${slot} ${spokenDay(d.iso)}, serves ${servings}.`);
    }
    case "MadeItIntent": {
      const r = await recipeFromIntent(intent, attrs, "What did you make?");
      if (r.resp) return r.resp;
      const recipe = r.recipe!;
      const today = todayISO();
      const already = (await mealsOn(today)).some(m => m.recipe_id === recipe.id && !m.leftover);
      if (already) return done(`${sayTitle(recipe.title)} is already on today's calendar.`);
      const slot = slotVal(intent, "Meal") || slotForNow();
      await addMeal(today, slot, recipe, recipe.servings || 4);
      return done(`Logged ${sayTitle(recipe.title)} for ${slot} today.`);
    }
    case "WhatsForDinnerIntent": {
      const d = resolveDate(slotVal(intent, "Day"));
      const iso = d.iso || todayISO();
      const slot = slotVal(intent, "Meal") || "dinner";
      const rows = await mealsOn(iso, slot);
      const titles = [...new Set(rows.map(m => sayTitle(m.title || "something")))];
      const when = spokenDay(iso);
      if (!titles.length) return done(`Nothing's planned for ${slot} ${when} yet.`);
      const left = rows.length && rows.every(m => m.leftover) ? ", leftovers" : "";
      return done(`${when[0].toUpperCase() + when.slice(1)}'s ${slot} is ${andList(titles)}${left}.`);
    }
    case "AMAZON.HelpIntent":
      return speak("Try: put tacos on Tuesday. Or: spaghetti for lunch tomorrow for six. Or: we made burgers. Or: what's for dinner Friday.", { reprompt: "What do you want to plan?" });
    case "AMAZON.CancelIntent": case "AMAZON.StopIntent": case "AMAZON.NavigateHomeIntent": case "AMAZON.NoIntent":
      return speak("Okay.");
    case "AMAZON.FallbackIntent":
      return speak("I can plan a meal, log what you made, or tell you what's for dinner. Try: put tacos on Tuesday.", { reprompt: "What do you want to plan?" });
    default:
      return speak("Sorry, I can't do that one yet.");
  }
}

// ── interaction model, built live from the recipe book ───────────────────────
// GET ?model=1 returns the JSON to paste into the Alexa console's JSON Editor.
// Recipe titles are only pronunciation hints: unmatched names still arrive as
// raw text and are matched above, so a new recipe works before any rebuild.
function spokenForm(t: string) {
  return t.replace(/\(.*?\)|\[.*?\]|\{.*?\}/g, " ").replace(/:.*$/, " ").replace(/^xxx\s*-\s*/i, "")
    .replace(/recipe by tasty|copy ?cat|\bversion \d+\b|\brecipe\b/gi, " ")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[’‘]/g, "'").replace(/&/g, " and ")
    .replace(/[^A-Za-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}
async function buildModel() {
  const { data } = await sb.from("recipes").select("title,tags");
  const vals = new Set<string>();
  (data || []).forEach((r: any) => {
    if (Array.isArray(r.tags) && r.tags.includes("quick-add")) return;
    const v = spokenForm(r.title || "");
    if (v.length >= 3 && v.length <= 140) vals.add(v);
  });
  return {
    interactionModel: {
      languageModel: {
        invocationName: "henschel kitchen",
        intents: [
          { name: "AMAZON.CancelIntent", samples: [] }, { name: "AMAZON.HelpIntent", samples: [] },
          { name: "AMAZON.StopIntent", samples: [] }, { name: "AMAZON.NavigateHomeIntent", samples: [] },
          { name: "AMAZON.FallbackIntent", samples: [] },
          { name: "AMAZON.NoIntent", samples: ["that's all", "that's it", "no thanks", "nope", "I'm done", "nothing else"] },
          { name: "PlanMealIntent",
            slots: [
              { name: "Recipe", type: "RECIPE_NAME" },
              { name: "Day", type: "AMAZON.DATE" },
              { name: "Meal", type: "MEAL_SLOT" },
              { name: "Servings", type: "AMAZON.NUMBER" }],
            samples: [
              "put {Recipe} on {Day}", "put {Recipe} on the calendar for {Day}", "put {Recipe} on the calendar",
              "add {Recipe} to {Day}", "add {Recipe} to {Day} {Meal}", "add {Recipe} for {Day}", "add {Recipe} to the calendar",
              "{Recipe} on {Day}", "{Recipe} for {Day}", "{Recipe} {Day}", "{Recipe} for {Meal} {Day}", "{Recipe} for {Day} {Meal}",
              "plan {Recipe}", "plan {Recipe} for {Day}", "plan {Recipe} for {Meal} {Day}", "schedule {Recipe} for {Day}",
              "we're having {Recipe} {Day}", "we are having {Recipe} on {Day}", "make {Recipe} on {Day}",
              "{Recipe} for {Day} for {Servings}", "put {Recipe} on {Day} for {Servings}", "{Recipe} for {Servings} on {Day}",
              "{Recipe} for {Servings} people {Day}", "put {Recipe} on {Day} {Meal} for {Servings}", "{Recipe} on {Day} for {Servings} people"] },
          { name: "MadeItIntent",
            slots: [{ name: "Recipe", type: "RECIPE_NAME" }, { name: "Meal", type: "MEAL_SLOT" }],
            samples: [
              "we made {Recipe}", "we made {Recipe} for {Meal}", "we had {Recipe}", "we had {Recipe} for {Meal}",
              "we had {Recipe} tonight", "we ate {Recipe}", "I made {Recipe}", "I made {Recipe} for {Meal}",
              "we cooked {Recipe}", "log {Recipe}", "tonight we had {Recipe}"] },
          { name: "WhatsForDinnerIntent",
            slots: [{ name: "Day", type: "AMAZON.DATE" }, { name: "Meal", type: "MEAL_SLOT" }],
            samples: [
              "what's for dinner", "what's for dinner {Day}", "what's for dinner on {Day}", "what's for {Meal}", "what's for {Meal} {Day}",
              "what are we having", "what are we having {Day}", "what are we having for {Meal}", "what are we having for {Meal} {Day}",
              "what's on the menu", "what's on the menu {Day}", "what's planned for {Day}", "what's planned for {Meal} {Day}",
              "what are we eating {Day}"] },
          // Answers to "which one?" / "what day?"; merged onto the question in handle().
          { name: "AnswerIntent",
            slots: [{ name: "Recipe", type: "RECIPE_NAME" }, { name: "Day", type: "AMAZON.DATE" }],
            samples: ["{Recipe}", "the {Recipe}", "the {Recipe} one", "{Recipe} please", "{Day}", "on {Day}", "for {Day}", "make it {Day}"] },
        ],
        types: [
          { name: "RECIPE_NAME", values: [...vals].sort().map(v => ({ name: { value: v } })) },
          { name: "MEAL_SLOT", values: [
            { name: { value: "breakfast", synonyms: ["brunch", "the morning"] } },
            { name: { value: "lunch", synonyms: ["noon", "midday"] } },
            { name: { value: "dinner", synonyms: ["supper", "dinner time"] } },
            { name: { value: "snack", synonyms: ["a snack", "snacks"] } }] },
        ],
      },
    },
  };
}

Deno.serve(async (req) => {
  const cors = { "Access-Control-Allow-Origin": "*" };
  if (req.method === "GET" && new URL(req.url).searchParams.get("model"))
    return new Response(JSON.stringify(await buildModel(), null, 2), { headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method !== "POST") return new Response("alexa-kitchen", { status: 200, headers: cors });
  const raw = await req.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
  const cfg = await config();
  const isTest = !!cfg.test_key && req.headers.get("x-kitchen-test") === cfg.test_key;
  if (!isTest) {
    const why = await verifyAlexa(req, raw).catch(e => "verify error: " + e.message);
    if (why) { console.warn("rejected:", why); return new Response("forbidden", { status: 400 }); }
    const ts = Date.parse(body?.request?.timestamp || "");
    if (!ts || Math.abs(Date.now() - ts) > 150_000) return new Response("stale", { status: 400 });
  }
  const appId = body?.session?.application?.applicationId || body?.context?.System?.application?.applicationId;
  if (cfg.skill_id && appId !== cfg.skill_id) return new Response("wrong skill", { status: 400 });
  try {
    return Response.json(await handle(body));
  } catch (e) {
    console.error(e);
    return Response.json(speak("Something went wrong on my end. Try again in a minute."));
  }
});
