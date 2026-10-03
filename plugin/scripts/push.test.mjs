// node --test plugin/scripts/push.test.mjs  (Node 18+, no dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import { main, toLead, toCsv, csvCell, sourceUrl, parseArgs, redactor, smartleadResult, VARS } from "./push.mjs";

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────────

const signal = (over = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  signal_type: "funding",
  signal_label: "Funding rounds",
  status: "approved",
  company: { name: "Acme Robotics", domain: "acmerobotics.com" },
  contact: { first_name: "Dana", last_name: "Reyes", email: "Dana@AcmeRobotics.com", email_verified_at: "2026-09-30T10:00:00Z", title: "VP Sales" },
  draft: { subject: "the series b", body: "Dana,\n\nSaw the $40M Series B.\n\nWorth a chat?", opener: "Saw the $40M Series B." },
  details: { summary: "Acme Robotics raised a $40M Series B led by Northwind.", article: { url: "https://news.example.com/acme-b" }, ad_context: { u: "https://ads.example.com" } },
  ...over,
});
const S1 = signal();
const S2 = signal({ id: "22222222-2222-4222-8222-222222222222", contact: { first_name: "Lee", last_name: "", email: "lee@globex.io", email_verified_at: null, title: "Head of RevOps" }, company: { name: "Globex", domain: "globex.io" }, details: {} });
const NO_EMAIL = signal({ id: "33333333-3333-4333-8333-333333333333", contact: { first_name: "Pat", last_name: "Q", email: null, title: "CEO" } });

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A fetch that answers FirstFlag + one sequencer, and records every call. */
function mockFetch(seq = () => json({ ok: true }), { me = { key_scope: "workspace", account: { name: "Agency Co" } }, signals = [S1, S2, NO_EMAIL] } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body });
    const u = new URL(url);
    if (u.host === "api.firstflag.io") {
      if (u.pathname === "/v1/me") return json(me);
      if (u.pathname === "/v1/signals") {
        // two pages, to exercise the cursor
        if (!u.searchParams.get("cursor")) return json({ data: signals.slice(0, 1), has_more: signals.length > 1, next_cursor: "c1" });
        return json({ data: signals.slice(1), has_more: false, next_cursor: null });
      }
      if (u.pathname === "/mcp") return json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ signal_id: body.params.arguments.signal_id, status: "sent" }) }] } });
    }
    return seq(u, init, body);
  };
  return { fetch, calls };
}

function run(argv, env, fetch, extra = {}) {
  const lines = [];
  const files = {};
  const deps = { fetch, sleep: async () => {}, log: (...a) => lines.push(a.join(" ")), writeFile: (p, s) => { files[p] = s; }, cwd: "/tmp/ff", today: "2026-10-05", ...extra };
  return main(argv, { FIRSTFLAG_API_KEY: "ff_live_secret", ...env }, deps).then((code) => ({ code, out: lines.join("\n"), files }));
}

const marked = (calls) => calls.filter((c) => c.url.endsWith("/mcp")).map((c) => c.body.params.arguments.signal_id);

// ── mapping ──────────────────────────────────────────────────────────────────────────────────────────────

test("toLead maps contact, company and ff_* variables", () => {
  const l = toLead(S1);
  assert.equal(l.email, "dana@acmerobotics.com");
  assert.equal(l.first_name, "Dana");
  assert.equal(l.last_name, "Reyes");
  assert.equal(l.title, "VP Sales");
  assert.equal(l.company, "Acme Robotics");
  assert.equal(l.verified, true);
  assert.deepEqual(Object.keys(l.vars), VARS);
  assert.equal(l.vars.ff_subject, "the series b");
  assert.equal(l.vars.ff_body, "Dana,\n\nSaw the $40M Series B.\n\nWorth a chat?");
  assert.equal(l.vars.ff_opener, "Saw the $40M Series B.");
  assert.equal(l.vars.ff_signal, "Funding rounds");
  assert.equal(l.vars.ff_why_now, "Acme Robotics raised a $40M Series B led by Northwind.");
  assert.equal(l.vars.ff_source_url, "https://news.example.com/acme-b");
});

test("toLead skips a signal with no email, and falls back when details are empty", () => {
  assert.equal(toLead(NO_EMAIL), null);
  assert.equal(toLead(signal({ contact: { email: "not-an-email" } })), null);
  const l = toLead(S2);
  assert.equal(l.verified, false);
  assert.equal(l.vars.ff_why_now, "Funding rounds");
  assert.equal(l.vars.ff_source_url, "");
});

test("sourceUrl ignores ad_context and stops two levels down (same walk as the FirstFlag API)", () => {
  assert.equal(sourceUrl({ ad_context: "https://ads.example.com", a: { b: { c: { d: "https://too-deep.example.com" } } } }), "");
  assert.equal(sourceUrl({ posting: ["https://jobs.example.com/1"] }), "https://jobs.example.com/1");
});

test("parseArgs validates provider and campaign", () => {
  assert.throws(() => parseArgs(["--to", "hubspot"]), /must be one of/);
  assert.throws(() => parseArgs(["--to", "smartlead"]), /--campaign/);
  assert.deepEqual(parseArgs(["--to", "csv", "--dry-run"]).dryRun, true);
});

// ── CSV ──────────────────────────────────────────────────────────────────────────────────────────────────

test("CSV escapes quotes, commas, newlines and formula prefixes", () => {
  assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(csvCell("a\nb"), '"a\nb"');
  assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(csvCell("plain"), "plain");
  const csv = toCsv([toLead(S1)]);
  const [header, row] = csv.split("\r\n");
  assert.equal(header, "email,first_name,last_name,title,company,ff_subject,ff_body,ff_opener,ff_signal,ff_why_now,ff_source_url,signal_id");
  assert.ok(row.startsWith("dana@acmerobotics.com,Dana,Reyes,VP Sales,Acme Robotics,the series b,\"Dana,"));
});

test("csv: writes the file and marks pushed signals sent", async () => {
  const { fetch, calls } = mockFetch();
  const r = await run(["--to", "csv"], {}, fetch);
  assert.equal(r.code, 0, r.out);
  const [path] = Object.keys(r.files);
  assert.match(path, /firstflag-signals-2026-10-05\.csv$/);
  assert.equal(r.files[path].trim().split("\r\n").length, 3); // header + 2 leads (S1's \n stay inside its quoted cell)
  assert.deepEqual(marked(calls), [S1.id, S2.id]);
  assert.match(r.out, /3 approved signals, 2 with an email, 1 skipped \(no email\), 1 email not verified/);
  const mcp = calls.find((c) => c.url.endsWith("/mcp"));
  assert.match(mcp.headers.Accept, /application\/json/);
  assert.match(mcp.headers.Accept, /text\/event-stream/);
  assert.equal(mcp.body.method, "tools/call");
  assert.equal(mcp.body.params.name, "mark_signal");
  assert.equal(mcp.body.params.arguments.action, "sent");
  assert.equal(mcp.body.params.arguments.workspace, undefined); // workspace keys must not send it
});

// ── dry run ──────────────────────────────────────────────────────────────────────────────────────────────

test("--dry-run pushes nothing and marks nothing, and never prints keys", async () => {
  const { fetch, calls } = mockFetch(() => { throw new Error("sequencer must not be called"); });
  const r = await run(["--to", "smartlead", "--campaign", "42", "--dry-run"], { SMARTLEAD_API_KEY: "sl_secret" }, fetch);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /DRY RUN: would push 2 leads to smartlead campaign 42/);
  assert.match(r.out, /dana@acmerobotics\.com/);
  assert.equal(marked(calls).length, 0);
  assert.ok(calls.every((c) => new URL(c.url).host === "api.firstflag.io"));
  assert.doesNotMatch(r.out, /ff_live_secret|sl_secret/);
});

// ── providers ────────────────────────────────────────────────────────────────────────────────────────────

test("emailbison: creates variables, upserts, attaches, marks sent", async () => {
  const { fetch, calls } = mockFetch((u, _init, body) => {
    if (u.pathname === "/api/custom-variables") return body.name === "ff_subject" ? json({ message: "The name has already been taken." }, 422) : json({ data: { id: 1, name: body.name } });
    if (u.pathname === "/api/leads/create-or-update/multiple") return json({ data: body.leads.map((l, i) => ({ id: 100 + i, email: l.email })) });
    if (u.pathname === "/api/campaigns/77/leads/attach-leads") return json({ data: { success: true } });
    return json({}, 404);
  });
  const r = await run(["--to", "emailbison", "--campaign", "77"], { EMAILBISON_BASE_URL: "https://send.agency.test/api/", EMAILBISON_API_KEY: "eb_secret" }, fetch);
  assert.equal(r.code, 0, r.out);
  const vars = calls.filter((c) => c.url.endsWith("/custom-variables")).map((c) => c.body.name);
  assert.deepEqual(vars, VARS);
  const up = calls.find((c) => c.url.endsWith("/leads/create-or-update/multiple"));
  assert.equal(up.body.existing_lead_behavior, "patch");
  assert.equal(up.body.leads.length, 2);
  assert.deepEqual(up.body.leads[0].custom_variables.find((v) => v.name === "ff_signal"), { name: "ff_signal", value: "Funding rounds" });
  assert.equal(up.headers.Authorization, "Bearer eb_secret");
  const at = calls.find((c) => c.url.endsWith("/attach-leads"));
  assert.deepEqual(at.body, { lead_ids: [100, 101], allow_parallel_sending: false });
  assert.deepEqual(marked(calls), [S1.id, S2.id]);
  assert.doesNotMatch(r.out, /eb_secret/);
});

test("emailbison: HTTP 200 with data.success=false is an error, and nothing is marked", async () => {
  const { fetch, calls } = mockFetch((u) => {
    if (u.pathname.endsWith("/custom-variables")) return json({ data: { id: 1 } });
    return json({ data: { success: false, message: "Campaign is archived" } });
  });
  const r = await run(["--to", "emailbison", "--campaign", "77"], { EMAILBISON_BASE_URL: "https://b.test/api", EMAILBISON_API_KEY: "k" }, fetch);
  assert.equal(r.code, 1);
  assert.match(r.out, /Campaign is archived/);
  assert.equal(marked(calls).length, 0);
});

test("smartlead: batches lead_list with custom_fields, key in query never printed", async () => {
  const { fetch, calls } = mockFetch((u) => (u.pathname === "/api/v1/campaigns/42/leads" ? json({ ok: true, upload_count: 2 }) : json({}, 404)));
  const r = await run(["--to", "smartlead", "--campaign", "42"], { SMARTLEAD_API_KEY: "sl_secret" }, fetch);
  assert.equal(r.code, 0, r.out);
  const c = calls.find((x) => x.url.includes("server.smartlead.ai"));
  assert.equal(new URL(c.url).searchParams.get("api_key"), "sl_secret");
  assert.equal(c.body.lead_list.length, 2);
  assert.deepEqual(Object.keys(c.body.lead_list[0]), ["email", "first_name", "last_name", "company_name", "custom_fields"]);
  assert.equal(c.body.lead_list[0].custom_fields.ff_why_now, "Acme Robotics raised a $40M Series B led by Northwind.");
  assert.equal(c.body.lead_list[0].custom_fields.title, "VP Sales");
  assert.deepEqual(marked(calls), [S1.id, S2.id]);
  assert.doesNotMatch(r.out, /sl_secret/);
});

/** An Instantly /leads/add mock: `fate(email)` is "created" | "duplicate" | "blocked" | "invalid". */
function instantlyMock(fate, { throttleFirst = false } = {}) {
  let first = throttleFirst;
  return (u, _init, body) => {
    if (u.pathname !== "/api/v2/leads/add") return json({}, 404);
    if (first) { first = false; return json({ message: "slow down" }, 429, { "retry-after": "1" }); }
    const r = { status: "success", total_sent: body.leads.length, leads_uploaded: 0, in_blocklist: 0, blocklist_used: null, duplicated_leads: 0, skipped_count: 0, invalid_email_count: 0, incomplete_count: 0, duplicate_email_count: 0, remaining_in_plan: 9000, created_leads: [] };
    body.leads.forEach((l, index) => {
      const f = fate(l.email);
      if (f === "created") { r.leads_uploaded++; r.created_leads.push({ index, id: `lead-${index}`, email: l.email }); }
      else if (f === "duplicate") r.duplicated_leads++;
      else if (f === "blocked") r.in_blocklist++;
      else r.invalid_email_count++;
    });
    return json(r);
  };
}

test("instantly: bulk /leads/add with campaign_id, retries a 429, created and same-campaign duplicates are marked", async () => {
  const { fetch, calls } = mockFetch(instantlyMock((e) => (e === "lee@globex.io" ? "duplicate" : "created"), { throttleFirst: true }));
  const r = await run(["--to", "instantly", "--campaign", "c0ffee"], { INSTANTLY_API_KEY: "in_secret" }, fetch);
  assert.equal(r.code, 0, r.out);
  const posts = calls.filter((c) => c.url === "https://api.instantly.ai/api/v2/leads/add");
  assert.equal(posts.length, 2); // 429 + retry, one batch
  assert.equal(posts[0].headers.Authorization, "Bearer in_secret");
  assert.deepEqual(Object.keys(posts[1].body), ["campaign_id", "leads"]); // no skip_if_*: those skip leads in ANY campaign
  assert.equal(posts[1].body.campaign_id, "c0ffee");
  assert.deepEqual(Object.keys(posts[1].body.leads[0]), ["email", "first_name", "last_name", "company_name", "job_title", "custom_variables"]);
  assert.equal(posts[1].body.leads[0].job_title, "VP Sales");
  assert.equal(posts[1].body.leads[0].custom_variables.ff_subject, "the series b");
  assert.deepEqual(marked(calls), [S1.id, S2.id]);
});

test("instantly: a block-listed lead is not marked; the batch is resolved one by one so the duplicate still is", async () => {
  const sigs = [S1, S2, signal({ id: "44444444-4444-4444-8444-444444444444", contact: { first_name: "Bo", last_name: "X", email: "bo@blocked.io", email_verified_at: null, title: "CFO" } })];
  const { fetch, calls } = mockFetch(instantlyMock((e) => ({ "lee@globex.io": "duplicate", "bo@blocked.io": "blocked" })[e] ?? "created"), { signals: sigs });
  const r = await run(["--to", "instantly", "--campaign", "c0ffee"], { INSTANTLY_API_KEY: "in_secret" }, fetch);
  assert.equal(r.code, 2, r.out);
  const posts = calls.filter((c) => c.url.endsWith("/leads/add"));
  assert.deepEqual(posts.map((p) => p.body.leads.length), [3, 1, 1]); // batch, then the two it did not create
  assert.deepEqual(marked(calls), [S1.id, S2.id]);
  assert.match(r.out, /failed bo@blocked\.io: Instantly did not add it \(1 block list\)/);
});

test("instantly: two signals for one email are one lead, and both are marked", async () => {
  const twin = signal({ id: "55555555-5555-4555-8555-555555555555" }); // same contact as S1
  const { fetch, calls } = mockFetch(instantlyMock(() => "created"), { signals: [S1, twin] });
  const r = await run(["--to", "instantly", "--campaign", "c0ffee"], { INSTANTLY_API_KEY: "in_secret" }, fetch);
  assert.equal(r.code, 0, r.out);
  assert.equal(calls.find((c) => c.url.endsWith("/leads/add")).body.leads.length, 1);
  assert.deepEqual(marked(calls).sort(), [S1.id, twin.id].sort());
});

test("instantly: a rejected request fails the batch and marks nothing", async () => {
  const { fetch, calls } = mockFetch(() => json({ message: "Invalid campaign" }, 400));
  const r = await run(["--to", "instantly", "--campaign", "c0ffee"], { INSTANTLY_API_KEY: "in_secret" }, fetch);
  assert.equal(r.code, 1, r.out);
  assert.equal(marked(calls).length, 0);
  assert.match(r.out, /failed lee@globex\.io: .*Invalid campaign/);
  assert.doesNotMatch(r.out, /in_secret/);
});

// ── keys and workspaces ──────────────────────────────────────────────────────────────────────────────────

test("agency key without --workspace stops before reading signals", async () => {
  const { fetch, calls } = mockFetch(undefined, { me: { key_scope: "organization", workspaces: [{ slug: "acme" }, { slug: "globex" }] } });
  const r = await run(["--to", "csv"], {}, fetch);
  assert.equal(r.code, 1);
  assert.match(r.out, /agency key.*--workspace.*acme, globex/);
  assert.ok(!calls.some((c) => c.url.includes("/v1/signals")));
});

test("agency key with --workspace sends the header and the MCP workspace arg", async () => {
  const { fetch, calls } = mockFetch(undefined, { me: { key_scope: "organization", workspace: { slug: "acme", name: "Acme" } } });
  const r = await run(["--to", "csv", "--workspace", "acme"], {}, fetch);
  assert.equal(r.code, 0, r.out);
  const sig = calls.find((c) => c.url.includes("/v1/signals"));
  assert.equal(sig.headers["X-FirstFlag-Workspace"], "acme");
  assert.equal(new URL(sig.url).searchParams.get("status"), "approved");
  assert.equal(calls.find((c) => c.url.endsWith("/mcp")).body.params.arguments.workspace, "acme");
});

test("missing or rejected FirstFlag key gives a clear error", async () => {
  const lines = [];
  assert.equal(await main(["--to", "csv"], {}, { log: (m) => lines.push(m) }), 1);
  assert.match(lines[0], /FIRSTFLAG_API_KEY is not set/);
  const r = await run(["--to", "csv"], {}, async () => json({ error: "invalid_key" }, 401));
  assert.equal(r.code, 1);
  assert.match(r.out, /rejected FIRSTFLAG_API_KEY/);
  assert.doesNotMatch(r.out, /ff_live_secret/);
});

// ── partial failures, skips, secrets, files ──────────────────────────────────────────────────────────────

const many = (n) => Array.from({ length: n }, (_, i) => signal({ id: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`, contact: { first_name: "P", last_name: String(i), email: `p${i}@acme.com`, email_verified_at: "2026-09-30T10:00:00Z", title: "VP" } }));

test("emailbison: a later batch failing still marks the first batch sent (exit 2)", async () => {
  const sigs = many(150);
  let upserts = 0;
  const { fetch, calls } = mockFetch((u, _init, body) => {
    if (u.pathname === "/api/custom-variables") return json({ data: { id: 1 } });
    if (u.pathname === "/api/leads/create-or-update/multiple") {
      upserts++;
      if (body.leads[0].email === "p100@acme.com") return json({ message: "Server Error" }, 500); // every retry too
      return json({ data: body.leads.map((l, i) => ({ id: 1000 + i, email: l.email })) });
    }
    if (u.pathname.endsWith("/attach-leads")) return json({ data: { success: true } });
    return json({}, 404);
  }, { signals: sigs });
  const r = await run(["--to", "emailbison", "--campaign", "77"], { EMAILBISON_BASE_URL: "https://b.test/api", EMAILBISON_API_KEY: "eb_secret" }, fetch);
  assert.equal(r.code, 2, r.out);
  assert.equal(marked(calls).length, 100);
  assert.equal(upserts, 5); // batch 1, then batch 2 tried 4 times
  assert.match(r.out, /Pushed 100 .*50 failed/);
});

test("smartlead: skipped leads are failures and are not marked; already-in-campaign counts as pushed", async () => {
  const { fetch, calls } = mockFetch(() => json({ success: true, added_count: 0, skipped_count: 2, skipped_leads: [
    { email: "dana@acmerobotics.com", reason: "Lead already exists in this campaign" },
    { email: "lee@globex.io", reason: "Email is in the global block list" },
  ] }));
  const r = await run(["--to", "smartlead", "--campaign", "42"], { SMARTLEAD_API_KEY: "sl_secret" }, fetch);
  assert.equal(r.code, 2, r.out);
  assert.deepEqual(marked(calls), [S1.id]);
  assert.match(r.out, /failed lee@globex\.io: Smartlead skipped it: Email is in the global block list/);
});

test("smartleadResult: unattributed skips mark nothing in the batch; success:false fails it", () => {
  const batch = [toLead(S1), toLead(S2)];
  assert.match(smartleadResult({ ok: true, upload_count: 1, already_added_to_campaign: 0, invalid_email_count: 1 }, batch).error, /did not say which/);
  assert.equal(smartleadResult({ ok: true, upload_count: 1, already_added_to_campaign: 1 }, batch).skipped.size, 0);
  assert.match(smartleadResult({ success: false, message: "Campaign not found" }, batch).error, /Campaign not found/);
});

test("a Smartlead key never reaches the output, even from a network error that quotes the URL", async () => {
  const { fetch } = mockFetch((u) => { throw new TypeError(`Failed to parse URL from ${u.href}`); });
  const r = await run(["--to", "smartlead", "--campaign", "42"], { SMARTLEAD_API_KEY: "sl_secret_123" }, fetch);
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /sl_secret_123|ff_live_secret/);
  assert.equal(redactor({})("GET https://x.test/a?api_key=abc123&b=1 Bearer abcdefghijk"), "GET https://x.test/a?api_key=[redacted]&b=1 Bearer [redacted]");
});

test("mark_signal: a rate_limited tool result is waited out, not reported as a failure", async () => {
  let n = 0;
  const base = mockFetch();
  const fetch = async (url, init) => {
    if (String(url).endsWith("/mcp") && n++ === 0) {
      return json({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "rate_limited", message: "Over 120 requests per minute. Retry in 3s." }) }] } });
    }
    return base.fetch(url, init);
  };
  const slept = [];
  const r = await run(["--to", "csv"], {}, fetch, { sleep: async (ms) => { slept.push(ms); } });
  assert.equal(r.code, 0, r.out);
  assert.ok(slept.includes(3000));
  assert.match(r.out, /Marked 2 signals sent/);
});

test("csv: never overwrites; the default name gets a suffix and an existing --out is refused", async () => {
  const exists = (p) => /firstflag-signals-2026-10-05\.csv$/.test(p);
  const r = await run(["--to", "csv"], {}, mockFetch().fetch, { exists });
  assert.equal(r.code, 0, r.out);
  assert.match(Object.keys(r.files)[0], /firstflag-signals-2026-10-05-2\.csv$/);
  const r2 = await run(["--to", "csv", "--out", "firstflag-signals-2026-10-05.csv"], {}, mockFetch().fetch, { exists });
  assert.equal(r2.code, 1);
  assert.match(r2.out, /already exists/);
});
