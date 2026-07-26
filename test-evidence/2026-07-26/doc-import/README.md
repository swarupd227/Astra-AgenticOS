# Word / PDF import — test evidence

Four documents were generated to exercise each path, then converted through the real
`POST /api/golden/convert` endpoint and finally through the browser UI itself.

| File | What it tests | Result |
|---|---|---|
| `policy.docx` | A realistic standard: real Heading styles, hand-typed clause numbers (4.1.2), a retention table | 7 headings, table preserved as a Markdown table, no warnings |
| `policy.pdf` | Same content as PDF | Text complete; correctly reports that PDFs carry no headings but that numbered clauses are still citable |
| `flat.docx` | Word file with no Heading styles at all | Both structural warnings raised — no headings, no clause numbering |
| `poisoned.docx` | A document containing text aimed at an AI reader | SECURITY warning raised, quoting the offending sentence |

`convert-*.json` holds the full endpoint response for each.

## End-to-end proof

`agent-test-imported-docx.json` is the important one. `policy.docx` was converted, published
as `GLD-STD-002`, and a real agent was asked a question only that document can answer. It
returned:

- **`GLD-STD-002@1`, §3.1** — quoting the table row *"Access log — 18 months — Security"*
- **`GLD-STD-002@1`, §4.1.1** — quoting *"Deletion must be irreversible; a soft-delete flag does not satisfy this standard."*

So a Word document dropped into the UI ends up as something an agent cites by clause. That is
the whole point of the feature, and it is verified rather than assumed.

## Defect found and fixed during this test

`POST /api/golden/convert` was originally registered *after* `POST /api/golden/:id`. Express
matches routes in registration order, so "convert" was swallowed as an item id and every upload
failed with `No such golden item: convert`. The route now sits above `:id`, with a comment
saying why it must stay there.
