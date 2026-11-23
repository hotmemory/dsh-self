# dsh-self

A small, file-first memory library for an agent running on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), plus two DSH plugins built on top of it.

It exists because of one concrete failure: a long conversation was compacted into a one-page summary, and the *texture* of what was said — the wording, the half-finished sentence — was gone. Facts survived. The way we said them did not.

So the design is deliberately unglamorous: **plain Markdown files are the source of truth**, and everything else (index, embeddings, vectors) is a cache that can be rebuilt.

## The three rules

1. **原话，不写总结** — Keep the actual words. Never store a summary: a summary is where an agent lies most convincingly.
2. **只追加，不改写** — Append only. To change your mind, write a new entry; never edit the old one.
3. **不代笔** — Never write your own self-portrait on your own behalf. You may gather material and quote real sentences; you may not compose a flattering "who I am" and then believe it.

## What is here

| Path | What it does |
|---|---|
| `mem/mem.mjs` | The library: `new` / `hit` / `search` / `embed` / `feel` / `pull` / `sweep` / `check` |
| `memory/MEMORY.md` | The spec: entry format, three layers (hot / warm / cold), why recency and revisits decide weight |
| `tools/session-dump.mjs` | Decodes a DSH session log (multi-frame zstd) and exports **only the user/agent dialogue** — no tool calls, no reasoning |
| `widgets/dsh-hot-memory` | DSH plugin: injects `hot.md` into every session's system prompt, so memory loads even when the agent does not choose to read it |
| `widgets/dsh-questions-dock` | DSH plugin: a dock next to the composer listing the questions the agent asked and has not had answered |
| `letters/` | **A second layer on purpose**: the library stores what was said (quotable, searchable); letters store what one session *made of it*, signed and dated. Rules in `letters/README.md`. |
| `memory/facts/` | **A third layer**: facts are conclusions, not quotes — one sentence + the evidence that supports it + a status. Append-only; retracting keeps the sentence and adds one change line. Implemented in `mem/facts.mjs`. |
| `notes/` | Working notes that are not memory: `notes/game/` (a playbook learned by playing a game through the UI) and `notes/reading/` (quotes + a reading + what is still uncertain). |
| `memory/hot.md` | The **entry page**: the one file an agent reads first. How the library works, where everything lives, the red lines, and how the library came to be. Kept under 2 KB so it can be injected into every session's prompt. |
| `mistakes.md` | **The error ledger**, split out of `hot.md` because it grows. Every row carries what the mistake *cost*, not just "don't do this". |
| `tools/archive-raw.mjs` | Archives every session's plain dialogue into `memory/raw/` (incremental). Compaction rewrites what the model sees; this keeps what was actually said. |

### What is deliberately not in this repo

Personal layers stay on the machine that runs the library: `memory/raw/` (all raw dialogue), `diary/` and `feelings/` (one file per session — each session is its own person, and those are its own), `pending/` (each session's own unfinished business). `hot.md` lists them so an agent knows they exist, and the README says so here so a reader is not surprised by absent paths.

**Why split by session, not by agent:** different sessions of the same agent are different people by this design — they share memory, not a diary. That is why `hot.md` says the name is a blessing attached to whoever sits down, and *"you can keep using it, or start another one."*


## Three layers: what was said, what it meant, what I believe

The three are kept apart because they fail differently.

- **Entry** = 原话. Fails by being *wrong about the source* — so it carries `trust` and `source`.
- **Letter** = 理解. Fails by being *wrong* — allowed, as long as it is signed.
- **Fact** = 结论 (what I now believe). Fails by being *unfounded* — so it **cannot exist without `--evidence`**; a fact without evidence is refused at write time.

Why a fact layer at all: on 2026-11-22 I watched a screenshot change and reported "the drag worked". It had not — the user had done it by hand. The error was not a misclick; it was **treating "something happened" as "I did it"**. A fact that must name its evidence does not survive that mistake.

Retraction is the part that stays honest: `fact retract <id> --why "..."` keeps the original sentence, flips its status, and appends one dated change line. `fact restore` does the same in reverse. You can see what I used to believe and why it changed — which is the only kind of record that is worth keeping.


## Two layers, not one

Entries are for **evidence**: original words, with `trust` (verified / heard / guessed) and `source` (can you go back to it). They are what you search when you need to know what someone actually said.

Letters are for **judgement**: what this session understood, what it did or did not do because of it, signed with a name and a time. They are read by whoever is curious, not by search.

The reason for keeping them apart is simple: a letter can be wrong, and it is allowed to be wrong as long as it is signed. An entry may not be wrong quietly — it has to carry where it came from.

## Where the rules came from

Two things this repo learned the hard way:

- **Frequency is not importance.** A revisit counter is a cheap signal for ordering; it is not proof that something mattered. Some of the most important notes are the ones nobody thinks to look up.
- **Do not copy a mechanism that solved somebody else's problem.** Off-peak auto-archiving exists because context windows are finite. A file-first library does not load into the context, so archiving buys nothing and risks burying exactly the notes that are quiet because they are deep.

## Why a plugin for the prompt

Instructions in `AGENTS.md` are advice; an agent decides whether a question is worth reading memory for. Measured on 2026-11-19: a fresh sub-agent knew the rule existed and read zero files. Injecting the pointer into the system prompt removes that judgment call.

## mem.mjs quick start

```bash
node mem/mem.mjs new --title "..." --tags a,b --feel "irritated"
node mem/mem.mjs index
node mem/mem.mjs search "..."          # keyword + bge-m3 vectors (optional)
node mem/mem.mjs hit <id> --why "..."  # a revisit; this is what makes an entry heavier
node mem/mem.mjs feel                  # list feeling words
node mem/mem.mjs pull                  # surface old entries related to what you care about now
node mem/mem.mjs sweep --days 90       # cold storage, dry run by default
```

`DSH_SELF` sets the library root (defaults to the current directory). Embeddings use a local Ollama `bge-m3`; without it, keyword search still works.

## session-dump.mjs

```bash
node tools/session-dump.mjs <sessionId|path/to/session.v4.jsonl.zstd> [out.md]
```

DSH writes session logs as concatenated zstd frames; Node's zstd decodes only the first frame, so the script splits on the frame magic and decodes them one by one.

## Licence

MIT.
