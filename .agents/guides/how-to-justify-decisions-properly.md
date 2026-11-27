> **Current standards note (2026-08-19):** Use [Engineering Standards](engineering-standards.md) for current cross-project naming, schema/type, comments/TSDoc, formatting, testing, logging, dependency, compatibility, validation, and delivery rules. This document remains authoritative for its domain-specific design and dated implementation evidence where it is more specific.

## 1. Core Principle

A decision is properly justified when the reader can see the **path from the situation to the action**.

The standard is not:

> “This is necessary.”

The standard is:

> “Given this objective, these constraints, this evidence, these risks, this time horizon, and these rejected alternatives, this decision is the least-bad available response. If we do not take it, a specific goal fails or a non-negotiable constraint is violated.”

That distinction matters because “necessary” is often used as rhetorical pressure. It can hide preference, fear, convenience, urgency, ego, sunk cost, or institutional habit. A rigorous justification treats necessity as a **conditional conclusion**, not a vibe.

A decision is only necessary **relative to something**:

> Necessary for what?
> Under what constraints?
> Compared with which alternatives?
> At what acceptable level of risk?
> Over what time horizon?
> According to whose values or obligations?

This matches practical reasoning: deciding what to do is reasoning from ends, facts, constraints, and available means toward action. The Stanford Encyclopedia of Philosophy defines practical reason as the capacity for resolving “the question of what one is to do,” which is exactly the kind of reasoning you are trying to discipline here. ([Stanford Encyclopedia of Philosophy][1])

So the hard rule is:

> **If the decision cannot be grounded in goals, constraints, causal necessity, rejected alternatives, and consequences of inaction, downgrade the claim. It may be useful, prudent, preferred, convenient, or defensible, but not necessary.**

This is why legal proportionality is useful outside law. Proportionality asks whether a measure pursues a legitimate aim, is rationally connected to that aim, is necessary in the sense that less restrictive alternatives are insufficient, and is balanced against its harms. Canadian Charter analysis, for example, asks whether the objective is pressing and substantial and whether the means are rationally connected, minimally impairing, and proportionate. ([Ministère de la Justice][2]) Robert Alexy similarly breaks proportionality into suitability, necessity, and balancing. ([corteidh.or.cr][3])

That gives you the essence:

> **Necessity is demonstrated when the decision survives comparison against less costly, less risky, less coercive, less disruptive, and more reversible alternatives.**

---

## 2. Framework for Justifying a Decision

Use this as your reusable method.

### Step 1: Name the protected objective

Start with the value, goal, obligation, or failure condition.

Bad:

> “We need to migrate the system.”

Better:

> “We need to preserve customer-facing uptime during peak season while reducing deployment risk below our agreed threshold.”

A decision cannot be necessary in the abstract. It is necessary **for preserving or achieving something**. Ralph Keeney’s *Value-Focused Thinking* is especially useful here because it argues that decision-making should begin with values and objectives, not with preselected alternatives. ([Harvard University Press][4])

Ask:

> What value is at stake?
> What outcome are we trying to protect?
> What unacceptable failure are we preventing?

### Step 2: Separate hard constraints from preferences

Classify constraints.

Hard constraints are non-negotiable:

* Legal or regulatory requirements.
* Physical impossibilities.
* Security obligations.
* Contractual commitments.
* Budget ceilings that cannot move.
* Time limits that cannot move.
* Safety or ethical boundaries.

Soft constraints are preferences:

* Faster would be better.
* Lower cost would be nice.
* Leadership prefers it.
* The current team is comfortable with it.
* It matches the roadmap.

Necessity usually comes from hard constraints. Preferences can justify a choice, but they rarely prove necessity.

Decision Quality theory is useful here because it treats a good decision as a chain: frame, alternatives, information, values and trade-offs, reasoning, and commitment. The decision is only as good as its weakest element. ([SDG][5])

### Step 3: Diagnose the situation before prescribing action

Richard Rumelt’s strategy “kernel” is directly relevant: good strategy contains a diagnosis, a guiding policy, and coherent action. Bad strategy often skips the diagnosis and jumps to goals or slogans. ([Amazon][6])

A rigorous justification should say:

> Here is what is happening.
> Here is why it is happening.
> Here is why ordinary measures are insufficient.
> Here is the obstacle that makes action necessary.

Without diagnosis, the decision is floating. You may have an action, but not a reason.

### Step 4: Build the causal chain

This is the “show your work” part.

Use the chain:

> Current condition → mechanism → likely consequence → protected goal fails → action interrupts that chain.

Example:

> Current condition: onboarding requests are manually reviewed.
> Mechanism: request volume is growing faster than reviewer capacity.
> Consequence: review delays will exceed SLA.
> Goal failure: enterprise customers will miss provisioning deadlines.
> Required action: automate low-risk reviews and reserve manual review for edge cases.

The decision becomes harder to dispute when the causal chain is visible.

### Step 5: Generate real alternatives, including inaction

A decision cannot be necessary if you have not compared it with alternatives.

At minimum, compare:

1. Do nothing.
2. Delay.
3. Partial action.
4. Reversible experiment.
5. Lower-cost option.
6. Lower-risk option.
7. Less disruptive option.
8. The proposed decision.
9. A more aggressive version of the decision.

The *Smart Choices* framework by Hammond, Keeney, and Raiffa emphasizes problem framing, objectives, alternatives, consequences, trade-offs, uncertainty, risk tolerance, and linked decisions. ([Harvard Business School][7]) This is almost perfectly aligned with your goal: a decision is not justified until it has been tested against the option space.

### Step 6: Reject weaker options explicitly

This is where necessity is usually made or broken.

Do not merely say:

> “Alternative B is insufficient.”

Say:

> “Alternative B reduces cost but does not satisfy constraint C. It leaves failure mode F unresolved. Based on evidence E, the residual risk remains above threshold T. Therefore it is rejected.”

Borrow the legal “least restrictive means” instinct: the proposed decision must survive the question, “Why not something weaker?” Proportionality analysis treats necessity as partly a search for less intrusive means that still achieve the legitimate aim. ([British Institute of Human Rights][8])

### Step 7: State the consequences of not acting

A weak justification says what the decision does.

A strong justification says what breaks without it.

Use this form:

> “If we do not take this decision, then X happens because Y. The consequence is unacceptable because it violates Z.”

This prevents vague urgency.

Bad:

> “We need to move quickly.”

Good:

> “If we wait until Q4, the migration collides with peak revenue season. That creates a rollback risk during our highest-traffic period, which violates the reliability constraint we already accepted.”

### Step 8: Identify trade-offs honestly

A rigorous justification does not pretend the chosen option is painless.

It says:

> “This decision imposes cost A and risk B. We accept those because the alternatives either fail the constraint or create worse expected harm.”

This is where the decision becomes credible. Decision Quality and decision analysis both force explicit treatment of values, trade-offs, uncertainty, and risk tolerance. ([O'Reilly Media][9])

### Step 9: Expose assumptions and defeaters

A defeater is something that, if true, would undermine the decision.

Ask:

> What would have to be false for this decision to no longer be necessary?

Examples:

* If the deadline can move, the expensive rush option may not be necessary.
* If a smaller pilot satisfies the risk requirement, full rollout may not be necessary.
* If the failure probability is below threshold, mitigation may be optional.
* If a vendor can meet the requirement, building internally may not be necessary.

This is where you guard against motivated reasoning. Kahneman, Lovallo, and Sibony’s HBR checklist is useful because it asks leaders to examine whether teams explored alternatives, gathered the right information, and used well-grounded numbers rather than biased internal narratives. ([ResearchGate][10])

### Step 10: Conclude with a conditional necessity claim

The final decision statement should look like this:

> “Given objective G, constraints C1–C3, evidence E, and the rejection of alternatives A–D, we should choose Decision X. It is necessary not because it is ideal, but because every weaker or cheaper option fails at least one non-negotiable constraint or leaves unacceptable residual risk.”

That is the standard.

---

## 3. Necessity Test

Use this as a diagnostic gate. A decision that fails these questions should not be called necessary.

### A. Goal test

* What specific goal, value, duty, or obligation is protected?
* What breaks if this decision is not made?
* Is the goal itself valid, or are we smuggling in a preference?
* Is the goal ranked above competing goals?

### B. Constraint test

* What hard constraint forces action?
* Is the constraint legal, technical, financial, ethical, contractual, temporal, or operational?
* Is it genuinely non-negotiable?
* Who has authority to relax it?
* What evidence proves it cannot move?

### C. Causal-chain test

* What is happening now?
* What mechanism turns the current condition into future harm?
* How likely is that harm?
* How soon will it happen?
* How does this decision interrupt the chain?

### D. Alternatives test

* What alternatives were considered?
* Was doing nothing considered?
* Was delaying considered?
* Was a reversible pilot considered?
* Was a cheaper or less disruptive option considered?
* Was the opposite decision considered?

### E. Rejection test

For each rejected alternative:

* Which requirement does it fail?
* What evidence shows that failure?
* Is the rejection based on facts, forecasts, constraints, or mere discomfort?
* Would a reasonable critic accept the rejection?

### F. Evidence test

* What facts are known?
* What forecasts are uncertain?
* What assumptions are doing the most work?
* What evidence would change the decision?
* Are we using an outside view or reference class, not only internal optimism? Kahneman and Lovallo’s work on the planning fallacy warns that “inside view” reasoning often underestimates time, costs, and risks by ignoring comparable past cases. ([denkproducties.nl][11])

### G. Proportionality test

* Is the decision suitable for the objective?
* Is it stronger than necessary?
* Is there a less costly, less coercive, less disruptive, or more reversible option?
* Are the harms of the decision justified by the harms it prevents?

### H. Risk-of-inaction test

* What happens if we do nothing?
* What happens if we wait?
* What happens if we choose a partial measure?
* Are the risks of action lower than the risks of inaction?

### I. Defeater test

* What would have to be false for this decision to stop being necessary?
* Which assumption, if reversed, would change the answer?
* What new evidence would downgrade this from “necessary” to “preferred”?

### J. Classification

After the test, classify the decision honestly:

| Classification              | Meaning                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------- |
| **Necessary**               | Required to protect a valid objective under hard constraints; weaker alternatives fail. |
| **Conditionally necessary** | Necessary only if certain assumptions hold.                                             |
| **Prudent**                 | Sensible and defensible, but not forced.                                                |
| **Preferred**               | Chosen because it is attractive, not because alternatives fail.                         |
| **Unjustified**             | The decision is asserted but not grounded.                                              |

That last classification is important. It gives you a way to say: “This may still be a good decision, but the case for necessity has not been made.”

---

## 4. Recommended Reading

### 1. *Smart Choices: A Practical Guide to Making Better Decisions*

**Authors:** John S. Hammond, Ralph L. Keeney, Howard Raiffa
**Field:** Decision analysis / management decision-making
**Why it matters:** It gives you a clean decision structure: problem, objectives, alternatives, consequences, trade-offs, uncertainty, risk tolerance, and linked decisions. ([Harvard Business School][7])
**Key idea to borrow:** A decision is only as strong as its framing, alternatives, and trade-off analysis.
**How it helps necessity:** It prevents “necessary” from being claimed before the decision problem has been properly structured.

### 2. *Value-Focused Thinking*

**Author:** Ralph L. Keeney
**Field:** Decision theory
**Why it matters:** Keeney argues that decisions should begin from values and objectives, not from available options. ([Harvard University Press][4])
**Key idea to borrow:** First ask “what do we care about?” before asking “what should we do?”
**How it helps necessity:** It forces the decision to be grounded in a protected value rather than a favored action.

### 3. Decision Quality framework

**Authors:** Carl Spetzler, Hannah Winter, Jennifer Meyer; Strategic Decisions Group tradition
**Field:** Decision science / business decisions
**Why it matters:** Decision Quality identifies six requirements: frame, alternatives, information, values and trade-offs, logical reasoning, and commitment to action. ([SDG][5])
**Key idea to borrow:** Overall decision quality is limited by the weakest link.
**How it helps necessity:** A necessity claim fails if any one link is weak, especially alternatives or evidence.

### 4. *Good Strategy/Bad Strategy*

**Author:** Richard Rumelt
**Field:** Strategy
**Why it matters:** Rumelt’s strategy kernel is diagnosis, guiding policy, and coherent action. ([Amazon][6])
**Key idea to borrow:** Good strategy starts by naming the central challenge.
**How it helps necessity:** It stops you from confusing goals with strategy. “We need growth” is not a justification. “This bottleneck blocks growth, and this action removes it” is closer.

### 5. Toulmin model of argument

**Author:** Stephen Toulmin
**Field:** Argumentation theory
**Why it matters:** Toulmin separates claim, grounds, warrant, backing, qualifier, and rebuttal. Purdue OWL summarizes the method as breaking arguments into claim, grounds, warrant, qualifier, rebuttal, and backing. ([Purdue OWL][12])
**Key idea to borrow:** Every decision claim needs a warrant: the bridge from evidence to conclusion.
**How it helps necessity:** It exposes hidden assumptions. You are forced to show why the facts actually imply the decision.

### 6. *Argumentation Schemes* / practical reasoning schemes

**Authors:** Douglas Walton, Chris Reed, Fabrizio Macagno
**Field:** Argumentation theory / informal logic
**Why it matters:** Practical reasoning schemes ask whether an action is a means to a goal and then test that inference with critical questions. Reviews of Walton, Reed, and Macagno highlight questions such as whether higher-priority goals conflict and whether alternative means exist. ([Notre Dame Philosophical Reviews][13])
**Key idea to borrow:** Every action recommendation is defeasible. It holds only until critical questions defeat it.
**How it helps necessity:** It gives you a direct checklist for attacking the decision before accepting it.

### 7. Proportionality analysis

**Authors:** Robert Alexy, Aharon Barak, constitutional-law tradition
**Field:** Legal reasoning / constitutional law
**Why it matters:** Proportionality tests whether a measure has a proper purpose, is rationally connected to that purpose, is necessary, and is balanced against its harms. Barak’s framework is summarized as proper purpose, rational connection, necessity, and proportionality. ([Cambridge Assets][14])
**Key idea to borrow:** The stronger the intrusion, cost, or harm, the stronger the justification required.
**How it helps necessity:** It forces you to show why a less restrictive option is insufficient.

### 8. *A Practical Guide for Policy Analysis: The Eightfold Path*

**Authors:** Eugene Bardach, Eric Patashnik
**Field:** Policy analysis
**Why it matters:** The Eightfold Path emphasizes defining the problem, assembling evidence, constructing alternatives, selecting criteria, projecting outcomes, confronting trade-offs, deciding, and telling the story. ([collegepublishing.sagepub.com][15])
**Key idea to borrow:** Policy justification is disciplined comparison, not just advocacy.
**How it helps necessity:** It forces the decision to be tied to evidence, criteria, alternatives, and projected consequences.

### 9. *Evidence, Argument, and Persuasion in the Policy Process*

**Author:** Giandomenico Majone
**Field:** Policy reasoning
**Why it matters:** Majone argues that policy analysis is not purely technical; it depends on evidence, argument, values, and persuasion in public reasoning. ([Yale University Press][16])
**Key idea to borrow:** Evidence does not speak by itself. It must be organized into a defensible argument.
**How it helps necessity:** It clarifies that justification must connect facts to values and institutional criteria.

### 10. *Thinking in Systems* / “Leverage Points”

**Author:** Donella Meadows
**Field:** Systems thinking
**Why it matters:** Meadows explains leverage points as places in a system where a shift can produce large changes. ([The Academy for Systems Change][17])
**Key idea to borrow:** Do not justify actions only by local symptoms. Understand the system structure producing the symptom.
**How it helps necessity:** It helps show why one intervention is required and why surface-level fixes are insufficient.

### 11. “A Leader’s Framework for Decision Making” / Cynefin

**Authors:** David Snowden, Mary Boone
**Field:** Complexity / management decision-making
**Why it matters:** Cynefin distinguishes contexts where best practice works from contexts where cause and effect are complex or unclear. Leaders need to match their decision approach to the situation. ([PubMed][18])
**Key idea to borrow:** Not all situations justify the same level of analysis or the same kind of action.
**How it helps necessity:** In complex domains, the necessary decision may be a safe-to-fail experiment rather than a full commitment.

### 12. “Dilemmas in a General Theory of Planning”

**Authors:** Horst Rittel, Melvin Webber
**Field:** Planning theory / policy / design
**Why it matters:** Rittel and Webber introduced “wicked problems,” where policy problems cannot be definitively described and do not have simple final solutions. ([Springer][19])
**Key idea to borrow:** Some decisions cannot be justified as final solutions; they can only be justified as responsible moves under ambiguity.
**How it helps necessity:** It keeps you from overclaiming necessity in messy, contested domains.

### 13. “The Science of Muddling Through”

**Author:** Charles Lindblom
**Field:** Public administration / policy
**Why it matters:** Lindblom argues that in complex policy environments, decision-makers often use successive limited comparisons rather than comprehensive rational analysis. ([JSTOR][20])
**Key idea to borrow:** Incremental action can be justified when comprehensive certainty is unavailable.
**How it helps necessity:** It supports a more precise claim: “A limited, reversible step is necessary now because full certainty is unavailable and delay has costs.”

### 14. “Before You Make That Big Decision…”

**Authors:** Daniel Kahneman, Dan Lovallo, Olivier Sibony
**Field:** Behavioral decision-making
**Why it matters:** Their checklist is designed to detect defects in team thinking, including narrow alternatives, weak evidence, and biased estimates. ([ResearchGate][10])
**Key idea to borrow:** Audit the process before trusting the conclusion.
**How it helps necessity:** It protects you from post-hoc rationalization and overconfident internal stories.

### 15. “Performing a Project Premortem”

**Author:** Gary Klein
**Field:** Cognitive psychology / project risk
**Why it matters:** Klein’s premortem asks teams to imagine the project has failed and then explain why, making dissent safer and surfacing hidden risks. ([Harvard Business Review][21])
**Key idea to borrow:** Test the decision by assuming it failed.
**How it helps necessity:** It reveals whether the proposed “necessary” action creates new failure modes worse than the problem it solves.

---

## 5. Practical Template

Use this whenever you need to justify a decision.

```text
# Decision Justification



## 1. Decision being proposed

We propose to:
[State the decision clearly.]

This is a decision about:
[Scope.]

This is not a decision about:
[Out of scope.]

## 2. Objective or value being protected

The decision is intended to protect or achieve:
[Goal/value/obligation.]

This matters because:
[Why the goal is legitimate and important.]

The goal fails if:
[Specific failure condition.]

## 3. Current situation

The relevant facts are:
- [Fact 1]
- [Fact 2]
- [Fact 3]

The current trajectory is:
[What happens if nothing changes.]

The causal mechanism is:
[Explain how current conditions produce the future problem.]

## 4. Constraints

Hard constraints:
- [Constraint 1]
- [Constraint 2]
- [Constraint 3]

Soft constraints or preferences:
- [Preference 1]
- [Preference 2]

The decision must satisfy:
[Non-negotiable requirements.]

## 5. Options considered

Option A: Do nothing
- Benefits:
- Costs:
- Risks:
- Constraint failures:

Option B: Weaker / cheaper / less disruptive option
- Benefits:
- Costs:
- Risks:
- Constraint failures:

Option C: Reversible pilot or partial measure
- Benefits:
- Costs:
- Risks:
- Constraint failures:

Option D: Proposed decision
- Benefits:
- Costs:
- Risks:
- Constraints satisfied:

Option E: More aggressive option
- Benefits:
- Costs:
- Risks:
- Why it is more than needed:

## 6. Evidence

Known facts:
- [Evidence]

Forecasts:
- [Prediction]
- Confidence level:
- Basis for confidence:

Key assumptions:
- [Assumption]
- What would change if false:

Counterevidence:
- [Evidence against the decision]

Reference class / outside view:
- [Comparable cases or historical data]

## 7. Alternative rejection

We reject Option A because:
[Specific reason tied to goal, constraint, evidence, or risk.]

We reject Option B because:
[Specific reason.]

We reject Option C because:
[Specific reason.]

We reject Option E because:
[Specific reason.]

## 8. Consequences of not acting

If we do not act:
[Consequence.]

If we delay:
[Consequence.]

If we under-act:
[Consequence.]

These consequences are unacceptable because:
[Constraint/value/risk threshold.]

## 9. Trade-offs accepted

This decision imposes:
- [Cost]
- [Risk]
- [Disruption]
- [Opportunity cost]

We accept these trade-offs because:
[Why they are lower than the cost/risk of alternatives.]

## 10. Necessity claim

Given:
- Objective:
- Constraints:
- Evidence:
- Rejected alternatives:
- Consequences of inaction:

We conclude that:
[Decision] is [necessary / conditionally necessary / prudent but not necessary].

It is necessary only under the following assumptions:
- [Assumption 1]
- [Assumption 2]

## 11. Defeaters

This decision would no longer be necessary if:
- [Defeater 1]
- [Defeater 2]
- [Defeater 3]

## 12. Review and reversal conditions

We will revisit the decision when:
[Trigger.]

We will reverse, pause, or modify the decision if:
[Condition.]

Owner:
[Person/team.]

Date for review:
[Date.]
```

---

## 6. Bad vs. Good Examples

### Example 1: Business or strategy decision

#### Weak justification

> We need to build an internal analytics platform. Data is important, and relying on third-party tools is not scalable. This is necessary if we want to make better decisions.

Why this is weak:

* “Data is important” is true but too broad.
* “Not scalable” is asserted, not shown.
* No constraints are named.
* No alternatives are compared.
* No cost or risk is acknowledged.
* “Necessary” is being used as pressure.

#### Strong justification

> We need to build a small internal analytics layer for revenue-critical metrics, not a full analytics platform. The protected objective is reliable weekly revenue reporting for enterprise accounts. The current third-party setup fails that objective because account identity, product usage, and billing events are stored in separate systems and cannot be reconciled within the reporting window.
>
> The hard constraints are: reports must be generated by Monday 9 a.m.; finance must be able to audit account-level numbers; and customer usage disputes must be traceable to source events.
>
> We considered three alternatives. First, keep the current tool and manually reconcile reports. Rejected because reconciliation already takes two days and fails the Monday reporting constraint. Second, buy a larger analytics suite. Rejected because implementation exceeds the current quarter and still requires the same source-event model. Third, export CSVs and reconcile in spreadsheets. Rejected because it fails auditability and increases operational risk.
>
> Therefore, the necessary decision is not “build a big analytics platform.” The necessary decision is to create an internal event-to-metric reconciliation layer for the revenue metrics that finance and customer support must trust. This is the least disruptive option that satisfies timeliness, auditability, and dispute-resolution constraints.

Notice what changed: the decision got narrower. The justification did not inflate the action. It reduced the decision to what the constraints actually require.

---

### Example 2: Personal or career decision

#### Weak justification

> I need to leave my job. I’m not growing, and staying would be bad for my career.

Why this is weak:

* “Not growing” is vague.
* No career objective is defined.
* No alternatives are considered.
* No evidence separates temporary frustration from structural stagnation.
* The conclusion may be true, but it is not yet demonstrated.

#### Strong justification

> My career objective for the next two years is to become a technical lead capable of owning architecture, mentoring engineers, and making product-level trade-offs. My current role no longer supports that objective. Over the past twelve months, the work has shifted toward maintenance and support, with no architecture ownership, no project leadership, and no path to staff-level scope.
>
> I tested weaker options first. I asked for ownership of a new internal platform project; it was reassigned to another team. I proposed mentoring responsibilities; the team has no junior engineers. I discussed a growth plan with my manager; the only available promotion path is people management, which does not match my objective.
>
> Staying is still possible, but it fails the primary career goal. Leaving is not necessary because the job is unpleasant; it is conditionally necessary because the role cannot provide the scope required for the next step, and the feasible internal alternatives have already been tested.
>
> The decision would no longer be necessary if a concrete technical leadership path opened within the next quarter with defined ownership, review criteria, and executive support.

This is much stronger because it includes a defeater. That makes it less like rationalization and more like reasoning.

---

### Example 3: Policy, governance, or organizational decision

#### Weak justification

> We need mandatory code review for all production changes. It is necessary to improve quality and prevent mistakes.

Why this is weak:

* “Improve quality” is too generic.
* The policy may be overbroad.
* No evidence shows current failures.
* No lighter alternatives are considered.
* It ignores costs: slower deployment, reviewer bottlenecks, performative approvals.

#### Strong justification

> We should require code review for all production-impacting changes, while exempting low-risk documentation, test-only, and non-runtime configuration changes. The protected objective is production reliability.
>
> The current condition is that production changes can be merged by a single author. In the last two incidents, the immediate cause was not lack of effort but lack of second-person review on risky assumptions: one migration had an untested rollback path, and one feature flag defaulted on for all tenants.
>
> The hard constraint is that production-impacting changes must have independent review of blast radius, rollback path, and observability before deployment.
>
> We considered lighter alternatives. Automated tests alone are insufficient because both recent failures passed tests. Optional review is insufficient because the riskiest changes are often made under time pressure, when optional safeguards are skipped. A blanket review policy for every repository change is too disruptive because it slows harmless changes and creates reviewer fatigue.
>
> Therefore, mandatory review is necessary only for production-impacting changes. The policy is proportionate because it targets the actual failure mode while excluding low-risk changes. We will review the policy after six weeks and measure deployment lead time, incident rate, and review backlog.

This is the right pattern: the strong justification narrows the policy, ties it to observed failure modes, rejects weaker options, and avoids overreach.

---

## 7. ChatGPT Prompt

Use this when you want ChatGPT to help justify a decision rigorously.

```text
You are helping me test and justify a decision. Do not treat the decision as necessary merely because I proposed it.

Decision to evaluate:
[Insert decision.]

Context:
[Insert relevant situation.]

My current reason for thinking this may be necessary:
[Insert reason.]

Your task:

1. Restate the decision precisely.
   - Clarify what is in scope and out of scope.
   - Identify whether the decision is broad, narrow, reversible, irreversible, temporary, or permanent.

2. Identify the protected objective.
   - What goal, value, duty, or constraint is this decision supposed to protect?
   - If the objective is vague, make that explicit.
   - Distinguish between goals, preferences, fears, and obligations.

3. Identify hard constraints.
   - Legal, technical, financial, operational, ethical, contractual, timing, organizational, or strategic constraints.
   - Separate genuine constraints from preferences.
   - State which constraints actually force action.

4. Build the causal chain.
   - Current condition → mechanism → consequence → goal failure → required intervention.
   - Point out any weak or missing links.

5. Generate alternatives.
   Include at least:
   - Do nothing.
   - Delay.
   - Partial or reversible action.
   - Cheaper option.
   - Safer option.
   - Less disruptive option.
   - Opposite strategy.
   - The proposed decision.

6. Compare alternatives using the same criteria.
   Criteria should include:
   - Goal satisfaction.
   - Constraint satisfaction.
   - Cost.
   - Risk.
   - Reversibility.
   - Time-to-impact.
   - Operational burden.
   - Second-order consequences.

7. Challenge the proposed decision.
   - What assumptions must be true for it to be necessary?
   - What evidence supports those assumptions?
   - What evidence would weaken or falsify them?
   - What motivated reasoning or post-hoc rationalization may be present?

8. Reject alternatives only with grounded reasons.
   For each rejected option, explain:
   - Which goal or constraint it fails.
   - What evidence shows the failure.
   - Whether the rejection is certain, probable, or speculative.

9. Apply a necessity and proportionality test.
   - Is the decision suitable for the goal?
   - Is it stronger than necessary?
   - Is there a less costly, less risky, less disruptive, or more reversible option?
   - Are the harms of the decision justified by the harms it prevents?

10. Classify the decision honestly.
   Use one of:
   - Necessary.
   - Conditionally necessary.
   - Prudent but not necessary.
   - Preferred but not necessary.
   - Insufficiently justified.
   - Probably unjustified.

11. Produce the final justification.
   The final justification must include:
   - Objective.
   - Constraints.
   - Evidence.
   - Causal chain.
   - Alternatives considered.
   - Why weaker options fail.
   - Consequences of not acting.
   - Trade-offs accepted.
   - Defeaters that would make the decision no longer necessary.

Important:
- Do not write generic persuasion copy.
- Do not flatter the decision.
- Do not conclude necessity unless the reasoning survives scrutiny.
- If the case is weak, say so directly and explain what evidence or analysis is missing.
```

## The shortest usable form

When you need the compact version, use this:

> A decision is necessary only if a valid objective will fail without it, a hard constraint or unacceptable risk forces action, the decision causally addresses the failure, weaker alternatives have been considered and shown insufficient, and the costs of the decision are proportionate to the consequences of inaction.

That sentence is the core method. Everything else is the machinery for proving it.

[1]: https://plato.stanford.edu/entries/practical-reason/?utm_source=chatgpt.com "Practical Reason - Stanford Encyclopedia of Philosophy"
[2]: https://www.justice.gc.ca/eng/csj-sjc/rfc-dlc/ccrf-ccdl/check/art1.html?utm_source=chatgpt.com "Charterpedia - Section 1 – Reasonable limits"
[3]: https://www.corteidh.or.cr/tablas/a63.pdf?utm_source=chatgpt.com "Constitutional Rights, Balancing, and Rationality*"
[4]: https://www.hup.harvard.edu/books/9780674931985?utm_source=chatgpt.com "Value-Focused Thinking"
[5]: https://sdg.com/decision-quality/?utm_source=chatgpt.com "Decision Quality – Welcome to SDG"
[6]: https://www.amazon.ca/Good-Strategy-Bad-Difference-Matters/dp/0307886239?utm_source=chatgpt.com "Good Strategy Bad Strategy: The Difference and Why It ..."
[7]: https://www.hbs.edu/faculty/Pages/item.aspx?num=14579&utm_source=chatgpt.com "Smart Choices: A Practical Guide to Making Better Decisions"
[8]: https://bihr.org.uk/get-informed/legislation-explainers/what-is-proportionality?utm_source=chatgpt.com "What is proportionality?"
[9]: https://www.oreilly.com/library/view/decision-quality/9781119144670/c02.xhtml?utm_source=chatgpt.com "Decision Quality [Book]"
[10]: https://www.researchgate.net/publication/51453002_Before_you_make_that_big_decision?utm_source=chatgpt.com "(PDF) Before you make that big decision..."
[11]: https://www.denkproducties.nl/media/daniel-kahneman-hbr-before-you-make-that-big-decision.pdf?utm_source=chatgpt.com "daniel-kahneman-hbr-before-you-make-that-big-decision. ..."
[12]: https://owl.purdue.edu/owl/general_writing/academic_writing/historical_perspectives_on_argumentation/toulmin_argument.html?utm_source=chatgpt.com "Toulmin Argument - Purdue OWL"
[13]: https://ndpr.nd.edu/reviews/argumentation-schemes/?utm_source=chatgpt.com "Argumentation Schemes - Notre Dame Philosophical Reviews"
[14]: https://assets.cambridge.org/97811070/08588/frontmatter/9781107008588_frontmatter.pdf?utm_source=chatgpt.com "ProPortionality"
[15]: https://collegepublishing.sagepub.com/products/a-practical-guide-for-policy-analysis-7-278664?utm_source=chatgpt.com "A Practical Guide for Policy Analysis"
[16]: https://yalebooks.yale.edu/book/9780300052596/evidence-argument-and-persuasion-in-the-policy-process/?utm_source=chatgpt.com "Evidence, Argument, and Persuasion in the Policy Process"
[17]: https://donellameadows.org/archives/leverage-points-places-to-intervene-in-a-system/?utm_source=chatgpt.com "Leverage Points: Places to Intervene in a System"
[18]: https://pubmed.ncbi.nlm.nih.gov/18159787/?utm_source=chatgpt.com "A leader's framework for decision making. ..."
[19]: https://link.springer.com/article/10.1007/BF01405730?utm_source=chatgpt.com "Dilemmas in a general theory of planning | Policy Sciences"
[20]: https://www.jstor.org/stable/973677?utm_source=chatgpt.com "The Science of \"Muddling Through\""
[21]: https://hbr.org/2007/09/performing-a-project-premortem?utm_source=chatgpt.com "Performing a Project Premortem"
