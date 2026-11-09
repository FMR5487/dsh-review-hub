# dsh-review-hub · MingJing (明镜)

<img src="assets/icon.svg" width="72" align="right" alt="MingJing">

**An approval brain for DSH: the safe things pass by themselves, the rest reaches you, and everything stays auditable and undoable.**

> The AI advises from the lamp; the mirror only makes every approval legible.

[中文](README.md) · English ｜ 🤖 **An AI? Read [README-AI.md](README-AI.md) first; before you change code, read [AGENT.md](AGENT.md).**

---

## What it is

When a DSH tool needs an escalation, the harness stops and asks: `approval/request` is a waterfall, and nobody answering at the end of the chain counts as a denial. This plugin registers as the **single answerer** and does three things at that moment:

1. **Hard risk goes straight to you** — deleting, discarding work (`git reset --hard` and friends), touching credentials, remote execution, system changes, mass destruction. No model, no learning.
2. **Repetition is learned** — approve the same harmless command by hand three times and it passes on its own afterwards (per session: a new session starts over).
3. **Everything else gets an AI pre-check** — one small call (≈300–500 tokens) with exactly two possible answers: `allow` (pass) or `ask` (not sure, hand it to you). **The reviewer has no veto.**

Because there is exactly one answerer, "who let this through" is a recorded fact, not a guess: `ai` / `memory` / `human` / `external` / `fallback`.

> **The AI pre-check covers the ops plugin's commands by default**: everything [dsh-ops](https://github.com/T-Auto/dsh-ops) publishes — `ops_bash`, the read-only `ops_read_files` / `ops_grep` / `ops_glob` / `ops_inspect_local_file` / `ops_status`, and its job tools `job_output` / `job_list` — is already in the built-in AI list. No extra configuration: install and it reviews them. Other tools go their own way (`write` / `edit` are memory-tier, `plugin_manager` asks you directly); add or remove any of them under *Advanced → extra tools to send to the AI / deny list*.

---

## The decision chain

One `approval/request` walks a **fixed order**. Whichever layer answers first owns the decision; the layers below it never run.

```
1. L0 hard risk (deterministic, free)
     hit  -> straight to you; no model, no memory, never auto-passed
     miss -> next
2. Memory (deterministic)
     this operation approved by hand enough times in this session (default 3) -> pass
     miss -> next
3. File level (deterministic, must be switched on)
     this file approved by hand >= threshold -> pass
     miss -> next
4. AI pre-check (one small call, ~300-500 tokens)
     allow -> pass (decidedBy = ai)
     ask   -> you; the reviewer has no veto, it may only pass or ask
              next
5. Human
```

The order is not arbitrary: **determinism before probability**. Whatever a rule can settle (hard risk, memory, file level) never reaches a model; the model only sees what is left — harmless requests it has not seen before.

Every row records which layer decided: `ai` / `memory` / `human` / `external` / `fallback`, plus `agentKind` (requester), `tier` (ceiling) and `aiSource` (whether the reviewer really looked). Those three columns answer "why did the AI never see this one?"; requests the reviewer sent back are marked **AI escalated · human approved/rejected**, with the reviewing model named left of the timestamp.

---

## What you see

- **Above the input box**, one tinted card: AI passed (pale green) / memory passed (pale blue) / awaiting approval (pale amber). Copy and close icon buttons on the right. When nothing is happening the row does not render at all.
- **Other sessions** never tint your conversation: they produce one grey dashed aggregate card, `session · AI passed 0 · memory passed 1`, closable by hand only.
- **The "Approval" tab** in the conversation header: the full timeline (tool, who decided, reason, args, latency, memory progress), a magnifier search, a 🔴 badge when new non-human approvals arrive, and a `— new approvals above —` divider between what you have seen and what is new.
- **The "Change" tab in the right sidebar**: the diff of that one call (dual line numbers) with two-click undo (it gives up after 3 seconds).
- **When a decision is needed**, both the card and the system notification say what the reviewer thought: `AI suggests a human · high · reason says "read a file" but the command deletes a directory`.
- **Ledger export**: CSV / JSON, per session or everything.

---

## Relationship to similar plugins

The DSH approval ecosystem already has quite a few plugins with different ideas. This one collects the ideas that **can coexist** into a single implementation: a deterministic hard-risk layer that needs no model, an AI pre-check that can only pass or defer, a per-session learning layer, and the full panel / diff / undo surface.

If you only remember four differences, these are the four (everything else is implementation detail):

1. **The AI can only `allow` or `ask` — it cannot deny.** A `deny` is downgraded to "hand it to the human". Most peers let the model reject outright (fail-closed), so one bad judgement becomes a refused command.
2. **Memory counts human approvals only.** Passes made by the AI or by memory itself never advance the counter, so every bit of evidence behind "learned, now silent" came from you.
3. **The model only sees a redacted summary** — compressed arguments with paths and commands trimmed, not the original text; secret-like paths are not sent at all.
4. **There is a real approval UI** — timeline, diff, undo, CSV/JSON ledger export, instead of a toast that disappears.

Versions below were checked on **2026-11-03 / 09** (`fetch('https://registry.npmjs.org/<pkg>/latest')`). **This table is history, not current state** — these packages keep shipping, so check npm / GitHub for today's facts:

| Plugin | Version | Its approach | Relationship |
|---|---|---|---|
| [`@deepseek-ai/dsh-experimental-auto-review`](https://www.npmjs.com/package/@deepseek-ai/dsh-experimental-auto-review) | 0.1.6-alpha.1 | the official experimental baseline shipped with the host: reviews every call with the session model, no deterministic risk list, risk/reason not persisted | the baseline this plugin is measured against: the deterministic layer (free, predictable), memory and the audit UI are what it lacks |
| [`dsh-auto-approve`](https://www.npmjs.com/package/dsh-auto-approve) | 0.7.1 | keeps the sandbox and only narrows escalations; deterministic risk list runs before the classifier; per-session memory keyed on tool + raw args hash (30-minute TTL, in-memory only); falls back to the human when classification fails | **the closest thing to this plugin.** Differences: memory here persists, uses a threshold and counts human approvals only; risk-list hits never enter memory (both projects agree on that one) |
| [`dsh-plugin-auto-review`](https://www.npmjs.com/package/dsh-plugin-auto-review) | 0.1.0 | ports the Codex Guardian / Grok escalation review prompts; the model may deny, and auto-denies when nobody is watching | a counter-example: a model that can deny is exactly this project's red line (the human stays in the loop) |
| [`dsh-auto-review`](https://www.npmjs.com/package/dsh-auto-review) | 0.15.0 | second-model pre-check at the head of the chain; **fail-closed** when the reviewer is unavailable (rejects outright, no human) | the AI layer (L3) borrows its tiering, per-turn budget and breaker; **the veto is removed**, and the "PTC arguments folded → blind deny" bug is fixed |
| [`dsh-perm-gate`](https://www.npmjs.com/package/dsh-perm-gate) | 5.4.4 | deterministic ladder P0 hard-deny → P1 session grants → P2 static rules → P3 optional LLM → P4 human | borrows "deterministic first": this plugin's L0/L1 is that layer, with no model in the path |
| [`moon09300731/dsh-approval-gate`](https://github.com/moon09300731/dsh-approval-gate) | 0.5.2 (unmaintained since 2026-08) | Flash classifies SAFE/RISKY, five hard-risk classes never learn; green bar + timeline + diff/undo | the main product-shape reference (learning loop, hint above the composer, diff/undo); but it is an **intercepting gate** — it *is* the whole chain — while this plugin is layered and never blocks |
| [`dsh-approval-gate-safe`](https://www.npmjs.com/package/dsh-approval-gate-safe) | 0.2.4 | a compatibility-hardened fork of the above, with wider Windows/PowerShell vocabularies | reference for command vocabularies |
| [`@goodandready/dsh-approval-gate`](https://www.npmjs.com/package/@goodandready/dsh-approval-gate) | 0.1.31 | pure rules: block what it recognises, hand the rest to the human | same discipline as this plugin's L0: "if you cannot tell, hand it over" |
| [`dsh-approval-ledger`](https://www.npmjs.com/package/dsh-approval-ledger) | 1.2.2 | batch approvals + risk gate + exportable ledger | reference for ledger export |
| [`dsh-approval-hotkeys`](https://www.npmjs.com/package/dsh-approval-hotkeys) | 0.2.0 | Enter approves / Esc cancels | not adopted: the native prompt is not ours |
| [`@aiwayds/dsh-approval-policy`](https://www.npmjs.com/package/@aiwayds/dsh-approval-policy) | 0.2.1 | bounded answers for subagents / cron requests | same idea as "tier by requester"; subagents, schedules and the task board are stricter by default here |
| [`dsh-approval-toast`](https://www.npmjs.com/package/dsh-approval-toast) | 1.0.3 | approve straight from a Windows toast | complementary (delivery), but it can answer too — verify it does not race |

Every package name above links to its npm page; `moon09300731/dsh-approval-gate` points at the GitHub repository (it was never published to npm).

### How it differs from `dsh-auto-approve`, item by item

That plugin is a **permission preset**: it adds a `sandboxed-auto` level, only sessions that select it are affected, and every other request passes through untouched. MingJing is an **answerer on the approval chain**: it changes no preset, and any tier that reaches an approval goes through the same chain. That positioning difference drives every row below.

The left column was checked against its **0.7.1** npm package and README (2026-11-09); the right column is this repository's code.

| Dimension | `dsh-auto-approve` 0.7.1 | MingJing |
|---|---|---|
| How it hooks in | adds a fifth permission preset; acts only when the preset matches | an answerer on the `approval/request` waterfall; applies to every preset |
| What it reviews | only sandbox escalations (the author estimates ~2% of calls) | every request that reaches approval, routed by `tier` (AI / memory / human) |
| AI veto | **yes**: a risk-list hit or an unsure classifier goes to the human, but the "never" tier can hard-refuse | **no**: a `deny` is downgraded to `ask` (`review.js`) |
| Failure semantics | falls back to the human when classification fails | same direction: any failure (no llm / breaker / over budget / timeout / unparsable) becomes `ask` |
| Deterministic risk list | yes, runs before the classifier | yes, runs before memory and the AI (L0: delete / discard work / credentials / remote exec / system-level / bulk destruction) |
| Memory | tool + raw args byte-level hash, **in-process with a 30-minute TTL**, lost on restart, no UI | **persisted on disk with a threshold** (3 human approvals by default), per session, knob-normalised (`limit` / `offset` / `description` excluded from the fingerprint), visible in the memory tab — delete per row, arm auto-pass per file |
| What counts as evidence | classifier approvals count too | **human approvals only** — AI or memory passes never advance the counter, so the learning cannot reinforce itself |
| What the model sees | command + justification + sandbox target + workspace + **the full user message** (up to 2000 chars; longer goes straight to the human) | **a redacted summary only** (≤240 chars; `sk-` / `Bearer` / secret-looking keys are redacted; secret-like paths get no summary at all) |
| Audit | host-native approval events plus an in-process report (lost on restart; the author says it is not an audit ledger) | an own ledger (`decidedBy` / `agentKind` / `tier` / `aiSource` / frozen `threshold`) plus approval, memory and stats tabs, and CSV/JSON export that survives restarts |
| UI | none (its README says so) | four sidebar tabs, a hint card above the composer, a floating AI-advice card, diff and undo |
| Model cost | one classifier call per escalation | one call per AI-tier request, plus a 60-second window budget, a breaker and a persisted verdict cache (a replay inside the TTL is free) |
| Known exposure | its README admits the default prompt approves writes to `~/.dsh/profiles/` — a runtime self-modification path left open until you close it | none of that shape: secret-like paths hit the L0 wall, and the write-ahead snapshot stores no body for them |
| Size | 11 files / ~180 KB | 12 server modules plus a single-file client, 96 tests |

**The two can coexist** (it narrows escalations, MingJing owns the whole approval chain), so this is not an either/or. If you do have to choose, look at three things: ① **who holds the veto** — its AI can refuse, MingJing's AI can only say "pass" or "yours"; ② **whether the learning is auditable** — a 30-minute in-memory hash versus a persisted, human-only, row-by-row list you can inspect and delete; ③ **the data boundary** — it sends your full message text to a model, MingJing sends a redacted summary.
The per-plugin breakdown (mechanism, what was borrowed, versions, download counts) is in [RESEARCH.md](RESEARCH.md) §4, together with its collection date.

> ⚠️ A conflict only exists between plugins that **also answer `approval/request`**: two answerers mean decisions get recorded as `external` and may be answered before you see them. Remove those from the profile, and verify `/health` `counters.external` stays 0.

---

## Install

Into a profile (`~/.dsh/profiles/desktop`), not via `npm install`:

1. add `"dsh-review-hub": "link:<this repo>"` to `dependencies`;
2. add `dsh-review-hub` to the `bundles` array and remove any other plugin that **also answers `approval/request`** (see the section above; notification-only plugins can stay, but verify they do not race);
3. run the pnpm bundled with DSH: `install --lockfile-only` (**never** a full install — it wipes native builds);
4. create a junction `node_modules/dsh-review-hub` → this repo;
5. **check `cordis.patch.yml`**: any leftover patch row with `name:` re-mounts a plugin even after its bundle row is deleted;
6. restart the host (the server half binds at load; the client half only needs a page reload).

Details and pitfalls: [README-AI.md](README-AI.md) and [docs/PLAN.md](docs/PLAN.md).

---

## Where the settings are

- **Everyday settings** → "Settings" inside the **Approval** tab: AI review, reviewer model, memory auto-pass, threshold, hint cards, three card lifetimes, system notifications. Switches are host-style sliders, each row carries one plain-language line.
- **Advanced (do not fiddle)** → the plugin card on the Plugins page: fallback poll interval, rows kept per session, review timeout, per-turn budget, breaker threshold, per-requester tiers, **extra tools to send to the AI** (deltas only; the baseline is hardcoded) and a **deny list** (it wins, and can override the baseline; `write`/`edit` are memory-tier and neither list can move them), **card preview** (always on: five card kinds, this session live, plus two buttons to try the floating cards), and **enable "clear history"** (off by default; even when on the button still needs three clicks and the server re-checks the flag).

---

## FAQ

**Why did the AI never show up?**
Hard risk (6 classes) never reaches it; or there is no model service, the call timed out, or the breaker is open. The row records `aiSource`.

**Can the AI wave a dangerous action through?**
**Yes — but it depends on how capable the model on that lane is and on whether you trust it, and that is the one real risk of this design.** When the reviewer answers `allow`, that approval is not shown to you at all, so the answer comes down to two things: whether the model on that lane can actually read that command, and whether you are willing to hand over part of that judgment.

What can be bounded, is bounded: ① the six hard-risk classes (deletion, discarding work, credentials, remote execution, system changes, mass destruction) never reach the model — they come straight to you; ② the reviewer only sees a redacted argument summary plus the stated reason, and its rule is "reversible, scoped, consistent with the reason" — anything else must be `ask`; ③ you can switch AI review off entirely, blacklist tools in the advanced settings, or tighten the per-requester tier. What is left — the model's own judgment — is something this design cannot guarantee for you; the timeline exists so you can audit the borderline cases afterwards.

**Why has it not learned after several approvals?**
Only **human** approvals count (AI and memory passes deliberately do not, or the rule would reinforce itself), and hard-risk actions never count. Progress shows as "memory n/3".

**Which lane does the reviewer use, and what does it cost?**
It follows the session's own model by default; you can pin a cheap lane in settings. It sees a redacted argument summary (≤240 chars) plus the stated reason: ≈300–500 tokens per decision, cached on disk so a host restart does not pay again.

**Which model should I use?**
Good enough is enough: expensive is not the same as good, but the smaller the model, the easier it gets things wrong.

**Multiple windows?**
Fine, but each window tracks its own seen/baseline watermark, so the badge can differ between them.

---

## Security boundaries

What this does and does not protect against, stated plainly.

- **Who can read this data**: the HTTP surface (`/api/review-hub/*`) binds to the host's loopback port and checks that `Host` is a loopback address and that `Origin`/`Referer` match it (the desktop shell's `dsh-app:` protocol is allowed on its own). **There is no additional token**, and **no "must come from a browser" check** — measured on the real desktop shell, its requests carry neither `Origin` nor `Sec-Fetch-Site`, and gating on those turned the whole panel into 403s (verified 2026-11-09). So any local process that can reach that port can read and rewrite the ledger and the settings; the random port per start (`--port 0`) is the only real barrier today. There are two ready-made ways to tighten it, both in the plugin config (not the panel settings):

- `strictOrigin: true` — requires `Sec-Fetch-Site`. Off by default, because the desktop shell does not send it and the panel would 403 across the board.
- `writeProofCookie: "<cookie name>"` or `writeProofHeader: "<header name>"` — fences **write methods only** (`POST`); reads and SSE are untouched. Empty (the default) means off. Do not guess the value: turn on `debugHeaders: true` first, which records each request's header names and cookie names into `~/.dsh/storages/review-hub/http-probe.log` (names only, never values, 400-line cap), compare the panel against `curl`, and use the signal only the panel carries.
- **What lands on disk**: `~/.dsh/storages/review-hub/` holds the ledger (tool, arguments, reason, who decided), the memory table, the settings, the AI verdict cache, and `snapshots/` — which stores the **full pre-edit content** of every `write`/`edit` target (256KB per file, 64 per session). In other words: **the files you approved edits for are kept in plaintext on this machine**, including any `.env` you edited.
- **How to remove it**: delete the whole `~/.dsh/storages/review-hub/` directory (it is recreated on the next start). The "clear history" button in the panel clears the ledger and memory — it **does not touch `snapshots/`**.
- **What the AI sees**: only the redacted argument summary (≤240 chars) plus the stated reason, never full file contents. Verdicts are cached on disk so a restart does not pay twice.
- **The AI has no veto**: it may only answer `allow` or `ask`; a `deny` is downgraded to `ask`. That is a hard rule — see [README-AI.md](README-AI.md).

---

## Performance

Idle costs **zero requests** (one local SSE connection, a heartbeat every 30s). Each approval is one frame (measured ≈630 bytes per row; ~0.5 approvals/hour on this machine). If the stream dies the client falls back to 3-second polling; when the window is hidden the stream is closed, so no renderer wakeups.

---

## Known limitations

- Tightly coupled to DSH internals (seat names, the right-sidebar API, `--dsh-composer-*` CSS variables); a major host bump may need work.
- The client half is a single ~4100-line bundle (no build step).
- The approval tab is per session; there is no "all sessions" view.
- Undo is an instruction delivered to the session, so it needs a live agent there.
- Write-ahead snapshots are capped (256 KB per file, 64 per session); beyond that only metadata is kept.

---

## Documentation

| File | For |
|---|---|
| [README.md](README.md) | Chinese readers (humans) |
| [README-AI.md](README-AI.md) | **AI agents**: red lines, structure, data formats, SSE protocol, failure modes |
| [AGENT.md](AGENT.md) | Humans or AIs who want to modify it: recipes for settings, policies, seats, tests |
| [CHANGELOG.md](CHANGELOG.md) | Version history |
| [UX.md](UX.md) | UI decision log: why each screen looks the way it does, **including the options that were rejected** and why |
| [docs/FEEDBACK.md](docs/FEEDBACK.md) | Post-mortems and work tickets (§1–§9: fingerprints split by paging knobs; §10 on: the second batch) |
| [RESEARCH.md](RESEARCH.md) / [docs/PLAN.md](docs/PLAN.md) | Research notes and the implementation plan |
