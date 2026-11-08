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

Versions below were checked on **2026-11-03** (`fetch('https://registry.npmjs.org/<pkg>/latest')`). **This table is history, not current state** — these packages keep shipping, so check npm / GitHub for today's facts:

| Plugin | Version | Its approach | Relationship |
|---|---|---|---|
| [`dsh-auto-review`](https://www.npmjs.com/package/dsh-auto-review) | 0.15.0 | second-model pre-check at the head of the chain; **fail-closed** when the reviewer is unavailable (rejects outright, no human) | the AI layer (L3) borrows its tiering, per-turn budget and breaker; **the veto is removed**, and the "PTC arguments folded → blind deny" bug is fixed |
| [`dsh-perm-gate`](https://www.npmjs.com/package/dsh-perm-gate) | 5.4.4 | deterministic ladder P0 hard-deny → P1 session grants → P2 static rules → P3 optional LLM → P4 human | borrows "deterministic first": this plugin's L0/L1 is that layer, with no model in the path |
| [`moon09300731/dsh-approval-gate`](https://github.com/moon09300731/dsh-approval-gate) | 0.5.2 (unmaintained since 2026-08) | Flash classifies SAFE/RISKY, five hard-risk classes never learn; green bar + timeline + diff/undo | the main product-shape reference (learning loop, hint above the composer, diff/undo); but it is an **intercepting gate** — it *is* the whole chain — while this plugin is layered and never blocks |
| [`dsh-approval-gate-safe`](https://www.npmjs.com/package/dsh-approval-gate-safe) | 0.2.4 | a compatibility-hardened fork of the above, with wider Windows/PowerShell vocabularies | reference for command vocabularies |
| [`@goodandready/dsh-approval-gate`](https://www.npmjs.com/package/@goodandready/dsh-approval-gate) | 0.1.31 | pure rules: block what it recognises, hand the rest to the human | same discipline as this plugin's L0: "if you cannot tell, hand it over" |
| [`dsh-approval-ledger`](https://www.npmjs.com/package/dsh-approval-ledger) | 1.2.2 | batch approvals + risk gate + exportable ledger | reference for ledger export |
| [`dsh-approval-hotkeys`](https://www.npmjs.com/package/dsh-approval-hotkeys) | 0.2.0 | Enter approves / Esc cancels | not adopted: the native prompt is not ours |
| [`@aiwayds/dsh-approval-policy`](https://www.npmjs.com/package/@aiwayds/dsh-approval-policy) | 0.2.1 | bounded answers for subagents / cron requests | same idea as "tier by requester"; subagents, schedules and the task board are stricter by default here |
| [`dsh-approval-toast`](https://www.npmjs.com/package/dsh-approval-toast) | 1.0.3 | approve straight from a Windows toast | complementary (delivery), but it can answer too — verify it does not race |

Every package name above links to its npm page; `moon09300731/dsh-approval-gate` points at the GitHub repository (it was never published to npm). The per-plugin breakdown (mechanism, what was borrowed, versions, download counts) is in [RESEARCH.md](RESEARCH.md) §4, together with its collection date.

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

- **Who can read this data**: the HTTP surface (`/api/review-hub/*`) binds to the host's loopback port and checks that `Host` is a loopback address and that `Origin`/`Referer` match it (the desktop shell's `dsh-app:` protocol is allowed on its own). **There is no additional token**, and **no "must come from a browser" check** — measured on the real desktop shell, its requests carry neither `Origin` nor `Sec-Fetch-Site`, and gating on those turned the whole panel into 403s (verified 2026-11-09). So any local process that can reach that port can read and rewrite the ledger and the settings; the random port per start (`--port 0`) is the only real barrier today. Setting `strictOrigin: true` in the plugin config tightens it — but only if your host actually sends `Sec-Fetch-*` (off by default).
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
- The client half is a single ~1700-line bundle (no build step).
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
| [docs/FEEDBACK.md](docs/FEEDBACK.md) | Post-mortem of a real bug (fingerprints split by paging knobs) |
| [RESEARCH.md](RESEARCH.md) / [docs/PLAN.md](docs/PLAN.md) | Research notes and the implementation plan |
