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
