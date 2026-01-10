# Contributing to TKTSTO

To get code into this project, you must agree to the terms of a few documents:

- [Developer Certificate of Origin](DEVELOPER_CERTIFICATE_OF_ORIGIN)
- [Code of Conduct](CODE_OF_CONDUCT.md)

Mostly, these documents assert that you won't be a jerk, and you won't submit
code you don't have rights to.

And, of course, you must agree to publish your contributions as Open Source
under the same license as this project's source code, or as Public Domain with
no copyright.

## Sign-off (DCO)

Please sign your commits to certify the DCO:

```
git commit -s
```

This applies to AI-assisted contributions as well.  You remain responsible for
review, testing, and having the right to submit the code.

## AI / Generated content

See [AI Contribution Policy](AI_POLICY.md) for details.

AI-assisted code is welcome.  Treat AI like any other tool: you are responsible
for the result.  The
[Linux Foundation's AI Policies](https://www.linuxfoundation.org/legal/generative-ai)
are a useful reference; our practical expectations are:

- Contributors should ensure that the terms and conditions of the generative AI
  tool do not place any contractual restrictions on how the tool’s output can
  be used that are inconsistent with the project’s open source software
  license, the project’s intellectual property policies, or the
  [Open Source Definition](https://opensource.org/osd/).

- If a contribution is later found to include third-party copyrighted material,
  the contributor must help identify the source and provide any required notice
  and attribution, or help replace the code with a clean alternative.  If you
  already know an AI output is derived from a specific source, disclose it and
  include the required license/attribution at submission time.

Additionally:

- You must understand and test the code you submit.
- If AI assistance was substantial, disclosure in the PR or commit message is
  strongly recommended.
- Do not submit AI output you did not review, test, or have rights to.


### US Copyright Office 2025 conclusions

The US Copyright Office has some pretty relevant findings on the topic:

https://www.copyright.gov/ai/Copyright-and-Artificial-Intelligence-Part-2-Copyrightability-Report.pdf

- "Copyright does not extend to purely AI-generated material, or material where
  there is insufficient human control over the expressive elements."

- "Whether human contributions to AI-generated outputs are sufficient to
  constitute authorship must be analyzed on a case-by-case basis."

- "Based on the functioning of current generally available technology, prompts
  do not alone provide sufficient control."

This means it is complicated to determine if contributors have sufficient
"authorship" rights to be able to claim copyright over the code being
submitted.

GPL/AGPL projects can include public domain code, but those parts of the code
remain public domain and are not subject to the terms of the project license.
There is no clear and practical way to denote which parts of the code are
copyrighted vs public domain though, so that generally needs to be addressed on
a case by case basis if/when any contention occurs.

### How AI generated code contributions will be evaluated

The analyses I've found from lawyers and prominent Open-Source companies mostly
concluded that it's complicated and clear rules don't exist yet, so their
recommendation is to be very careful with AI-generated content (like avoid
things which look like they may have been copied instead of original), and
otherwise assume it's public domain unless clear evidence of authorship is
provided (like by documenting the author's creative process and how they have
substantially transformed the AI's output).

So in this project, AI-generated code will be subject to the following
guidelines:

1. If it looks like it might be copyrighted code from somewhere else, reject it
   or rewrite it.  Non-trivial effort may be required to look for original
   sources, so things may stall out at this step.

2. If no clear evidence was provided that a human has done a legally meaningful
   amount of work to transform the AI's output, assume the code is not
   copyrightable.  Strip any copyright notices from the submitted code, and
   treat it as public domain.  If the patches modify existing source files, the
   pre-patch copyright headers on those files will remain unchanged.  If the
   patches create entirely new files, they will have no copyright headers
   until/unless a human does a meaningful amount of modifications to the file.
   Copyright will be assigned to the person who did the modifications, not the
   submitter who AI-generated the initial version.

3. If any questionable content exists in the commits being submitted, such as
   potentially plagiarized code or copyright headers added to uncopyrightable
   content, those commits will not be included in the project's history graph.
   Instead, patches will be applied manually in fresh commits, without
   a reference to the original commits.  The submitter will generally be
   acknowledged in a commit message, but not listed in the commit headers, like
   'Author:' or 'Committer:'.

4. AI-generated code will need additional testing and validation, to understand
   it and ensure it does not introduce any bizarre bugs.  This will take
   additional time.  In many cases, it may also need to be significantly
   modified or rewritten, to align with the project's style and goals.  This
   will also take additional time.

5. Given the difficulty of detecting whether code was written by AI or by the
   person submitting patches, it will be important to communicate about the
   origin of the code.  Pull requests and patches should clearly communicate
   the code's origin and authorship.

If a maintainer treats code you wrote as if it was AI-generated, please contact
them to resolve the misunderstanding.

If you believe your copyrighted code has been included in violation of your
rights, please contact the project maintainer to resolve the situation.  We
will make best-effort attempts to prevent any code from being included without
permission, but it's difficult and complicated to determine original
authorship, and mistakes may be made occasionally.
