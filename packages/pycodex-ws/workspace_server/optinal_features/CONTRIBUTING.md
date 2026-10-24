# Publish a frontend feature

A feature is reference source that a customization Agent reads and adapts into
the user's frontend. Its files may be a complete page or focused JS/CSS and
assets. There is no required export, mounting interface or runtime registration.

The default contribution repository is
[Randomizez/pycodex](https://github.com/Randomizez/pycodex).
Submit a pull request on GitHub.
Use a different target when the user explicitly names one. The user's current
working directory may be an unrelated project, so do not infer the publication
target from its Git remote.

## Browse and apply

Link the installed `optinal_features/README.md` using an absolute Markdown file link.
Clicking it opens the catalog in the existing workspace view area. Link feature
READMEs and previews the same way. The user chooses by writing feature names,
IDs and desired changes in chat; selection has no checkbox, form or new command.

Read the actual catalog before describing available features. If it is empty,
say so. Treat a catalog from a user-specified checkout as a separate source and
identify it when presenting its entries.

For selected features, read their documentation and source, inspect existing
customizations, and integrate the requested behavior into the user's frontend.
Preserve unrelated changes and validate the resulting interactions together.
Browsing a feature does not apply it.

## Submission layout

Submit one feature per PR under this repository path:

```text
packages/pycodex-ws/workspace_server/optinal_features/
  README.md
  <feature-id>/
    README.md
    source/
      ...reference source and required assets...
    preview.png                       # optional screenshot
```

Use a descriptive lowercase kebab-case ID, such as `exec-status`, matching
`[a-z0-9]+(?:-[a-z0-9]+)*`. Reuse the directory when improving an existing
feature. Source filenames follow the implementation; no fixed entry filename
is required. Keep all referenced assets inside the feature directory.
Explain external dependencies and how to obtain them.

Update the catalog with one row containing the ID, linked feature title,
one-sentence summary and a brief description of actual validation. Remove the
empty-catalog sentence when adding the first feature. Keep rows ordered by ID.
The catalog is a Markdown document maintained in the PR; nothing is loaded or
registered from it at runtime.

Extract the requested behavior from the local customization. Include readable
source and any required assets, preserving required license notices. Exclude
unrelated personal customizations, credentials, conversation data, private
paths, caches and generated dependency bundles.

## Feature README format

Start with YAML front matter containing these descriptive fields:

```yaml
---
title: "Exec status"
summary: "Show running command sessions and their exit status."
tags: [exec, status]
---
```

`title` and `summary` are nonempty strings; `tags` is a list of strings.
The directory name is the feature ID. This metadata describes source for
readers; it is not a plugin manifest.

Use the following Markdown sections after the front matter:

- `# <title>`: the feature's display name.
- `## Behavior`: the user-visible effect and a concrete before/after example.
- `## Source`: link the supplied files and explain their responsibilities.
- `## Integration`: identify the APIs, DOM assumptions and dependencies;
  describe how to adapt the source into existing customizations and undo it.
  Provide one clear command or set of manual steps to reproduce the example.
- `## Validation`: record scenarios, steps or commands, observed results and
  available evidence. For asynchronous UI, cover initial loading, joining
  running work, session switching, refresh/reconnect and cleanup where relevant.
  State which scenarios were not checked and why; do not infer success.
- `## Preview`: link a screenshot or demo if available; otherwise say it is
  unavailable. Describe the expected visual result.
- `## Limitations`: known issues, prerequisites and unverified behavior.

## PR format

Title:

```text
feature(<feature-id>): <short description of the resulting behavior>
```

Use this body structure. Replace the guidance with concrete details; normal
prose and tables are sufficient.

```markdown
## Feature

ID, title and one-sentence purpose.

## Changes

Describe the trigger and before/after behavior.
Link the example directory and explain the catalog change.

## Integration

Explain the supplied source, APIs/dependencies and adaptation steps.

## Validation

Record the checks actually run, results and evidence.
Identify checks not run and the reason.

## Preview

Link a screenshot/demo or state that none is available.

## Limitations

Describe known issues and prerequisites.
```

## Agent publication workflow

When the user asks to publish a particular local change, read this guide and
the target repository's instructions. Honor session constraints such as
"do not commit" or "do not push"; a request to edit locally is not a request
to publish.

Use a user-owned checkout or isolated worktree of the target repository, outside
the served customization directory. Inspect the local diff and relevant source,
extract the feature, prepare its README and preview, and update the catalog.
Validate the example and review the scoped diff before submitting it.
Stage only the feature directory and its catalog row. Backend or built-in
frontend changes belong in a separate implementation PR.

When publication is authorized, commit on a feature branch, push that branch
or the user's fork, and open a PR against the target's default branch using
the title/body above. Use the available authenticated Git hosting tool; for
multiline bodies, pass a file or structured argument. Return the actual PR
link and validation results. Do not merge the PR as part of submission.

If the target or access is missing, finish the local source, diff and PR body
first, then report what is needed to submit. Never claim a locally prepared
contribution has been published.

Merged features appear in the repository catalog. Installed catalogs update
when the workspace package is updated; there is no automatic remote fetch.
