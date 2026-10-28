---
type: reference
---

# Documentation

The rules for the documents, and their reasons. [CONTRIBUTING.md](../CONTRIBUTING.md#documentation) has the summary.

## Where each text goes

Each Markdown file has one class. The docs check holds each class to a line limit (`maxLines` in `.docs-check.json`). When a file is over its limit, the message says where the text goes.

| Class | Files | Limit | Holds |
|---|---|---|---|
| Entry | `README.md` | 200 | The fundamentals: what the product is, and how to start |
| Agent rules | `CLAUDE.md`, `AGENTS.md` | 80 | Only the rules that people break, and the expensive mistakes |
| Rules | `CONTRIBUTING.md` | 300 | What a contributor must do, with a summary and a link for each area |
| Policy | `SECURITY.md`, `.github/**/*.md` | 80 | The report path, and the pull request and issue forms |
| Decision | `docs/adr/*.md` | 300 | One decision: the context, the decision and the consequences |
| Topic | Each other `*.md`, mostly `docs/*.md` | 500 | One topic, with its `type:` in the frontmatter |
| Record | `CHANGELOG.md`, `CODE_OF_CONDUCT.md` | none | A log that only grows, or third-party text |

Each topic file in `docs/` opens with frontmatter that gives its type (`docTypes` in `.docs-check.json`):

```markdown
---
type: how-to
---
```

| Type | Answers | Example |
|---|---|---|
| `tutorial` | "Teach me, from the start." | A first contribution, step by step |
| `how-to` | "How do I do this task?" | `development.md`, `recipes.md`, `releasing.md` |
| `reference` | "What are the facts and the rules?" | `ci.md`, `testing.md`, `code-style.md`, `dependencies.md`, this file |
| `explanation` | "Why is it like this?" | `pipeline.md`, `architecture.md` |

Each repository has the same six topic files: `development.md`, `ci.md`, `testing.md`, `code-style.md`, `dependencies.md` and `documentation.md`. This repository adds topic files for its own areas, for example `recipes.md`, `releasing.md`, `engine.md` and `fidelity.md`. A recipe, a trap or a troubleshooting step goes in the topic file of its area, not in `CONTRIBUTING.md`. If a topic file gets to its limit, split it by subtopic.

## The index

`docs/README.md` lists each topic file in `docs/`, with one row for each
file, in path order. GitHub shows it when a reader opens `docs/`. When you
add, rename or remove a topic file, change its row there, and only there.
The docs check fails a file that has no row, a row that has no file, and a
row out of order (`docsIndex` in `.docs-check.json`). The other documents
(`CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md` and the like) are listed in
the README.

**Put technical detail in `docs/`.** If a topic needs more than a few lines, add it to the file in `docs/` that has the topic. If no file has the topic, give it a file of its own, and add a row for the file in the index, `docs/README.md`. Do not use a wiki. A wiki change gets no review and no link check.

## ASD-STE100

Each new or changed text follows these rules. [CONTRIBUTING.md](../CONTRIBUTING.md#documentation) says which texts the rule applies to. The main rules:

- One topic in each sentence, and one instruction in each procedure step.
- A maximum of 20 words in a procedure step, and 25 words in descriptive text. A maximum of six sentences in a paragraph.
- Use the active voice, and the imperative for an instruction. Put a condition first ("If the test fails, …").
- Use simple present, past or future tenses. Do not use "-ing" forms, except in technical names.
- Use "must" for an obligation, "can" for an ability, and "do not" for a prohibition. Do not use "should", "may", "might" or "would".
- Use the same word for the same thing each time. Do not leave out "the", "a" or "an". Use a maximum of three nouns in a row.
- Do not use phrasal verbs, contractions, semicolons in prose, or "e.g.", "i.e." and "etc.".
- Do not change code, commands, file names or product names: they are technical names.

## The README

**The README keeps to the fundamentals, in a maximum of 200 lines.** CI's docs check enforces the limit (`maxLines` in `.docs-check.json`). The README has these sections, in this order:

1. A banner (`docs/assets/banner.svg`), the CI, security and licence badges, the name, and one sentence that says what the product is.
2. **Highlights:** three to five bullets.
3. **Overview:** what the product does, how mature it is, and what it is not.
4. **Demo:** a screenshot or a short GIF, from `docs/assets/`.
5. **Usage** and **Installation:** one or two commands each.
6. **Documentation:** one line that links the index, `docs/README.md`, and a
   list of the other documents.
7. **Contributing and feedback**, and **Licence**.

Two facts in the README have a test. `src/engine/__tests__/directiveSupport.test.ts` reads the count for each support level from the table in the Overview. It also reads the count of the attributes that the registry does not know. Keep both in the README.

## Other rules

- **Do not write by hand a fact that a tool can give.** For example, do not put test counts in the README: `npm test` prints them.
- **Code comments** follow [their rules](code-style.md#code-comments).
