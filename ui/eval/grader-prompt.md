<!--
  Grader rubric for BRD faithfulness scores (see fixed-items.mjs). Fill {SAMPLE} with one grader file
  (fixed1-3.md), {PROMPT} and {SOURCES} with the task prompt and source documents, {GOLDEN_MAP} with which
  Golden Repository ids are which source files (or delete that line). Scores are comparable only under the
  same version of this file: record its commit with each run result.
-->

You are an independent reviewer of requirements in a Business Requirements Document (BRD) written from client documents. Check each requirement against its sources.

If the BRD cites Golden Repository ids, {GOLDEN_MAP} (for example: GLD-FS-002 is the same document as the second source file).

Read ONLY these files:
- {SAMPLE} (requirements separated by =====)
- {PROMPT} (the task prompt the writer was given; it is also a legitimate source)
- {SOURCES} (each source document, one per line, with its line count)

FULL-READ RULE: read the task prompt and every source document to their LAST line before grading (page through with offsets when a read is truncated; keyword search alone does not count). At the end, state for each file the line range you actually read.

Do NOT read any other file.

Each requirement is preceded by a "> Source item(s) to check:" note naming the source item (Area › Requirement Breakdown sub-heading in the source document) it was chosen to cover. Check that the requirement fully covers that item: every element and sentence must be present, unless another requirement named in an "Other requirements citing the same item" note could carry it (note that as a coverage question, not a FAIL). A "POSSIBLE MERGE" note means the requirement is the best match for several items: FAIL it if it merges distinct source items into one requirement.

EXEMPTION — the source's own inferences: a source sentence that is the analyst's inference about the requirement rather than a statement of it ("This suggests printed documents are needed.", "This implies …", "This indicates …") is not an obligation. Leaving it out is not a MINOR and not a FAIL. This exemption does NOT cover a list the inference introduces ("This suggests the business may need to track: A, B, C"): those items are content and must be kept, with the hedge.

For each requirement, check:
1. Requirement Statement: does every claim, condition, number and list item appear in a source? Are source items merged, dropped, or invented? Is the strength right ("should"/"may" must not become "shall"/"must", and vice versa)?
2. Source Reference: does the cited source and section exist and support the requirement?
3. Priority / Dependencies: is "Not specified" correct, or does the source state one? A stated dependency must be in the source.
4. Open Questions: if it cites a "Gap N" or "Decision N", does item N in that area of the cited document match? If it says "None", does the source list a gap or open item about this requirement?
5. Name: does it reflect the source item, without merging two distinct items?

Grade each requirement: PASS (faithful, no issue), MINOR (small wording drift or omission that does not change meaning or obligations), FAIL (changes meaning, invents a condition, merges/drops items or an obligation, wrong strength with consequence, wrong citation or wrong Gap/Decision number, invented dependency). Be strict and quote evidence.

Output a table: REQ id | grade | one-line reason with source quote for any non-PASS. End with totals: PASS n, MINOR n, FAIL n, and the line ranges read per file.
