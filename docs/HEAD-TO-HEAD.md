# Head-to-head: AgenticOS and Claude Code on the same document

The question: when should a team use the AgenticOS agent rather than Claude Code directly? Agree the rules below before
the first run, and do not change them after seeing a result.

## Arms

| Arm | What it is |
|---|---|
| A. AgenticOS | The `brd-from-documents` agent in the web app |
| B. Claude Code | A competent prompt: the same task, sources and requirement format. No AgenticOS tools |
| C. Claude Code with the gate | Arm B plus the quality gate and its reviewer brief (see CLAUDE-CODE-QUALITY-GATE.md) |

Arm C tests whether the value is in the agent or in the checks. If C matches A, ship the checks and stop maintaining a
separate agent for this work.

## Fairness

- Same model and effort in every arm, recorded with each run.
- Same task prompt and source documents. No arm gets text another does not.
- The person writing the Claude Code prompt is someone who wants it to win, and may revise it on a different document
  first. Record the prompt.
- Three runs per arm, each from a clean session or project with no earlier output to reuse.

## Measures

| Measure | How |
|---|---|
| Quality | A fixed sample of 30 source items chosen once, before any run (`ui/eval/fixed-items.mjs init`), graded PASS / MINOR / FAIL by readers who read every source in full and do not know which arm wrote the document. Items no requirement covers count as FAIL |
| Variation | Lowest and highest pass count across the three runs |
| Coverage | Source items covered, from the gate's count, for every arm |
| Time | Start to saved document |
| Cost | Model usage per run |
| Human effort | Minutes a reviewer spends to make the document sendable |

Remove anything that names an arm (tool names, check summaries, file names) before grading. The graders must not be the
sessions that wrote the documents. Graders are models too, so have a person re-grade a few items from each arm.

## Decision rule (agree the numbers first)

Proposed:

- **Keep the agent** if its lowest run beats the best arm's alternative by at least 2 items of 30, or it matches on
  quality and saves at least a third of the reviewer's time.
- **Ship the checks only** if arm C is within 1 item of arm A.
- **Publish a skill and retire the agent** if arm B is within 1 item of both.

One document is one data point. Repeat on a second, unrelated set of sources before acting on the result.
