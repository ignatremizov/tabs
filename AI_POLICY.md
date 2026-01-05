# AI Contribution Policy

This project welcomes AI-assisted contributions.  Think of AI like a power
tool: it can speed up work, but the contributor remains fully responsible for
the result.  This policy explains expectations for AI-assisted code and
documents the legal/ethical considerations we follow.  It is not legal advice.

Last reviewed: 2026-01-05

## Summary

- AI-assisted code is allowed.
- Contributors are responsible for reviewing, testing, and understanding the
  code they submit.
- Contributors must have the rights to submit any AI-assisted code under this
  project's license.
- Disclosure of substantial AI assistance is strongly recommended.

## Why we allow AI assistance

We treat AI tools the same way we treat other productivity tools.  People have
long reused patterns, references, and snippets (for example from docs or
Stack Overflow).  AI can help, but it does not change the contributor's
responsibility for correctness, security, and licensing.

## Contributor responsibilities

If you use AI to help with a contribution, you must:

- Review and understand the code.
- Test the code you submit.
- Ensure the code is compatible with this project's license.
- Ensure you have the right to submit the code (including any third-party
  material the AI may have reproduced).

Strongly recommended:

- If AI assistance was substantial, mention it in the PR or commit message.

See also [AI and the DCO](AI_DCO_ADDENDUM.md).

## Legal and compliance notes

AI providers generally state that users own the output (for example: OpenAI,
Anthropic, Google Gemini, DeepSeek).  This allows contributors to submit AI
output under open-source licenses, including AGPL-3.0-or-later.  However:

- Providers do not guarantee outputs are original, correct, or
  non-infringing.
- Providers require compliance with their usage policies.
- Some providers restrict using outputs to train competing models.
- Some providers require that AI-generated content not be misrepresented as
  human-only content.

This means contributors must still verify that AI output does not copy
third-party code, and must comply with the provider's terms.

## Practical guidelines

For AI-assisted code, we recommend:

- Keep contributions small and reviewable.
- Run tests and, if relevant, add tests.
- If a chunk looks suspiciously similar to known code, check its origin and
  include required attribution or rewrite it.
- Avoid including secrets or confidential data in prompts.

## How maintainers will review AI-assisted code

AI-assisted contributions are reviewed like any other contribution, with extra
attention to licensing, security, and correctness.  Maintainers may request
clarifications or changes, and may reject contributions that are hard to verify
or appear to include third-party code without proper attribution.

## Questions

If you're unsure whether a contribution is appropriate, open an issue or ask in
your PR before submitting a large change.
