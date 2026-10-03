# firstflag-agent

**Signal-based outbound for every client you run. One slash command, one API key.**

```
/signal-based <client-domain>
```

Type a client's domain into Claude Code. You get the companies showing buying signals this week, the right person at each, a verified email and a first email that only says what is true. Approve. Push to your sequencer.

<!-- TODO: record docs/demo.gif and embed it here: ![demo](docs/demo.gif) -->

```
> /signal-based ledgerline.io

Working Ledgerline (ledgerline). Agency plan, 412 of 500 signals left this month.

Plays
 1. Funding rounds · ON · new budget for finance tooling · 31 in market now
 2. Hiring & surges · ON · finance team build-outs signal manual close pain · 54 in market now
 3. Job changes · ON · new CFOs replace tools in their first 90 days · 12 in market now
 4. SEC filings · OFF · S-1 filers need audit-ready books · 3 in market now
 5. Competitor engagement · OFF · people engaging with competitor posts (needs a list)
Reply with changes (e.g. 'on 4') or 'go'.

> on 4, go

| # | Account        | Signal        | Why now                                   | Person                        | Email | Stacked           |
|---|----------------|---------------|-------------------------------------------|-------------------------------|-------|-------------------|
| 1 | Quarrytide     | Funding       | Raised $22M Series B on Sep 29            | Maya Okafor, VP Finance       | ✓     | funding + hiring  |
| 2 | Brightloom     | Job changes   | New CFO started in September              | Sam Ilves, CFO                | ✓     |                   |
| 3 | Tallyforge     | Hiring        | 9 finance roles posted this week, 3x pace | Ren Duarte, Controller        | ✓     | hiring + filings  |
| 4 | Northcask      | SEC filings   | Filed an S-1 on Sep 30                    | Priya Nair, CAO               | ?     |                   |
...

14 signals, 12 with a verified email.
Strongest: Quarrytide. Fresh Series B plus 6 finance hires in 2 weeks.
Stacked: Quarrytide, Tallyforge.

Offer, CTA and voice in one line? Or 'default'.

> we close the books in 3 days not 12 · CTA: worth comparing notes? · blunt, peer, under 70 words

1. Maya Okafor, VP Finance @ Quarrytide (Funding rounds)
Subject: after the series b
Maya, congrats on the $22M Series B. Six finance hires in two weeks usually means
the close is about to get harder before it gets easier...
Grounded in: Raised $22M Series B on Sep 29 · https://news.example.com/quarrytide-b

Use this style for all 14? That's 14 drafts.

> yes. approve all but 4

Approved 13. Push to EmailBison, Smartlead, Instantly, or CSV? Campaign id?

> emailbison 2214

DRY RUN: would push 13 leads to emailbison campaign 2214, then mark them sent in FirstFlag.
> push it

Pushed 13 to emailbison campaign 2214. Marked 13 signals sent in FirstFlag.
Run /signal-based every Monday for every client's new signals.
```

## What you get for every signal

1. **The company and what changed.** A raise, a hiring surge, a new leader, an acquisition, a relaunch.
2. **Why now, with the source.** The facts and the link, so you can check it in ten seconds.
3. **The person who owns the problem.** Matched to the client's buyer personas, on the right company.
4. **A verified email.** Checked before you see it. Catch-alls are labelled.
5. **The whole first email.** Subject and body, in the client's offer and voice, fact-checked against the signal.

One workspace per client, watched every day. Signals are marked sent at the source, so nobody gets emailed twice.

## Install in 60 seconds

In Claude Code:

```
/plugin marketplace add troy-aitken/firstflag-agent
/plugin install firstflag-agent@firstflag
```

Get a key at [firstflag.io/settings/connect](https://firstflag.io/settings/connect), then set it in your shell and restart Claude Code:

```bash
export FIRSTFLAG_API_KEY=ff_live_...          # macOS / Linux
setx FIRSTFLAG_API_KEY ff_live_...            # Windows (new terminal after)
```

Then `/signal-based yourclient.com` (or `/firstflag-agent:signal-based` if another plugin already uses that name). Never paste a key into the chat. The command will refuse it.

## How it works

1. **Detect.** FirstFlag reads the client's site, works out who they sell to, and switches on the plays that fit. It watches the market every day and backfills the last 30 days on day one.
2. **Find the person.** Each signal comes with the right contact at the account, matched to the client's buyer personas, with an email that has been verified.
3. **Write.** You give the offer, CTA and voice in one line. FirstFlag drafts the first email in that voice and rejects any draft that states a fact the signal does not support. No invented numbers, no made-up news.
4. **Approve.** You see the drafts as a table, approve what is good, skip what is not. Nothing moves without you.
5. **Push.** `push.mjs` sends approved leads to EmailBison, Smartlead or Instantly with the subject, body and why-now as custom variables, or writes a CSV. Each pushed signal is marked sent so it never goes out twice.

## Plays

| Play | Fires when |
|---|---|
| Funding rounds | An account raises money |
| Hiring & surges | An account posts the roles you care about, or posts far more than usual |
| Job changes | A buyer starts a new job, or a champion lands somewhere new |
| Acquisitions | An account buys or is bought |
| SEC filings | An account files something that changes its priorities |
| Champion movement | Someone who used the client's product moves to a new company |
| Website changes | A watched account changes pricing, product or careers pages |
| Newsroom & press | A watched account publishes news |
| Press mentions | An account is in the press for something relevant |
| Social listening | A watched person posts about the problem the client solves |
| Patents & trademarks | An account files in the client's space |
| Ad activity | An account starts or changes paid ads |
| Competitor engagement | People engage with a competitor's posts |

Stacked accounts, two or more kinds of signal at one company in 45 days, are ranked first.

## Pricing, honestly

- **Free key.** Your own Weekly Five: the 5 best finished signals every week, for your own workspace. Good for trying the whole loop on yourself.
- **Solo, $149/mo.** 100 signals a month, one workspace.
- **Agency, $399/mo.** 500 signals pooled across 5 client workspaces. +$49 per extra client.
- **Scale, $899/mo.** For agencies past that.

Client workspaces are Agency and up. On a free or Solo key, `/signal-based otherclient.com` tells you so and offers to run on your own workspace instead.

**Guarantee.** If a signal is wrong (wrong fact, wrong person, they left, or the email bounced), say "that one's wrong". You get the credit back plus 1 bonus signal.

## FAQ

**Is this a CRM?** No. FirstFlag finds the signal, the person, the email and the whole first email. Your sequencer sends. Your CRM tracks the deal.

**Which sequencers?** EmailBison (your own instance), Smartlead and Instantly out of the box. Anything else takes the CSV. Each lead carries `ff_subject`, `ff_body`, `ff_opener`, `ff_signal`, `ff_why_now` and `ff_source_url`, so step 1 of the campaign is just `{{ff_subject}}` and `{{ff_body}}`.

**Where's my data?** Signals live in your FirstFlag account. The plugin talks to FirstFlag's MCP server. `push.mjs` runs on your machine and talks only to FirstFlag and your sequencer, with keys from your environment. No other server is involved, and no key is ever printed.

**Does it send email?** No. It puts leads into your campaign. Whether that campaign is running is your call.

**Can I use it outside Claude Code?** Yes. FirstFlag's MCP server works in any MCP client (`https://api.firstflag.io/mcp`), and the REST API is at `https://api.firstflag.io/v1`. This repo is the Claude Code version.

## What's in the repo

```
.claude-plugin/marketplace.json     the marketplace entry
plugin/.claude-plugin/plugin.json   the plugin manifest
plugin/.mcp.json                    FirstFlag's MCP server, authed with FIRSTFLAG_API_KEY
plugin/commands/signal-based.md     the product: one prompt, read it in 3 minutes
plugin/scripts/push.mjs             approved signals -> your sequencer. Zero dependencies, Node 18+
plugin/scripts/push.test.mjs        node --test plugin/scripts/push.test.mjs
```

Pushing by hand:

```bash
node plugin/scripts/push.mjs --to emailbison --campaign 2214 --dry-run
node plugin/scripts/push.mjs --to smartlead --campaign 98765
node plugin/scripts/push.mjs --to instantly --campaign <campaign-uuid>
node plugin/scripts/push.mjs --to csv
```

Agency keys add `--workspace <client-slug>`. `--to csv` writes `firstflag-signals-<date>.csv` in the current directory and never overwrites a file; it holds contact data, so keep it out of git. Only leads the sequencer actually accepted are marked sent: a lead it skips (block list, unsubscribed, invalid) stays approved, and the run exits 2. See [.env.example](.env.example) for the sequencer variables.

MIT licensed. Built by [FirstFlag](https://firstflag.io).
