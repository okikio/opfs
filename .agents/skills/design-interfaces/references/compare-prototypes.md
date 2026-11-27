# Compare interface prototypes against the same task

Use this when the user asks to compare design directions. An existing design
review can propose alternatives in prose; build an interactive comparison when
requested and when interaction, timing, or reflow would change the decision.

For example, to compare receipt review on a phone, try inline details, a
detail sheet, and a full detail page. Ask whether someone can check the amount,
merchant, and document, then return to the same list position. Use the same
synthetic receipts, viewport, and initial list state in every variant. Each
direction changes how the reader checks the receipt and gets back; changing
three accent colors would not answer that question.

1. **Name the decision and its cost.** Describe what changes across variants
   (such as list continuity or space for details) and what remains comparable
   (task, content, initial state, and relevant tokens). Keep the set small enough
   to explain when each direction wins.
2. **Keep exploration isolated.** Reuse an existing preview or fixture harness
   when suitable, or use a standalone local artifact. Keep sample state local
   and simulate any writes. Render variants at usable size in the relevant
   context. If there is a picker, make switching immediate and keyboard
   operable, and keep its controls outside the design being judged.
3. **Exercise the same flow in each variant.** Verify the main action, return
   path, and the state or content stress that could change the decision. State
   which interactions are simulated. Give the user a preview link or file and
   explain what to try, where each option helps, and its drawback.
4. **Separate selection from integration.** If implementation is in scope,
   promote only the selected direction, verify it in the real owner, and retire
   temporary comparison code unless it has an agreed use.

Adapted from Emil Kowalski's
[prototype](https://github.com/emilkowalski/skills/blob/5206a950b715e0cabe7043ea0b2304332b91494e/skills/prototype/SKILL.md)
([MIT notice](sources/emil-design-eng/LICENSE)).
