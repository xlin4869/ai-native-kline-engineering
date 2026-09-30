# AI use and review

## Candidate-described tool sequence

Codex Astra Ultra led requirements analysis, technical design, and implementation documentation. ChatGPT on the web (described by the candidate as GPT-6 Pro) supplied supplementary ideas and alternative perspectives. Codex GPT-6.0 SOL did most of the implementation. Claude Code then independently reviewed the work, found defects, and improved the code. Codex Astra Ultra led the final audit and closeout, with Codex SOL also contributing final fixes and delivery checks.

The local Codex session metadata labels the implementation turns `gpt-6-sol` and the final turns both `gpt-6-astra` and `gpt-6-sol`. The candidate corrected an earlier mistaken model recollection in the later conversation; the readable transcripts retain that exchange in sequence. The saved ChatGPT web page does not expose a verifiable model setting, so its exact model and the Ultra effort label follow the candidate's description.

The final follow-up fixed reconciliation retry starvation, added HTTP request deadlines and cancellation, and introduced linked retention of bars and quality evidence. `REPORT.md` is the short reviewer-facing report; `AI_NATIVE_CASE_STUDY.md` connects AI suggestions and review corrections to independent checks. Readable history has explicit snapshot cut-offs; later review and packaging messages are included in this portfolio archive through the stated cut-off.

AI was used for assignment interpretation, architecture comparison, implementation drafts, test ideas, code edits and review. The candidate remains responsible for understanding and presenting every submitted behavior. The included transcripts distinguish this Codex session and its technical subagents from two other-agent **excerpts supplied by the user**; those excerpts are not represented as complete original chats.

The workflow did not rely on model agreement as proof. Concrete checks caught and changed several decisions: the initial `decimal.js` import worked at runtime but failed TypeScript under NodeNext; a semantic-config rejection leaked an SQLite handle until a Windows file-cleanup test exposed it; adding the initial source gap changed quality expectations and required an explicit zero-length-gap rule; simultaneous test/demo/typecheck startup hit short wall-time test limits, so the test runner was made sequential and rechecked; `npm audit` identified a vulnerable ZIP dependency, which was upgraded before packaging. The independent BigInt oracle, hand-calculated constant, HTTP consumer and real child kills provide separate checks against shared implementation mistakes.

## Round 2: independent AI review (Claude Code)

A second AI tool (Claude Code, model Opus 5.5) was then asked to review the accepted archive independently, fix evidenced defects and decide on a live Binance source. It did not take the first session's tests or verification record as truth. It reproduced each suspicion with a probe against an untouched copy of the archive before changing code, and it kept every finding that turned out false or invalid:

- A first mutation run appeared to kill all mutants but had only failed to load `tsx` from a broken copy of `node_modules`. It was discarded and re-run; the property test then killed only 2 of 5 mutants, which led to the generator's edge probes.
- A captured-stream replay first disagreed with the exchange kline. The service was right: the test harness had not replayed the recorded socket close.
- A live check "failed" because real trades arrived late and the service correctly flagged the minute. The check's criterion was wrong and was changed; the service was not.

The resulting changes and their evidence are in `results/review.md` and `results/verification.md`.

## Round 3: resolving the remaining items (same Claude Code session)

The user then asked for every remaining item to be resolved: revision monotonicity, the live source's lifetime caps, backfill for late and gap minutes, Linux and OS-level disk-full verification, and a real network drop. Checks again changed the course of the work:

- The reconciliation property test caught a defect introduced in this round. A shell edit had dropped a backslash from a regex, so the history validator accepted only single-digit trade IDs, which were the only IDs the unit tests used.
- The first Linux ENOSPC run "failed" only because the test assumed the filesystem would take more than 100 trades before filling; 34 fit.
- The first injected-disconnect replay failed because the test harness moved its virtual clock backwards.

Each cause was identified before the test or code was changed.

No other person was asked to design, implement, debug or review this submission. AI-generated code and advice were tested against the stated data and failure contracts. The chat-history index states which raw records could be extracted and what was redacted.
