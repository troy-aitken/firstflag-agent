#!/usr/bin/env node
/**
 * push.mjs: approved FirstFlag signals -> your sequencer.
 *
 *   node push.mjs --to emailbison|smartlead|instantly|csv [--campaign <id>] [--workspace <slug>] [--out <file>] [--dry-run]
 *
 * 1. Reads APPROVED signals from the FirstFlag REST API (GET /v1/signals?status=approved).
 * 2. Maps each one to a lead: email, name, title, company, plus ff_* custom variables
 *    (subject, body, opener, signal, why now, source URL). Rows without an email are skipped.
 * 3. Pushes the leads to the sequencer campaign, or writes a CSV.
 * 4. Marks every pushed signal "sent" in FirstFlag (MCP mark_signal), so it never goes out twice.
 *
 * Zero dependencies, Node 18+. Keys come from the environment and are never printed.
 */
import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const VARS = ["ff_subject", "ff_body", "ff_opener", "ff_signal", "ff_why_now", "ff_source_url"];
const PROVIDERS = ["emailbison", "smartlead", "instantly", "csv"];
const RETRIES = 3;
/** Lets FirstFlag count plugin traffic separately from the app and direct API use. */
export const CLIENT = "firstflag-agent/0.1.0";
const USAGE = `usage: node push.mjs --to <${PROVIDERS.join("|")}> [--campaign <id>] [--workspace <slug>] [--out <file>] [--dry-run]`;

// ── args ─────────────────────────────────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const a = { to: "", campaign: "", workspace: "", out: "", dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UserError(`${k} needs a value.\n${USAGE}`);
      return v;
    };
    if (k === "--to") a.to = val().toLowerCase();
    else if (k === "--campaign") a.campaign = val();
    else if (k === "--workspace") a.workspace = val();
    else if (k === "--out") a.out = val();
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--help" || k === "-h") a.help = true;
    else throw new UserError(`Unknown argument ${k}.\n${USAGE}`);
  }
  if (a.help) return a;
  if (!PROVIDERS.includes(a.to)) throw new UserError(`--to must be one of ${PROVIDERS.join(", ")}.\n${USAGE}`);
  if (a.to !== "csv" && !a.campaign) throw new UserError(`--campaign <id> is required for ${a.to}.`);
  return a;
}

/** An error the user can fix. Printed without a stack trace. */
export class UserError extends Error {}

// ── mapping ──────────────────────────────────────────────────────────────────────────────────────────────

const oneLine = (v) => String(v ?? "").replace(/\s+/g, " ").trim();

/** First http(s) URL in the signal details (the article, the posting, the filing), at most two levels down. */
export function sourceUrl(details) {
  let found = "";
  const visit = (v, depth) => {
    if (found) return;
    if (typeof v === "string") { if (/^https?:\/\//i.test(v) && v.length < 600) found = v; return; }
    if (depth > 1 || !v || typeof v !== "object") return;
    for (const x of Array.isArray(v) ? v.slice(0, 20) : Object.values(v)) visit(x, depth + 1);
  };
  for (const [k, v] of Object.entries(details ?? {})) if (k !== "ad_context") visit(v, 0);
  return found;
}

/** A FirstFlag v1 signal -> a sequencer lead, or null when there is no email to send to. */
export function toLead(s) {
  const email = oneLine(s?.contact?.email).toLowerCase();
  if (!email || !email.includes("@")) return null;
  const d = s.details ?? {};
  return {
    signal_id: s.id,
    email,
    first_name: oneLine(s.contact.first_name),
    last_name: oneLine(s.contact.last_name),
    title: oneLine(s.contact.title),
    company: oneLine(s.company?.name || s.company?.domain),
    verified: !!s.contact.email_verified_at,
    vars: {
      ff_subject: oneLine(s.draft?.subject),
      ff_body: String(s.draft?.body ?? "").trim(),
      ff_opener: oneLine(s.draft?.opener),
      ff_signal: oneLine(s.signal_label || s.signal_type),
      ff_why_now: oneLine(typeof d.summary === "string" && d.summary ? d.summary : s.signal_label || s.signal_type).slice(0, 400),
      ff_source_url: sourceUrl(d),
    },
  };
}

// ── CSV ──────────────────────────────────────────────────────────────────────────────────────────────────

const CSV_COLUMNS = ["email", "first_name", "last_name", "title", "company", ...VARS, "signal_id"];

export function csvCell(v) {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(leads) {
  const rows = leads.map((l) => CSV_COLUMNS.map((c) => csvCell(c in l.vars ? l.vars[c] : l[c])).join(","));
  return [CSV_COLUMNS.join(","), ...rows].join("\r\n") + "\r\n";
}

// ── secrets ──────────────────────────────────────────────────────────────────────────────────────────────

const SECRET_ENV = ["FIRSTFLAG_API_KEY", "EMAILBISON_API_KEY", "SMARTLEAD_API_KEY", "INSTANTLY_API_KEY"];

/**
 * Every line this script prints goes through here: each key from the environment, any `api_key=` query value
 * (Smartlead's auth) and any Bearer token become [redacted]. Error text from fetch or a sequencer can quote a
 * URL or echo a header; this is the backstop that keeps a key out of the terminal and the transcript.
 */
export function redactor(env = {}) {
  const keys = SECRET_ENV.map((n) => env[n]).filter((v) => typeof v === "string" && v.length >= 6);
  return (text) => {
    let s = String(text);
    for (const k of keys) s = s.split(k).join("[redacted]");
    return s.replace(/(api_key=)[^&\s"']+/gi, "$1[redacted]").replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]");
  };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * fetch with 3 retries on 429, 5xx and network errors (Retry-After honoured, else 1s, 2s, 4s).
 * `label` is what errors show. It never contains a URL, so a key in a query string cannot leak.
 */
async function send(deps, url, init, label) {
  for (let attempt = 0; ; attempt++) {
    let res, err;
    try { res = await deps.fetch(url, init); } catch (e) { err = e; }
    if (res && res.status !== 429 && res.status < 500) return res;
    if (attempt >= RETRIES) {
      if (res) return res;
      throw new Error(`${label}: network error (${oneLine(err?.cause?.code || err?.message || err)})`);
    }
    const ra = Number(res?.headers?.get?.("retry-after"));
    await deps.sleep(ra > 0 ? Math.min(ra, 60) * 1000 : 1000 * 2 ** attempt);
  }
}

/** Parse a response as JSON (or SSE `data:` lines) and throw a readable error on a non-2xx. */
async function readJson(res, label) {
  const text = await res.text();
  let body = {};
  const ct = res.headers?.get?.("content-type") ?? "";
  try {
    if (ct.includes("text/event-stream")) {
      const last = text.split(/\r?\n/).filter((l) => l.startsWith("data:")).pop();
      body = last ? JSON.parse(last.slice(5)) : {};
    } else body = text ? JSON.parse(text) : {};
  } catch { body = { raw: text }; }
  if (!res.ok) {
    const msg = body?.message || body?.error?.message || body?.error || body?.raw || "";
    throw new Error(`${label}: HTTP ${res.status}${msg ? ` ${oneLine(typeof msg === "string" ? msg : JSON.stringify(msg)).slice(0, 300)}` : ""}`);
  }
  return body;
}

// ── FirstFlag ────────────────────────────────────────────────────────────────────────────────────────────

function firstflag(env, deps, workspace) {
  const base = (env.FIRSTFLAG_API_BASE || "https://api.firstflag.io").replace(/\/+$/, "");
  const key = env.FIRSTFLAG_API_KEY;
  if (!key) throw new UserError("FIRSTFLAG_API_KEY is not set. Create a key at https://firstflag.io/settings/connect and export it.");
  const headers = { Authorization: `Bearer ${key}`, Accept: "application/json", "X-FirstFlag-Client": CLIENT };
  let orgKey = false;

  async function get(path) {
    const res = await send(deps, `${base}/v1${path}`, { headers: { ...headers, ...(workspace ? { "X-FirstFlag-Workspace": workspace } : {}) } }, `FirstFlag GET ${path.split("?")[0]}`);
    if (res.status === 401) throw new UserError("FirstFlag rejected FIRSTFLAG_API_KEY (invalid or revoked). Make a new one at https://firstflag.io/settings/connect.");
    if (res.status === 403) {
      const b = await res.json().catch(() => ({}));
      throw new UserError(`FirstFlag: ${b.message || "this key cannot use the API."}`);
    }
    return readJson(res, `FirstFlag GET ${path.split("?")[0]}`);
  }

  return {
    /** Which key is this? An agency key must name a workspace: one client's leads, one client's campaign. */
    async whoami() {
      const me = await get("/me");
      orgKey = me.key_scope === "organization";
      if (orgKey && !workspace) {
        const list = (me.workspaces ?? []).map((w) => w.slug).join(", ");
        throw new UserError(`This is an agency key. Pass --workspace <slug> so one client's leads go to one client's campaign.${list ? ` Workspaces: ${list}` : ""}`);
      }
      return { account: me.workspace?.name || me.account?.name || workspace || "", orgKey };
    },

    async approved() {
      const out = [];
      let cursor = "";
      for (let page = 0; page < 100; page++) {
        const qs = new URLSearchParams({ status: "approved", limit: "200" });
        if (cursor) qs.set("cursor", cursor);
        const body = await get(`/signals?${qs}`);
        out.push(...(body.data ?? []));
        if (!body.has_more || !body.next_cursor) break;
        cursor = body.next_cursor;
      }
      return out;
    },

    /** MCP tools/call mark_signal action=sent. The REST API has no "sent" route; the MCP tool runs the app's own export. */
    async markSent(signalId, id) {
      const args = { signal_id: signalId, action: "sent", ...(orgKey && workspace ? { workspace } : {}) };
      // The tool runs on FirstFlag's /v1 limiter (120/min per key) behind the MCP one, so a big push can get a
      // rate_limited tool result inside an HTTP 200. That one is worth waiting out; anything else is not.
      for (let attempt = 0; ; attempt++) {
        const res = await send(deps, `${base}/mcp`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-FirstFlag-Client": CLIENT },
          body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "mark_signal", arguments: args } }),
        }, "FirstFlag mark_signal");
        const body = await readJson(res, "FirstFlag mark_signal");
        if (body.error) throw new Error(`mark_signal: ${body.error.message ?? JSON.stringify(body.error)}`);
        if (!body.result?.isError) return;
        let m = body.result.content?.[0]?.text ?? "failed", code = "";
        try { const j = JSON.parse(m); code = String(j.error ?? ""); m = j.message ?? m; } catch { /* plain text */ }
        if (code === "rate_limited" && attempt < RETRIES) {
          const wait = Number(/retry in (\d+)\s*s/i.exec(String(m))?.[1]);
          await deps.sleep((wait > 0 ? Math.min(wait, 60) : 30) * 1000);
          continue;
        }
        throw new Error(`mark_signal: ${oneLine(m).slice(0, 200)}`);
      }
    },
  };
}

// ── sequencers ───────────────────────────────────────────────────────────────────────────────────────────
// Each returns { pushed: [lead], failed: [{ email, message }] }. Only `pushed` leads get marked sent.

const need = (env, name, hint) => {
  if (!env[name]) throw new UserError(`${name} is not set.${hint ? ` ${hint}` : ""}`);
  return env[name];
};
const chunks = (xs, n) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const flatVars = (l) => ({ title: l.title, ...l.vars });

/**
 * Read an Instantly /leads/add answer for one batch: which leads it created (by index, else email), which it did
 * not, and whether any were refused for a reason other than "already in this campaign".
 */
export function instantlyResult(body, batch) {
  const b = body && typeof body === "object" ? body : {};
  const hit = new Set();
  for (const c of Array.isArray(b.created_leads) ? b.created_leads : []) {
    const i = Number(c?.index);
    if (Number.isInteger(i) && batch[i]) hit.add(i);
    else if (c?.email) { const j = batch.findIndex((l) => l.email === String(c.email).toLowerCase()); if (j >= 0) hit.add(j); }
  }
  const n = (k) => Number(b[k] ?? 0) || 0;
  const reasons = [["in_blocklist", "block list"], ["invalid_email_count", "invalid email"], ["skipped_count", "skipped"], ["incomplete_count", "incomplete"]]
    .filter(([k]) => n(k) > 0).map(([k, why]) => `${n(k)} ${why}`);
  return {
    created: batch.filter((_, i) => hit.has(i)),
    missing: batch.filter((_, i) => !hit.has(i)),
    rejected: reasons.length > 0,
    duplicated: n("duplicated_leads"),
    reason: reasons.join(", ") || (n("duplicated_leads") ? "already in this campaign" : "no reason given"),
  };
}

/**
 * Read a Smartlead add-leads answer: { error } when the whole batch failed, else the skipped emails and why.
 * Handles the documented shape (success, added_count, skipped_count, skipped_leads) and the older one (ok,
 * upload_count, already_added_to_campaign, ...).
 */
export function smartleadResult(body, batch) {
  const b = body && typeof body === "object" ? body : {};
  if (b.success === false || b.ok === false) return { error: oneLine(b.message || b.error || "Smartlead reported a failure").slice(0, 200) };
  const skipped = new Map();
  const named = new Set();
  for (const s of Array.isArray(b.skipped_leads) ? b.skipped_leads : []) {
    const email = oneLine(typeof s === "string" ? s : s?.email).toLowerCase();
    if (!email) continue;
    named.add(email);
    const reason = oneLine(typeof s === "string" ? "" : s?.reason ?? s?.message ?? "");
    const inThisCampaign = /already/i.test(reason) && /campaign/i.test(reason) && !/other|another|different/i.test(reason);
    if (!inThisCampaign) skipped.set(email, reason);
  }
  const added = Number(b.added_count ?? b.upload_count);
  const already = Number(b.already_added_to_campaign ?? 0) || 0;
  const unique = new Set(batch.map((l) => l.email)).size;
  if (Number.isFinite(added) && unique - added - already - named.size > 0) {
    return { error: `Smartlead added ${added} of ${unique} and did not say which were skipped. None of this batch was marked sent; check the campaign, then run again (leads already in it are not added twice).` };
  }
  return { skipped };
}

export const sequencers = {
  /**
   * EmailBison (your own instance). Custom variables must exist before a lead can carry them; creating a lead
   * does not put it in a campaign (attach-leads does); a failed write can come back as HTTP 200 with
   * data.success=false, which is an error.
   */
  async emailbison(leads, { campaign, env, deps }) {
    const base = need(env, "EMAILBISON_BASE_URL", "Your instance's API root, e.g. https://send.youragency.com/api").replace(/\/+$/, "");
    const key = need(env, "EMAILBISON_API_KEY", "Use the workspace API key for this client's EmailBison workspace.");
    const bison = async (method, path, body) => {
      const label = `EmailBison ${method} ${path}`;
      const res = await send(deps, `${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, label);
      if (res.status === 401 || res.status === 403) throw new UserError(`${label}: EmailBison rejected EMAILBISON_API_KEY.`);
      const j = await readJson(res, label);
      if (j?.data?.success === false) throw new Error(`${label}: ${oneLine(j.data.message).slice(0, 300)}`);
      return j;
    };

    for (const name of VARS) {
      try { await bison("POST", "/custom-variables", { name }); }
      catch (e) { if (!/already (exist|been taken)|has already/i.test(e.message)) throw e; }
    }

    const pushed = [], failed = [];
    for (const batch of chunks(leads, 100)) {
      // One batch failing must not lose the batches before it: those leads are in the campaign and still get
      // marked sent. Only a rejected key on the very first write stops the run outright.
      try {
        const j = await bison("POST", "/leads/create-or-update/multiple", {
          existing_lead_behavior: "patch",
          leads: batch.map((l) => ({
            first_name: l.first_name, last_name: l.last_name, email: l.email, title: l.title, company: l.company,
            custom_variables: VARS.map((name) => ({ name, value: l.vars[name] })),
          })),
        });
        const ids = new Map();
        for (const row of Array.isArray(j?.data) ? j.data : []) if (row?.email && row?.id) ids.set(String(row.email).toLowerCase(), Number(row.id));
        for (const e of Array.isArray(j?.errors) ? j.errors : []) failed.push({ email: String(e?.email ?? "").toLowerCase(), message: oneLine(e?.message ?? e?.error ?? JSON.stringify(e)).slice(0, 200) });
        const ok = batch.filter((l) => ids.has(l.email));
        for (const l of batch) if (!ids.has(l.email) && !failed.some((f) => f.email === l.email)) failed.push({ email: l.email, message: "EmailBison returned no lead id" });
        if (ok.length) {
          try {
            await bison("POST", `/campaigns/${encodeURIComponent(campaign)}/leads/attach-leads`, { lead_ids: ok.map((l) => ids.get(l.email)), allow_parallel_sending: false });
            pushed.push(...ok);
          } catch (e) {
            if (e instanceof UserError && !pushed.length) throw e;
            for (const l of ok) failed.push({ email: l.email, message: `lead saved in EmailBison but not attached to the campaign: ${e.message}` });
          }
        }
      } catch (e) {
        if (e instanceof UserError && !pushed.length) throw e;
        for (const l of batch) if (!failed.some((f) => f.email === l.email)) failed.push({ email: l.email, message: e.message });
      }
    }
    return { pushed, failed };
  },

  /**
   * Smartlead: POST /api/v1/campaigns/{id}/leads?api_key=, lead_list of up to 400 (we send 100). Smartlead answers
   * 200 even when it skips leads (block list, unsubscribed, bounce list, already in another campaign, invalid), with
   * added_count / skipped_count / skipped_leads[{email, reason}]. A skipped lead is not in the campaign, so it is a
   * failure and is not marked sent; "already in this campaign" counts as pushed. When the counts say leads were
   * skipped but not which ones, no lead in that batch is marked sent (better re-pushed than silently lost).
   */
  async smartlead(leads, { campaign, env, deps }) {
    const key = need(env, "SMARTLEAD_API_KEY", "Smartlead → Settings → API key.");
    const base = (env.SMARTLEAD_BASE_URL || "https://server.smartlead.ai/api/v1").replace(/\/+$/, "");
    const url = `${base}/campaigns/${encodeURIComponent(campaign)}/leads?api_key=${encodeURIComponent(key)}`;
    const label = `Smartlead POST /campaigns/${campaign}/leads`;
    const pushed = [], failed = [];
    for (const batch of chunks(leads, 100)) {
      try {
        const res = await send(deps, url, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            lead_list: batch.map((l) => ({ email: l.email, first_name: l.first_name, last_name: l.last_name, company_name: l.company, custom_fields: flatVars(l) })),
          }),
        }, label);
        if (res.status === 401 || res.status === 403) throw new UserError(`${label}: Smartlead rejected SMARTLEAD_API_KEY.`);
        const r = smartleadResult(await readJson(res, label), batch);
        if (r.error) { for (const l of batch) failed.push({ email: l.email, message: `${label}: ${r.error}` }); continue; }
        for (const l of batch) {
          const why = r.skipped.get(l.email);
          if (why !== undefined) failed.push({ email: l.email, message: `Smartlead skipped it: ${why || "no reason given"}` });
          else pushed.push(l);
        }
      } catch (e) {
        if (e instanceof UserError && !pushed.length) throw e;
        for (const l of batch) failed.push({ email: l.email, message: e.message });
      }
    }
    return { pushed, failed };
  },

  /**
   * Instantly API v2 bulk: POST /api/v2/leads/add {campaign_id, leads[<=1000]}, Bearer key with leads:create.
   * No skip_if_* flag is sent: skip_if_in_campaign skips a lead that is in ANY campaign, not just this one.
   * The answer names only the leads it created (created_leads[{index, id, email}]); duplicated_leads (already in
   * this campaign), in_blocklist, invalid_email_count and skipped_count are counts. So:
   *  - created -> pushed.
   *  - not created, and duplicated_leads accounts for every one of them -> already in this campaign -> pushed.
   *  - otherwise -> sent again one per call, which says exactly which it was (re-sending is harmless: a duplicate
   *    is not re-added and a blocked lead is refused again).
   * Block-listed and invalid leads are never marked sent.
   */
  async instantly(leads, { campaign, env, deps }) {
    const key = need(env, "INSTANTLY_API_KEY", "Instantly → Settings → Integrations → API keys (v2).");
    const base = (env.INSTANTLY_BASE_URL || "https://api.instantly.ai/api/v2").replace(/\/+$/, "");
    const label = "Instantly POST /leads/add";
    const add = async (group) => {
      const res = await send(deps, `${base}/leads/add`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          campaign_id: campaign,
          leads: group.map((l) => ({ email: l.email, first_name: l.first_name, last_name: l.last_name, company_name: l.company, job_title: l.title, custom_variables: flatVars(l) })),
        }),
      }, label);
      if (res.status === 401 || res.status === 403) throw new UserError("Instantly rejected INSTANTLY_API_KEY (it needs the leads:create scope).");
      return instantlyResult(await readJson(res, label), group);
    };

    // One payload row per email: two signals for one person are one lead, and both are marked when it lands.
    const byEmail = new Map();
    for (const l of leads) byEmail.set(l.email, [...(byEmail.get(l.email) ?? []), l]);
    const unique = [...byEmail.values()].map((ls) => ls[0]);
    const pushed = [], failed = [];
    const ok = (l) => pushed.push(...byEmail.get(l.email));
    const fail = (l, message) => { for (const x of byEmail.get(l.email)) failed.push({ email: x.email, message }); };

    for (const batch of chunks(unique, 500)) {
      try {
        const r = await add(batch);
        r.created.forEach(ok);
        // Nothing blocked or invalid, and the duplicate count covers the rest: they were already in this campaign.
        if (!r.rejected && r.duplicated >= r.missing.length) { r.missing.forEach(ok); continue; }
        for (const l of r.missing) {
          try {
            const one = await add([l]);
            if (one.created.length || (!one.rejected && one.duplicated >= 1)) ok(l);
            else fail(l, `Instantly did not add it (${one.reason})`);
          } catch (e) {
            if (e instanceof UserError && !pushed.length) throw e;
            fail(l, e.message);
          }
        }
      } catch (e) {
        if (e instanceof UserError && !pushed.length) throw e;
        for (const l of batch) if (!pushed.some((p) => p.email === l.email)) fail(l, e.message);
      }
    }
    return { pushed, failed };
  },

  async csv(leads, { out, deps }) {
    deps.writeFile(out, toCsv(leads));
    return { pushed: leads, failed: [], file: out };
  },
};

/**
 * Where the CSV goes. Never over an existing file: a second run the same day would otherwise replace the first
 * run's leads, which are already marked sent and would not come back. The default name gets -2, -3...; an
 * explicit --out that exists is refused.
 */
function csvPath(args, deps) {
  if (args.out) {
    const p = resolve(deps.cwd, args.out);
    if (args.to === "csv" && deps.exists?.(p)) throw new UserError(`${p} already exists. Pick another --out; this script never overwrites a file.`);
    return p;
  }
  for (let n = 1; ; n++) {
    const p = resolve(deps.cwd, `firstflag-signals-${deps.today}${n > 1 ? `-${n}` : ""}.csv`);
    if (!deps.exists?.(p)) return p;
  }
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────────

export async function main(argv, env = process.env, deps = {}) {
  deps = {
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (...a) => console.log(...a),
    writeFile: (p, s) => writeFileSync(p, s, { encoding: "utf8", flag: "wx" }),
    exists: (p) => existsSync(p),
    cwd: process.cwd(),
    today: new Date().toISOString().slice(0, 10),
    ...deps,
  };
  const redact = redactor(env);
  const log = (...a) => deps.log(redact(a.join(" ")));
  try {
    const args = parseArgs(argv);
    if (args.help) { log(USAGE); return 0; }
    const ff = firstflag(env, deps, args.workspace);
    const who = await ff.whoami();
    const signals = await ff.approved();
    const leads = [], skipped = [];
    for (const s of signals) {
      const l = toLead(s);
      if (l) leads.push(l); else skipped.push(s);
    }
    const unverified = leads.filter((l) => !l.verified).length;
    const target = args.to === "csv" ? "CSV" : `${args.to} campaign ${args.campaign}`;
    log(`FirstFlag${who.account ? ` (${who.account})` : ""}: ${signals.length} approved signal${signals.length === 1 ? "" : "s"}, ${leads.length} with an email, ${skipped.length} skipped (no email)${unverified ? `, ${unverified} email${unverified === 1 ? "" : "s"} not verified` : ""}.`);
    if (!leads.length) { log("Nothing to push. Approve signals first (mark_signal approve), then run this again."); return 0; }

    const out = csvPath(args, deps);
    if (args.dryRun) {
      log(`DRY RUN: would push ${leads.length} lead${leads.length === 1 ? "" : "s"} to ${args.to === "csv" ? out : target}, then mark them sent in FirstFlag. Nothing was pushed.`);
      log("First leads:");
      for (const l of leads.slice(0, 3)) {
        log(JSON.stringify({ ...l, vars: { ...l.vars, ff_body: l.vars.ff_body.length > 160 ? `${l.vars.ff_body.slice(0, 160)}…` : l.vars.ff_body } }, null, 2));
      }
      const envNeeded = { emailbison: ["EMAILBISON_BASE_URL", "EMAILBISON_API_KEY"], smartlead: ["SMARTLEAD_API_KEY"], instantly: ["INSTANTLY_API_KEY"], csv: [] }[args.to];
      const missing = envNeeded.filter((n) => !env[n]);
      if (missing.length) log(`Missing before a real push: ${missing.join(", ")}.`);
      return 0;
    }

    const r = await sequencers[args.to](leads, { campaign: args.campaign, env, deps, out });
    log(`Pushed ${r.pushed.length} to ${r.file ?? target}${r.failed.length ? `, ${r.failed.length} failed` : ""}.`);
    for (const f of r.failed.slice(0, 10)) log(`  failed ${f.email}: ${f.message}`);

    let marked = 0;
    const markFailed = [];
    for (const [i, l] of r.pushed.entries()) {
      try { await ff.markSent(l.signal_id, i + 1); marked++; }
      catch (e) { markFailed.push({ id: l.signal_id, message: e.message }); }
    }
    log(`Marked ${marked} signal${marked === 1 ? "" : "s"} sent in FirstFlag.`);
    if (markFailed.length) {
      log(`Could not mark ${markFailed.length} as sent (they are in the sequencer; mark them sent in FirstFlag so they are not pushed twice):`);
      for (const f of markFailed.slice(0, 10)) log(`  ${f.id}: ${f.message}`);
    }
    if (!r.pushed.length && r.failed.length) return 1; // nothing landed
    return r.failed.length || markFailed.length ? 2 : 0;
  } catch (e) {
    log(e instanceof UserError ? `Error: ${e.message}` : `Error: ${e?.message ?? e}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
