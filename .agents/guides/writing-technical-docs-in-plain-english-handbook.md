Readable Markdown and plain technical English handbook
=============================================================

A Hongdown-inspired Markdown style with an ASD-STE100-inspired language layer.

Current cross-project authority: `engineering-standards.md`. This handbook remains the detailed STE/Hongdown reference when that writing mode is selected.


Default writing mode
--------------------

Use plain English for normal software documentation.

Apply ASD-STE100 or the controlled Simplified Technical English rules in this
handbook only when the user explicitly requests that writing mode, when a
project document explicitly opts into it, or when a formal requirement requires
it.

Without that explicit request, use the useful principles behind the standard,
such as precise terminology, short direct sentences, active voice, and one clear
meaning per term. Do not apply the controlled dictionary, formal word limits, or
full STE grammar restrictions by default.

This distinction matters because clear software documentation sometimes needs
ordinary English to explain architecture, tradeoffs, and unfamiliar concepts
without becoming mechanical or losing necessary nuance.

Authority when composed with skills
------------------------------------

The shared engineering base reference is the compact current engineering
baseline. This handbook provides selected writing depth; its historical examples
and formatting preferences do not override newer repository instructions or the
configured tool. Preserve current API names and the complete technical meaning.

Purpose
-------

This handbook explains how to write project documents that are easy to read in
two forms:

 -  as raw Markdown
 -  as rendered documentation

The handbook combines three types of guidance:

1.  Project documentation standards
2.  a complete paraphrased map of the ASD-STE100 Issue 9 writing rules
3.  Hongdown-inspired Markdown structure

These types of guidance do different jobs.

Project documentation standards decide what the document must explain.  They also
decide how the document must use evidence, examples, risks, alternatives, and
verification.

Simplified Technical English gives us useful sentence-level rules.  These rules
help us make technical text direct and clear.

Hongdown-inspired formatting makes the raw Markdown easy to scan.

Use this order of authority:

1.  The user's request
2.  Verified repository instructions and the selected current guidance
3.  The correct method for the document type
4.  The real behavior and evidence
5.  project terminology
6.  The plain technical English rules in this handbook
7.  The Markdown formatting rules in this handbook

A lower rule must not remove information that a higher rule requires.


Explain a change in its product and system context
---------------------------------------------------

Start a substantial PR or change explanation with a short summary: **what
changes, why it matters, and how it works**. Use concrete behavior, not a vague
claim of reliability. Surface a material required action or release limit early.
An experienced reader should understand the change without reading the background.
A new reader should then find the background needed to understand it in depth.
The prepare-pull-requests skill owns the PR workflow; this section
explains the reading order and how to make the background visible.

For example, a fictional alert PR could open with:

- **What:** draft alerts can use only display fields supported by the evaluator.
- **Why:** an invented field makes a draft unusable and wastes the drafting attempt.
- **How:** the model schema and evaluator derive field names from one shared table.

Then build understanding through product, usage and system levels. At product
level, use a concrete example to connect the goal, old failure and practical
consequence. At usage level, explain the customer steps and why operators or
developers need any new action. At system level, explain the owners, changed
contracts and failure paths. Finish with short review priorities and real evidence.
These levels are a useful progression, not mandatory headings for every edit.

If a user supplies an explanation that works, preserve its causal story as the
baseline and add only the missing context. Do not reduce it to terse feature
labels and code pointers merely to hit a word count. Do not require an onboarding
story, architecture tour, or large diagram before the opening. Links can provide
depth, but cannot replace the explanation needed to understand the change.

Within the background, move from a concrete user journey to the systems involved,
then to the changed part. Start at the earliest action that supplies important
inputs or permission. If onboarding establishes those inputs, include it there.
Do not attach an unrelated onboarding story to a local fix.

Keep a PR description short enough to scan. Use only the background needed for
this change; link to the deeper system explanation. Avoid repeating the same
facts under summary, mechanism, stakeholder, and diagram headings. Keep material
configuration changes and verification gaps visible.

The following are alternative views for this fictional alert product. Choose the
one that answers the reviewer's question; do not include all of them by default:

```text
Customer journey
Connect shop -> Confirm catalog -> Request draft [changed here]
             -> Review and activate -> Receive stock alert
```

The draft is a suggestion. Customer approval activates it. Accepted inventory
data later determines whether the alert condition is true.

```text
System ownership
Console -- confirmed settings --> Rule Service [authoring changed here]
Importer -- accepted inventory --> Rule Service [existing evaluation]
Rule Service -- drafts or evaluation results --> Console
```

These are illustrative names, not an assertion about a deployed integration.
A real description must check each owner and handoff against the affected source.

| Focus inside the changed step | Before | After |
| --- | --- | --- |
| Draft display fields | A model could name an unsupported field | The schema permits supported fields only |
| Missing inventory during later evaluation | Unknown | Still unknown; this PR changes authoring |

Each view answers a different question: where the user is, which systems do the
work, or what the PR changes. A compact PR usually needs only one, with other
necessary context in nearby prose or linked documentation.
Mark changed and existing parts with words, not color alone. Label important
arrows with the data they carry. Show approvals, failures, unknown results, or
cost boundaries when they change how a reader should interpret the result.
State whether the view describes implemented source, a plan, or verified live
behavior. A source diagram does not prove deployment.

Use short bullets for quick facts and actions. Use tables for stakeholder effects,
before/after behavior, and review priorities. Use prose for background and reasons.
Use diagrams where they make a relationship easier to understand than prose.
ASCII suits a small flow that is clear in raw Markdown; Mermaid suits a flow or
sequence whose layout adds clarity. Neither is mandatory or forbidden. Avoid wide
ASCII drawings and stacks of tall charts. Keep the causal explanation in nearby
prose and link to deeper architecture when needed. Check both scrolling burden
and narrow-screen readability when available. Judge readability and understanding,
not just word count or visual density.

Explain stakeholder impact explicitly. Customers, operators, developers, and
neighboring system owners can have different concerns. For each, connect their
task to the problem, the changed behavior, and why it matters to their work.
Explain the reason for a configuration action or review responsibility rather
than placing it beside an unexplained "effect" label. Separate new requirements
from existing duties. Use short role-based paragraphs when a table would hide
these causal links or require long cells on mobile.

For example: "Support staff investigate failed draft requests. A failure record
now distinguishes a refusal before dispatch from a provider failure. This tells
them which stage to investigate. Missing usage does not establish zero cost."
That explains the role, change, consequence, and limit together. "Operator: better
diagnostics; attention: billing" does not.

A concrete example must distinguish a suggestion from an approved action and
from evidence of a real-world fact.

End the explanation with a review route: the most important decision first, the
path or symbol that implements it, and the evidence that supports it. Keep test
scope and unverified release work visible. A short fix can cover this in a few
sentences; a cross-system change can use one compact flow plus an ownership
sentence and a link to deeper documentation.

A first-time reader should be able to explain the goal, prerequisites, surrounding
owners, changed behavior, and first review priority from the description alone.
If they cannot, add the missing background rather than more unexplained terms.


This is not full ASD-STE100 compliance
--------------------------------------

ASD-STE100 Simplified Technical English is a controlled language and an
international standard for technical documentation.

The current standard is Issue 9, which ASD released on January 15, 2025.  It
contains writing rules and a controlled dictionary.  The dictionary uses a
small set of approved general words.  It also permits approved technical nouns
and technical verbs for a company, industry, or subject.

This handbook does not claim that project documents comply with the full
ASD-STE100 standard.

Full compliance would require:

 -  the complete official standard
 -  its controlled dictionary
 -  a project terminology database
 -  trained writers or reviewers
 -  rule-by-rule validation

Instead, this handbook adopts the STE principles that best fit software and
technical documentation.

The official ASD material says that writers can apply principles such as short
sentences, one topic per sentence, and active voice outside maintenance
manuals.  It also warns that STE is not easy to write and that tools cannot
replace writer judgment.

That is the approach in this handbook.


ASD-STE100 Issue 9
==================

Issue 9 status
--------------

ASD released ASD-STE100 Issue 9 on January 15, 2025.

Issue 9 changed the publication from a specification to an international
standard.  Its subtitle is now *Standard for Technical Documentation*.

Issue 9 keeps 53 writing rules in nine sections.  ASD reports that more than
half of the rules received clearer wording.  It also reports changes to 555
dictionary entries.

Issue 9 uses the terms *technical noun* and *technical verb*.  These terms
replace or clarify older terminology.  The issue also adds two general
recommendations:

 -  inclusive language
 -  possessive forms

The complete official standard is available from ASD at no cost.  ASD
distributes it as a PDF after a user completes the request form.


How this handbook presents the rules
------------------------------------

The rule map below is a faithful paraphrase of the Issue 9 rule structure.

It is not a replacement for the official standard.  It does not reproduce the
controlled dictionary, the subject-field categories, all explanatory notes, or
the official examples.

Use the official PDF when:

 -  a contract requires ASD-STE100
 -  a customer requires formal compliance
 -  a safety document claims compliance
 -  a checker must use the controlled dictionary
 -  a reviewer must validate each rule
 -  the exact official wording affects a decision

Use this handbook when you need to apply the rules to software
documentation without claiming formal compliance.


The 53 Issue 9 writing rules
============================

Section 1: Words
----------------

### Rule 1.1: Use permitted word types

Use a word only when it is one of these types:

 -  a word approved in the STE dictionary
 -  a technical noun
 -  a technical verb

**Project use:** Keep an approved project terminology list.  Treat product names,
protocol names, API terms, runtime resources, and domain operations as technical
nouns or technical verbs when they meet the project rules.


### Rule 1.2: Use the approved part of speech

Use a dictionary word only as the part of speech that the dictionary approves.

A word approved as a noun is not automatically approved as a verb.

**Project use:** This rule is mandatory only for text that claims STE compliance.
For normal project documents, still check that a word has the intended grammatical
function.


### Rule 1.3: Use the approved meaning

Use an approved word only with its approved STE meaning.

Do not use a familiar word with a second, informal, or metaphorical meaning.

**Project use:** Prefer the meaning in the project terminology list.  Do not use one
common word for several unrelated system concepts.


### Rule 1.4: Use approved verb and adjective forms

Use only the forms that the dictionary approves for a verb or adjective.

**Project use:** Apply this rule only in formal STE-controlled text.  In all other
documents, avoid unusual forms that make the sentence difficult to parse.


### Rule 1.5: Use valid technical noun categories

Use a technical noun only when it belongs to an accepted subject-field category.

**Project use:** A technical noun must name a real software, product, business,
legal, operational, or web-observation concept.  Do not label a vague
architecture idea as a technical noun.


### Rule 1.6: Restrict words that are not in the dictionary

Use a word that is not approved only when it is a technical noun or part of a
technical noun.

**Project use:** Formal STE text needs this restriction.  Other project documents
can use general words outside the dictionary, but the writer must still prefer
short, common, precise words.


### Rule 1.7: Do not use technical nouns as verbs

Do not turn a technical noun into a verb.

Hard to read:

> Queue the route.

Clearer when `queue` is only a noun:

> Add the route to the queue.

**Project use:** A documented project operation can be a technical verb.  For
example, `capture`, `lease`, or `enqueue` can be valid when the project glossary
defines the operation.


### Rule 1.8: Use approved subject-field terminology

Use technical nouns that the company, industry, or subject field approves.

**Project use:** Source technical terms from:

 -  the project terminology list
 -  public API contracts
 -  package documentation
 -  standards
 -  protocol specifications
 -  accepted product terminology


### Rule 1.9: Prefer short and clear technical nouns

When several technical nouns are possible, select the term that is shortest and
easiest to understand.

Prefer:

> route lease

Avoid:

> temporary route exclusive-ownership allocation object


### Rule 1.10: Do not use regional language, slang, or jargon

Do not use a regional term, slang term, or insider expression as a technical
noun.

Avoid:

> spin up a box

Prefer:

> start a browser process


### Rule 1.11: Use one technical noun for one item

Do not use different technical nouns for the same item.

If the item is a `capture record`, do not later call the same item an `event`,
`payload`, or `artifact`.


### Rule 1.12: Use valid technical verbs

Use a technical verb only when it belongs to an accepted subject-field category
and accurately names the operation.

Use a common approved verb when it gives the same meaning.

**Project use:** Keep a small, reviewed list of domain verbs such as:

 -  capture
 -  extract
 -  detect
 -  lease
 -  enqueue
 -  upload
 -  reconcile


### Rule 1.13: Do not use technical verbs as nouns

Do not use a technical verb as a noun unless the project also approves a
separate noun form.

Hard to read:

> The capture starts after validation.

Clearer:

> Page capture starts after route validation.

In the second sentence, `page capture` is an explicit technical noun.


### Rule 1.14: Follow the required spelling system

Use American English spelling unless an official directive requires another
spelling system.

**Project use:** The project must select one official spelling policy.  Preserve
the spelling in existing documents during a narrow edit.  Do not create a large
formatting diff only to change spelling.


Section 2: Multi-word nouns
---------------------------

### Rule 2.1: Limit multi-word nouns to three words

A multi-word noun should contain no more than three words.

Hard to read:

> browser route capture failure recovery policy

Clearer:

> policy for failed route captures

**Project use:** Exact code symbols can contain more conceptual parts.  The prose
that explains the symbol must still be easy to parse.


### Rule 2.2: Explain long official technical nouns

When an official technical noun contains more than three words:

1.  Write its complete form first.
2.  Define a short form, or use hyphens to show which words form one unit.
3.  Use the approved form consistently.

Example:

> The *browser process readiness check* verifies startup state.  This handbook
> calls it the *readiness check* after the first definition.


Section 3: Verbs
----------------

### Rule 3.1: Use dictionary-approved verb forms

Use only the verb forms that the STE dictionary gives.

**Project use:** This is a formal-compliance rule.  Normal project documents must
still use standard, recognizable verb forms.


### Rule 3.2: Use simple approved tenses and forms

Formal STE permits these main forms:

 -  infinitive
 -  imperative
 -  simple present
 -  simple past
 -  simple future
 -  past participle used as an adjective

Avoid progressive, perfect, and other complex constructions in formal STE.

**Project use:** Prefer simple tenses.  Use another tense only when it is necessary
to express an exact event order or continuing state.


### Rule 3.3: Use the past participle as an adjective

Use a past participle as an adjective when it describes a noun.

Example:

> the completed capture record

Do not use the form to create an unnecessarily complex verb construction.


### Rule 3.4: Avoid complex auxiliary-verb constructions

Do not combine auxiliary verbs to create a long or complex verb phrase.

Hard to read:

> The process will have been waiting for the upload to complete.

Clearer:

> The process waits until the upload is complete.


### Rule 3.5: Restrict `-ing` verb forms

Use the `-ing` form of a verb only as a technical noun or as a modifier in a
technical noun.

Formal STE does not use progressive verb forms.

**Project use:** Keep established terms such as `billing`, `logging`, `routing`,
and `rendering` when they are approved technical nouns.  Rewrite an `-ing`
clause when it hides the actor or event order.


### Rule 3.6: Prefer active voice

Use active voice.

In descriptive text, use passive voice only when the actor is unknown.

Hard to read:

> The route is validated before it is added to the queue.

Clear:

> The CLI validates the route.  It then adds the route to the queue.


### Rule 3.7: Describe actions with verbs

Use a direct verb to describe an action.  Do not hide the action in a noun or
another part of speech.

Hard to read:

> Do an evaluation of the capture result.

Clear:

> Evaluate the capture result.


Section 4: Sentences
--------------------

### Rule 4.1: Write short and clear sentences

Use a sentence structure that makes the actor, action, object, condition, and
result easy to identify.

Each descriptive sentence should have one main topic.


### Rule 4.2: Do not remove necessary words

Do not omit words or use contractions only to make a sentence shorter.

Avoid in formal technical prose:

> can't

Use:

> cannot

Do not remove an article, subject, or object when the removal creates
ambiguity.


### Rule 4.3: Use vertical lists for complex text

Use a vertical list when one sentence contains several:

 -  items
 -  requirements
 -  options
 -  conditions
 -  results
 -  steps

The list must make the relationship between the items clear.


### Rule 4.4: Connect related sentences

Use a clear connecting word or phrase when two sentences contain related
topics.

Useful connectors include:

 -  then
 -  therefore
 -  because
 -  however
 -  as a result
 -  for this reason

Do not add a connector when the relationship is already clear.


### Rule 4.5: Use articles and demonstrative adjectives

When applicable, put `a`, `an`, `the`, `this`, or `these` before a noun or a
multi-word noun.

Use the word that makes the noun reference clear.

Example:

> Close the queue before you close the browser process.

The articles show that the sentence refers to specific resources already known
to the reader.


Section 5: Procedural writing
-----------------------------

### Rule 5.1: Use at most 20 words in a procedural sentence

A work-step sentence, warning, caution, or other safety instruction has a
maximum of 20 words in formal STE.

**Project use:** Apply this as a hard limit in text marked STE-controlled.  Use it
as a strong review limit for all new commands, procedures, and error-recovery
steps.


### Rule 5.2: Put one instruction in each sentence

Write one instruction in one sentence.

Two actions can remain together only when they occur at the same time or form
one inseparable action.

Weak:

> Validate the configuration, start the browser process, and check readiness.

Clear:

1.  Validate the configuration.
2.  Start the browser process.
3.  Wait for the readiness event.


### Rule 5.3: Use the command form

Write an instruction as a direct command.

Use:

> Create the route manifest.

Avoid:

> The route manifest should be created.


### Rule 5.4: Put a required condition first

When the reader must know a condition before doing the action, put the condition
at the start of the sentence.

Use a comma between the condition and the command.

Example:

> If validation succeeds, start the browser process.


### Rule 5.5: Use notes only for information

A note gives information.  A note must not contain an instruction.

Weak note:

> Note: Delete the old manifest first.

Correct procedure step:

> Delete the old manifest.

Useful note:

> Note: The new manifest uses the same output directory.


Section 6: Descriptive writing
------------------------------

### Rule 6.1: Give information gradually

Start with information that the reader needs first.

Add detail in a controlled order.

A common order is:

1.  identify the object
2.  state its purpose
3.  name its main parts
4.  explain how the parts work
5.  explain limits and failures


### Rule 6.2: Use key words and key phrases

Use repeated key terms to give the text a clear structure.

Do not replace a key term with a synonym only to create variety.


### Rule 6.3: Use at most 25 words in a descriptive sentence

A descriptive sentence has a maximum of 25 words in formal STE.

**Project use:** Apply this as a hard limit in STE-controlled text.  Use it as a
strong review limit in all new guidebooks, design notes, PRDs, and reviews.


### Rule 6.4: Group related information in paragraphs

Use paragraphs to show which sentences belong together.

Start a new paragraph when the subject or reasoning step changes.


### Rule 6.5: Use one topic in each paragraph

Each paragraph must explain one main topic.

A paragraph can contain a claim, evidence, explanation, and limitation when all
parts support the same topic.


### Rule 6.6: Limit a paragraph to six sentences

A descriptive paragraph has no more than six sentences in formal STE.

**Project use:** Use six sentences as the normal maximum.  Split the paragraph
earlier when the text changes topic, lifecycle stage, owner, or evidence class.


Section 7: Safety instructions
------------------------------

### Rule 7.1: Identify the level of risk

Use the risk word that the applicable safety system requires.

Examples can include:

 -  danger
 -  warning
 -  caution
 -  notice

Do not select a risk word only for visual emphasis.


### Rule 7.2: Start with a clear command or condition

A safety instruction starts with the action that prevents harm or the condition
that creates the risk.

Example:

> WARNING: Do not print an API key in a log.


### Rule 7.3: Explain the risk or result

State what can happen when the reader does not obey the safety instruction.

Example:

> WARNING: Do not print an API key in a log.  The log can expose the key to
> unauthorized users.


Section 8: Punctuation and word count
-------------------------------------

### Rule 8.1: Do not use semicolons

Formal STE permits standard English punctuation except the semicolon.

Replace a semicolon with two sentences or another clear structure.

**Project use:** Do not add semicolons to new technical prose.  Preserve
semicolons in code, exact quotations, generated output, and existing text during
a narrow edit.


### Rule 8.2: Use hyphens to show direct word relationships

Use a hyphen when two or more words form one modifier or one clear unit.

Examples:

 -  restart-safe workflow
 -  source-backed claim
 -  browser-process pool

Do not add a hyphen to an official term that does not use one.


### Rule 8.3: Use parentheses only for approved purposes

Formal STE permits parentheses for controlled purposes such as:

 -  references
 -  item identifiers
 -  step identifiers
 -  abbreviations
 -  singular and plural forms
 -  short explanations
 -  alternatives

**Project use:** Keep parenthetical text short.  Move required conditions,
warnings, and main explanations into normal sentences.


### Rule 8.4: Treat a list introduction as a sentence end

In formal STE word counting, a colon before a vertical list ends the sentence.

Each list item is counted separately according to the applicable rules.


### Rule 8.5: Count parenthetical text as one word

For formal STE sentence counts, text inside one pair of parentheses counts as
one word.

This is a counting rule.  It is not permission to hide long or important text
inside parentheses.


### Rule 8.6: Count specified fixed elements as one word

Formal STE counts each specified fixed element as one word.  These elements
include:

 -  numbers
 -  a number with its unit
 -  abbreviations
 -  alphanumeric identifiers
 -  quoted text
 -  titles, headings, placards, and labels
 -  proper names of persons, groups, organizations, and geopolitical entities


### Rule 8.7: Count a hyphenated group as one word

For formal STE counts, a hyphenated word group counts as one word.

Do not add unnecessary hyphens only to reduce the word count.


Section 9: Writing practices
----------------------------

### Rule 9.1: Rewrite the sentence when direct substitution fails

Do not replace one unapproved word with an approved word when the new sentence
has the wrong grammar or meaning.

Change the sentence structure instead.


### Rule 9.2: Use each approved word correctly

A word can be approved and still be incorrect in a specific sentence.

Confirm that the selected word has:

 -  the approved meaning
 -  the approved part of speech
 -  the correct sentence function


### Rule 9.3: Do not create unapproved phrasal verbs

Do not combine a verb and another word to create a phrasal verb unless the
combination is approved.

Hard to translate:

> spin up

Clear:

> start

Hard to translate:

> tear down

Clear:

> close and remove


### Rule 9.4: Keep terminology and wording consistent

Use the same term and the same sentence pattern for the same item, action, or
condition.

Consistency is more important than stylistic variety in technical text.


Issue 9 general recommendations
===============================

The general recommendations are not part of the 53 numbered rules.  They help a
writer prevent common errors.


GR-1: Use `that` when it clarifies a clause
-------------------------------------------

Use `that` when it clearly separates the main clause from the added
information.

Prefer:

> Make sure that the route is valid.

Avoid removing `that` when the removal makes the sentence harder to parse.


GR-2: Check each use of `with`
------------------------------

The word `with` can describe:

 -  association
 -  accompaniment
 -  a tool or method

Rewrite the sentence when the intended meaning is not clear.

Ambiguous:

> Start the browser with the proxy.

Possible clear forms:

> Start the browser that uses the proxy.

or:

> Use the proxy to start the browser.


GR-3: Give each pronoun a clear reference
----------------------------------------

Use a pronoun only when one noun can be its reference.

Repeat the noun when two possible references exist.


GR-4: Use `this` with a clear noun
----------------------------------

Prefer:

> This failure stops the upload.

Avoid:

> This stops it.

The noun after `this` tells the reader what the sentence refers to.


GR-5: Check false friends
-------------------------

A familiar-looking word can have a different meaning in another language.

Use reviewed terminology and common technical words.  Do not assume that a
cognate has the intended English meaning.


GR-6: Avoid Latin abbreviations
-------------------------------

Prefer English words.

Use:

 -  `for example` instead of `e.g.`
 -  `that is` instead of `i.e.`
 -  a complete list or `and other` instead of `etc.`

Preserve an abbreviation when it is part of an official name, exact quotation,
code value, or required external format.


GR-7: Use inclusive language
----------------------------

Issue 9 adds inclusive language as a general recommendation.

Use neutral and non-discriminatory words.

Use a gender-specific term only when sex or gender is necessary to the subject.

Prefer:

 -  operator
 -  maintainer
 -  administrator
 -  they
 -  the user
 -  the person

Avoid a default `he` or `she` for an unknown person.


GR-8: Use possessive forms carefully
------------------------------------

Issue 9 adds a recommendation for possessive forms.

A possessive form can be correct, but it can be difficult for some readers.

Use the possessive only when the relationship is clear.

Clear:

> the process state

Also clear:

> the state of the process

Potentially harder:

> the process's browser's state

Rewrite stacked possessives.


Optional project adoption profile
======================

Rules a project can adopt as strong defaults
-------------------------------------------

When the project selects this writing profile, apply these rules unless a
higher requirement calls for another form:

 -  1.8 through 1.11 for approved and consistent terminology
 -  2.1 and 2.2 for noun groups
 -  3.4 through 3.7 for simple and direct verbs
 -  4.1 through 4.5 for sentence clarity
 -  5.2 through 5.5 for procedures
 -  6.1 through 6.6 for descriptive text
 -  7.1 through 7.3 for safety and security instructions
 -  8.1 through 8.3 for punctuation and parenthetical text
 -  9.1 through 9.4 for correct and consistent wording
 -  GR-1 through GR-8


Rules that require formal STE controls
--------------------------------------

Apply these rules as formal compliance requirements only when the document is
explicitly STE-controlled:

 -  the complete controlled dictionary
 -  approved parts of speech
 -  approved dictionary meanings
 -  approved word forms
 -  the complete technical-noun categories
 -  the complete technical-verb categories
 -  the restricted tense system
 -  the strict 20-word procedural limit
 -  the strict 25-word descriptive limit
 -  the formal word-count rules
 -  American English spelling when no other directive exists

Normal project documents can use these rules as strong review guidance without
claiming compliance.


Text that keeps its exact form
------------------------------

Do not apply a language rewrite inside:

 -  source code
 -  shell commands
 -  configuration keys
 -  package and product names
 -  API symbols
 -  protocol fields
 -  URLs
 -  file paths
 -  logs
 -  serialized data
 -  quoted source text
 -  legal text that the writer cannot change
 -  safety text controlled by another approved authority

Explain exact text in plain technical English outside the exact region.


The main goal
-------------

A reader should not have to decode the sentence before they can understand the
system.

The text should make these points clear:

 -  who does the action
 -  what the action is
 -  what object the action changes
 -  when the action occurs
 -  what condition controls the action
 -  what result follows
 -  what can fail
 -  what the reader must do next

This goal applies to prose, examples, error messages, comments, and diagram
labels.


The three layers
================

Documentation method
--------------------

The documentation method controls the content.

It answers questions such as:

 -  Who is the reader?
 -  What does the reader need to do?
 -  What problem does the document solve?
 -  What evidence supports each claim?
 -  What risks must the document explain?
 -  What result proves that the work is complete?

A tutorial, a reference page, a PRD, and a decision note need different
structures.

Do not use sentence rules to force all documents into one structure.


Plain technical English
-----------------------

The language layer controls each sentence and each local explanation.

It helps the writer:

 -  use direct verbs
 -  name the actor
 -  remove ambiguous words
 -  split overloaded sentences
 -  put conditions before actions
 -  use one term for one concept
 -  reduce long noun groups
 -  make each instruction testable

This layer is the main correction to the previous handbook.


Markdown presentation
---------------------

The Markdown layer controls the visible source.

It helps the reader find:

 -  the title
 -  major sections
 -  local topics
 -  lists
 -  code
 -  tables
 -  warnings
 -  links
 -  examples

This layer makes the raw file feel complete.


Plain technical English
=============================

Use one main topic in each sentence
-----------------------------------

A sentence can contain related details.  It should not contain several separate
events or decisions.

Hard to read:

> The browser process starts after configuration is loaded, and route discovery
> can add more routes later, while analysis runs in another process and uploads
> can happen at the same time.

Easy to read:

> The collector loads and validates the configuration first.
>
> It then starts the browser process.
>
> Route discovery can add routes after capture starts.
>
> A separate analysis process reads completed capture records.
>
> Upload can run at the same time as analysis.

The second form is longer on the page.  It is easier to understand because each
sentence has one main topic.


Name the actor
--------------

The reader should know which person, process, thread, service, or module does
the work.

Hard to read:

> The route is added to the queue after validation.

Easy to read:

> The CLI validates the route.
>
> The CLI then adds the route to the route queue.

The passive sentence hides the actor.  The active sentences show who validates
the route and who adds it to the queue.

The passive voice can still be useful when the actor is unknown or does not
matter.

Example:

> The response body was damaged before the collector received it.

In this example, the writer does not know which system damaged the body.  The
passive voice does not hide useful information.


Use direct verbs
----------------

A direct verb makes the action easy to see.

Hard to read:

> The process performs the creation of a browser context.

Easy to read:

> The process creates a browser context.

Hard to read:

> The system makes a determination about route validity.

Easy to read:

> The system validates the route.

Hard to read:

> The worker carries out the processing of the record.

Easy to read:

> The analysis thread reads the record.

Prefer verbs such as:

 -  create
 -  start
 -  stop
 -  read
 -  write
 -  get
 -  parse
 -  validate
 -  resolve
 -  add
 -  remove
 -  send
 -  receive
 -  capture
 -  extract
 -  detect
 -  compare
 -  close
 -  retry

Do not replace a clear verb with a noun phrase.


Use one term for one concept
----------------------------

Choose one name for each important concept.

Do not use these words for the same resource:

 -  worker
 -  agent
 -  runner
 -  processor
 -  browser service

Use the exact name:

> browser process

Do not use these words for the same stored item:

 -  event
 -  item
 -  record
 -  message
 -  payload

Choose the correct term and keep it.

For example:

> A capture record contains one stored observation from a page.

After this definition, use `capture record` each time.  Do not later call the
same item an event or payload.

This rule is similar to the STE principle of one word for one meaning.  It also
matches the project naming guide.


Define technical terms with concrete behavior
---------------------------------------------

Software needs technical nouns and technical verbs.  Do not remove these terms
when they are correct.

Define the term when the reader first needs it.

Hard to read:

> The workflow uses durable commands to provide restart-safe execution.

Easy to read:

> A *durable command* is a command that saves its result.
>
> Before the workflow runs the command, it saves the command ID.  After a
> restart, the workflow reads the saved ID.  It does not run the command again
> if the command already saved a result.
>
> This rule prevents duplicate work after a restart.

The easy version keeps the technical term.  It explains the term with actions
that the reader can picture.


Put a condition before the action
---------------------------------

When a condition controls an instruction, write the condition first.

Hard to read:

> Close the browser process if the final capture record is durable.

Easy to read:

> If the final capture record is durable, close the browser process.

The reader sees the condition before the action.

Use this order for:

 -  safety conditions
 -  required state
 -  feature flags
 -  file existence
 -  retry limits
 -  permission checks
 -  completion checks

Example:

> If the route already has an active lease, do not add a second lease.

Do not put a long condition at the end of a long instruction.


Use the command form in procedures
----------------------------------

Tell the reader what to do.

Hard to read:

> The route manifest should be validated before the capture is started.

Easy to read:

> Validate the route manifest.
>
> If validation succeeds, start the capture.

Hard to read:

> A configuration file can then be created by the user.

Easy to read:

> Create the configuration file.

Use one action in each numbered step.

Weak step:

> Validate the configuration, start the browser process, and confirm that all
> listeners are ready.

Better steps:

1.  Validate the configuration.
2.  Start the browser process.
3.  Wait for the `browser.ready` event.
4.  Confirm that the required listeners are active.


Keep sentences short enough to parse
------------------------------------

The official STE standard has detailed sentence rules.  This handbook does not
copy those limits.

Issue 9 defines these formal limits:

 -  A procedural sentence has at most 20 words.
 -  A descriptive sentence has at most 25 words.
 -  A note in a procedure uses the descriptive limit.

For text that claims STE compliance, these are hard limits.

For other project documents, treat them as strong review limits.  First try to
split a long sentence.  Keep a longer sentence only when the split would make
the technical relationship less accurate or less clear.

Hard to read:

> The collector uses a browser-process pool so several domains can capture pages in
> parallel while each process remains disposable, which reduces shared crash
> risk but adds scheduling, readiness, recycling, and shutdown coordination.

Easy to read:

> The collector keeps several browser processes ready.
>
> The pool gives each domain to one process.
>
> If one process crashes, the other processes can continue.
>
> The collector can also replace a process that uses too much memory.
>
> The pool needs extra code for scheduling, readiness, replacement, and
> shutdown.

The easy version preserves the trade-off.  It does not compress the trade-off
into one sentence.


Do not create choppy text
-------------------------

Short sentences can still be poor.

Choppy:

> The collector starts a process.  It starts a browser.  It opens a context.  It opens a
> page.  It captures data.

Better:

> The collector starts one browser process.  That process starts a browser and opens a
> context for the domain.
>
> The context opens a page.  the project then captures the page data.

The better version groups actions that belong to one local event.

Use short sentences to reduce ambiguity.  Do not use them to remove useful
connections.


Avoid long noun groups
----------------------

A long noun group makes the reader work from right to left.

Hard to read:

> browser route capture failure recovery policy configuration

Possible meanings are not clear.

Easy to read:

> configuration for the policy that recovers failed route captures

Better, when the text names a real symbol:

> `RouteCaptureRecoveryPolicy` configuration

Another example:

Hard to read:

> production browser process startup readiness validation failure

Easy to read:

> a failure that occurs when the collector validates browser-process readiness during
> startup

Break the noun group into:

 -  a clear main noun
 -  a short modifier
 -  a clause that explains the relationship

Keep official code symbols unchanged.


Avoid abstract noun chains
--------------------------

Abstract nouns hide actions.

Hard to read:

> The implementation of route prioritization enables optimization of capture
> resource utilization.

Easy to read:

> The collector gives important routes a higher priority.
>
> The browser processes capture these routes first.
>
> This order reduces the time that important routes wait for a browser.

The easy version shows:

 -  the actor
 -  the action
 -  the object
 -  the result


Limit pronouns when the reference is not clear
----------------------------------------------

Hard to read:

> The browser process sends the record to the analysis process after it closes
> the page.

What closes the page?  The browser process, the analysis process, or the record?

Easy to read:

> The browser process closes the page.
>
> It then sends the capture record to the analysis process.

The pronoun `it` is now clear because only one actor appears in the previous
sentence.

Repeat the noun when two possible actors are present.


Avoid vague helper verbs
------------------------

Words such as `handle`, `manage`, `support`, and `process` often hide the real
action.

Hard to read:

> The service handles failures.

Easy to read:

> The service records the failure.
>
> It retries temporary network failures.
>
> It rejects invalid input without a retry.

Hard to read:

> The module manages browser resources.

Easy to read:

> The module creates browser processes.
>
> It assigns routes to those processes.
>
> It closes each process during shutdown.

Use a broad verb only when the broad behavior is the subject of the sentence and
the document defines its parts.


Use positive instructions when possible
---------------------------------------

Positive instructions tell the reader what to do.

Harder to use:

> Do not continue without checking the file.

Easier to use:

> Check the file before you continue.

Keep a negative instruction when the forbidden action is the important point.

Example:

> Do not print the API key in the log.

This negative form is clear and direct.


Make references explicit
------------------------

Avoid vague words such as:

 -  this
 -  that
 -  these
 -  it
 -  the above
 -  the following

Use them only when the reference is clear.

Hard to read:

> This causes it to fail.

Easy to read:

> The missing route source causes configuration validation to fail.

Hard to read:

> Use the above value.

Easy to read:

> Use the `routeLimit` value from the configuration example.


Control words that have many meanings
-------------------------------------

Some common technical words can mean several different things.

Examples include:

 -  run
 -  process
 -  check
 -  state
 -  service
 -  job
 -  task
 -  operation
 -  result
 -  issue
 -  error

Define the intended meaning or choose a more exact word.

Instead of:

> Run the worker.

Use:

> Start the analysis process.

Instead of:

> Check the route.

Use the exact action:

> Validate the route syntax.

or:

> Confirm that the route is reachable.

These instructions are not equivalent.  The exact verb matters.


Use `-ing` forms with care
--------------------------

ASD-STE100 usually restricts `-ing` forms because one form can act as a noun,
adjective, or verb.  An `-ing` clause can also hide the actor or the order of
events.

Hard to read:

> After validating the routes and starting the browsers, capturing begins.

The sentence does not say who validates, who starts, or what starts capture.

Easy to read:

> The CLI validates the routes.
>
> The browser pool then starts the browser processes.
>
> After all processes report readiness, the scheduler starts capture.

Do not ban every word that ends in `-ing`.

Some terms are established technical nouns:

 -  billing
 -  monitoring
 -  logging
 -  routing
 -  rendering

Use these terms when they are the correct project term.  Do not use an `-ing`
clause when a direct sentence is clearer.


Put important information in the main sentence
----------------------------------------------

Do not hide required information in parentheses.

Hard to read:

> Start the capture process (only after all listeners are active).

Easy to read:

> If all required listeners are active, start the capture process.

Use parentheses for short optional information.

Example:

> The CLI writes the file to the output directory (`./out` by default).


Write clear causes and results
------------------------------

Name the condition that creates the result.

Hard to read:

> The queue overflow caused a problem with analysis.

Easy to read:

> The analysis queue held more records than its configured limit.
>
> The queue rejected the next record.
>
> As a result, the project did not analyze that capture record.

The easy version gives the reader a causal chain.


Use exact quantities
--------------------

Avoid vague quantities when an exact value exists.

Hard to read:

> The retry can take a while.

Easy to read:

> The CLI waits 500 milliseconds before the second attempt.

Hard to read:

> The collector supports many routes.

Easy to read:

> This command accepts at most 500 routes.

If the value is configurable, name the default and the configuration key.


State time and order directly
-----------------------------

Hard to read:

> Analysis occurs later.

Easy to read:

> Analysis starts after the collector commits the capture record.

Hard to read:

> The process closes eventually.

Easy to read:

> The process closes after all active page contexts close or after the
> 30-second shutdown timeout expires.


Make uncertainty visible
------------------------

Do not hide uncertainty behind confident prose.

Hard to read:

> The server uses Adobe Commerce.

Easy to read:

> The collector observed the `x-magento-vary` cookie and Magento JavaScript modules.
>
> This evidence supports a Magento-family classification.
>
> The evidence does not identify the Adobe Commerce edition.

Use clear evidence labels:

 -  observed
 -  documented
 -  inferred
 -  proposed
 -  assumed
 -  unresolved
 -  verified


Plain technical English does not remove reasoning
=================================================

Keep the causal chain
---------------------

Simpler sentences must not remove the argument.

Compressed:

> We need a process pool for reliability and performance.

Clear:

> The collector must capture several domains at the same time.
>
> One browser process cannot isolate a crash from the other domains.
>
> A new process for every route would add too much startup time.
>
> A browser-process pool keeps several reusable processes ready.
>
> If one process fails, the project can replace that process without stopping the
> other captures.
>
> For these reasons, the pool is the least costly option that meets the
> concurrency and isolation requirements.

The clear version preserves:

 -  the goal
 -  the two rejected options
 -  the trade-off
 -  the reason for the choice


Keep trade-offs
---------------

Do not change this:

> The pool adds scheduling, readiness, and shutdown coordination.

to this:

> The pool is better.

The first sentence names the cost.  The second sentence hides it.

A clear decision must show both the benefit and the cost.


Keep technical detail when the reader needs it
----------------------------------------------

Plain English does not mean shallow English.

Weak simplification:

> The collector saves some browser data.

Clear technical text:

> The collector saves cookies, local storage, session storage, IndexedDB metadata, and
> cache entries for each page context.

The second form uses technical terms.  It is still clear because it names the
actual data.


Keep exact contracts
--------------------

Do not rewrite exact API or CLI contracts into approximate prose.

Weak:

> The command has some route options.

Clear:

> Supply one route source:
>
>  -  `--route`
>  -  `--routes-file`
>  -  `--route-manifest`

The reader can now act without guessing.


Document-specific use
=====================

Tutorials
---------

A tutorial teaches one successful path.

Use direct instructions.

Weak:

> A route manifest should now be created, after which it can be supplied to the
> browser command for processing.

Clear:

1.  Create a route manifest.
2.  Save the manifest as `routes.jsonl`.
3.  Run this command:

~~~~ bash
deno task cli browser detect --route-manifest routes.jsonl
~~~~

4.  Wait for the CLI to print `browser.ready`.
5.  Confirm that the output directory contains `capture.json`.

Explain the result after each important step.

Do not put several actions in one step.


How-to guides
-------------

Start with the exact outcome.

Example:

> Use this procedure to capture one domain and save a WACZ archive.

Then state the starting conditions:

> Before you start, confirm these conditions:
>
>  -  Deno 2 is installed.
>  -  Playwright browser files are installed.
>  -  The output directory is writable.

For each step, state:

 -  the action
 -  the exact command or input
 -  the expected result
 -  the condition for the next step


Reference documentation
-----------------------

Use short, exact descriptions.

Weak:

> This option provides management of the concurrency setting for browser process
> execution.

Clear:

> `processCount`
>
> The number of browser processes that the pool starts.
>
> Type: positive integer
>
> Default: `4`
>
> The pool rejects `0` and negative values.

Use the same term in the option name, description, examples, and error
messages.


Conceptual documentation
------------------------

Explain the parts with concrete actions.

Weak:

> The route queue is an orchestration abstraction for distributed capture work.

Clear:

> The route queue stores routes that are ready for capture.
>
> A browser process leases one route from the queue.  The lease prevents another
> browser process from capturing the same route at the same time.
>
> When capture finishes, the browser process completes the lease.  If the
> browser process stops before completion, the lease expires and the queue can
> offer the route again.

The reader can now picture the queue, the lease, and the failure behavior.


Troubleshooting guides
----------------------

Start with the symptom.

Example:

### The CLI says that no route source is configured

Cause:

> The command did not receive a route from the CLI, a configuration file, or a
> function call.

Correction:

> Supply one route source.

~~~~ bash
deno task cli browser detect --route https://example.com
~~~~

Verification:

> Run the command again.  The CLI must print the accepted route before it starts
> the browser process.

Do not write:

> Review your configuration and try again.

That instruction does not tell the reader what is wrong or how to fix it.


Error messages
--------------

An error message should answer these questions:

1.  What failed?
2.  Which input caused the failure?
3.  Why is the input invalid?
4.  Which values or formats are valid?
5.  What must the user do?
6.  What command or example shows the correct form?

Weak:

~~~~ text
Invalid option.
~~~~

Clear:

~~~~ text
Cannot parse --route-limit value "many".

Expected a positive integer.

Supported examples:
  --route-limit 50
  --route-limit 500

Remove the option to use the default value of 100.
~~~~

Keep the message direct.

Do not add internal implementation terms that the user cannot act on.


Decision notes
--------------

Use short sentences, but keep the full reasoning.

Example:

### Decision

Use a browser-process pool.

### Objective

The collector must capture several domains at the same time.  A crash in one browser
process must not stop all active captures.

### Options

1.  Use one browser process for all domains.
2.  Start a new process for every route.
3.  Keep several reusable browser processes in a pool.

### Comparison

One process has the lowest startup cost.  It also puts all captures in one
failure domain.

A new process for every route gives strong isolation.  Its startup cost is too
high when a domain has many routes.

A process pool keeps the startup cost low after the first processes start.  It
also lets the collector replace one failed process.

### Trade-off

The pool needs scheduling, readiness, replacement, and shutdown logic.

### Conclusion

Use the process pool.  It is the only option that meets both requirements
without adding startup cost to every route.


PRDs
----

Write behavior that a person can observe.

Weak:

> The system should support CSV export functionality.

Clear:

> An organization administrator can export usage records for one billing
> period.
>
> The product creates one CSV file.
>
> The file contains:
>
>  -  organization ID
>  -  event type
>  -  quantity
>  -  first event time
>  -  last event time
>  -  invoice status
>
> The export excludes deleted test workspaces by default.

State non-goals directly:

> This release does not include scheduled exports, S3 delivery, custom columns,
> or date ranges longer than 90 days.

Keep product success and delivery acceptance separate.


Architecture documents
----------------------

Use one view for one question.

Weak label:

> Worker

Clear label:

> Usage metering process
>
> Type: long-lived process
>
> Purpose: reads billable usage records and sends accepted quantities to Polar

Weak arrow:

> API -> Redpanda

Clear arrow:

> API process -> `api_usage_events` topic
>
> Publishes one billable usage record after the API classifies the request

Use short labels in the diagram.  Put the full explanation in the text or a
table.


Reviews
-------

Separate the observation from the conclusion.

Clear pattern:

> **Observed:** The browser process closes before the upload queue reports that
> all files are durable.
>
> **Consequence:** The domain can appear complete while an upload is still in
> progress.
>
> **Recommendation:** Keep the domain in the `finalizing` state until the upload
> queue reports success or a final failure.
>
> **Verification gap:** The current tests do not stop the process during the
> final upload.

This format makes the evidence easy to inspect.


Comments and TSDoc
------------------

Write the rule that the code must preserve.

Weak comment:

~~~~ typescript
// Close the queue.
await routeQueue.close();
~~~~

Clear comment:

~~~~ typescript
// Stop new route leases before you close browser processes.
// This order prevents a route from receiving a process during shutdown.
await routeQueue.close();
await browserProcessPool.dispose();
~~~~

Keep the comment short when the rule is local.

Move a long lifecycle explanation to a guide when it would hide the code.


Before-and-after examples
=========================

Example 1: Workflow restart
---------------------------

Hard to read:

> The coordinator records the current instruction before it starts external
> work.  After a restart, it reads that record and does not repeat a command that
> already produced a durable result.  This restart-safe behavior is the
> consistency guarantee.

Clear:

> Before the workflow runs a command, it saves the command ID.
>
> The command saves its result when it finishes.
>
> If the process restarts, the workflow reads the saved command ID and result.
> It does not run the command again.
>
> This rule prevents duplicate work after a restart.


Example 2: Browser readiness
----------------------------

Hard to read:

> Readiness means that the control channel is open, required browser instances
> have started, and all startup checks have passed.  It does not mean that any
> page has completed capture.

Clear:

> The browser process reports `ready` only after these events:
>
> 1.  The process opens the control channel.
> 2.  All required browser instances start.
> 3.  All startup checks pass.
>
> The `ready` state does not mean that a page capture is complete.


Example 3: Route lease
----------------------

Hard to read:

> A route can be discovered, scheduled, and later captured after it obtains an
> exclusive lease from the queue.

Clear:

> Discovery adds the route to the route queue.
>
> The scheduler can then select the route.
>
> Before capture starts, one browser process must lease the route.  The lease
> prevents another process from capturing the same route at the same time.


Example 4: Analysis and capture
-------------------------------

Hard to read:

> Separate analysis and upload processes can consume completed capture records
> without delaying new page capture.

Clear:

> The browser process writes each completed capture record to a queue.
>
> The analysis process reads records from that queue.
>
> The upload process can read the same completed records from its own queue.
>
> These processes do not need to wait for the browser process to finish the
> other routes.


Example 5: Decision justification
---------------------------------

Hard to read:

> Given the objective, constraints, evidence, and rejection of weaker
> alternatives, the process pool is conditionally necessary because it is the
> least disruptive option that satisfies concurrency and crash-isolation
> requirements.

Clear:

> The collector must capture several domains at the same time.
>
> A crash in one browser process must not stop the other captures.
>
> One browser process cannot isolate the crash.
>
> A new process for every route adds too much startup time.
>
> A browser-process pool meets both requirements.
>
> Use the pool while these concurrency and isolation requirements remain valid.


Example 6: Evidence claim
-------------------------

Hard to read:

> The observed storefront signals support a Magento-family classification but
> do not establish the exact Adobe Commerce edition or server-side package
> version.

Clear:

> The collector observed Magento JavaScript modules and the `x-magento-vary` cookie.
>
> This evidence supports a Magento-family classification.
>
> The evidence does not identify the Adobe Commerce edition.
>
> It also does not identify the server-side package version.


Example 7: Error correction
---------------------------

Hard to read:

> Configuration resolution failed because no route provider was available from
> the command line, configuration file, or function-level options.

Clear:

> The collector cannot find a route source.
>
> You did not supply a route in:
>
>  -  the CLI arguments
>  -  the configuration file
>  -  the function options
>
> Supply one route source and run the command again.


A sentence review method
========================

Use this method for each difficult sentence.

Step 1: Find the actor
----------------------

Ask:

> Who or what does the action?

If the sentence does not answer, add the actor.

Before:

> The record is validated.

After:

> The analysis process validates the record.


Step 2: Find the action
-----------------------

Ask:

> What does the actor do?

Replace abstract noun phrases with a direct verb.

Before:

> The process performs validation of the record.

After:

> The process validates the record.


Step 3: Find the object
-----------------------

Ask:

> What does the action change, create, read, or remove?

Before:

> The process validates it.

After:

> The process validates the capture record.


Step 4: Find the condition
--------------------------

Ask:

> What must be true before the action can occur?

Put that condition first.

Before:

> Start capture when all processes are ready.

After:

> When all browser processes are ready, start capture.


Step 5: Find the result
-----------------------

Ask:

> What changes after the action?

Before:

> Complete the lease.

After:

> Complete the route lease.  The queue can then remove the route from the active
> lease set.


Step 6: Split extra topics
--------------------------

Underline each separate action, condition, result, or contrast.

If a sentence has several unrelated underlined parts, split it.


Step 7: Check each term
-----------------------

Ask:

 -  Does this word have one clear meaning here?
 -  Did the document use a different term for the same concept?
 -  Is this a project technical noun or technical verb?
 -  Did the document define it?
 -  Is a shorter and more common word equally precise?


Step 8: Read without the surrounding paragraph
-----------------------------------------------

The sentence should remain clear enough that a reviewer can understand its local
meaning in a diff.

It does not need to repeat all earlier context.


A paragraph review method
=========================

A paragraph can contain several sentences.  The sentences must support one local
reasoning step.

Use this pattern when it fits:

1.  State the subject.
2.  Give the key fact or action.
3.  Explain the result.
4.  Add the limitation or contrast.

Example:

> The route lease gives one browser process temporary ownership of a route.  The
> queue does not offer that route to another process while the lease is active.
> If the process stops, the lease expires.  The queue can then offer the route
> again.

Do not force each paragraph into this exact shape.

A procedure, warning, definition, and decision paragraph have different needs.


Markdown structure
==================

Heading hierarchy
-----------------

Use these heading forms for new long-form Markdown:

1.  Setext `=` for the document title
2.  Setext `-` for major sections
3.  ATX `###` for focused subsections
4.  ATX `####` only for necessary cases

Example:

~~~~ markdown
Example route capture guide
=========================

Capture lifecycle
-----------------

### Browser-process readiness

#### Failure before readiness
~~~~

A heading must help the reader find a real subject.

Do not add headings such as:

 -  Details
 -  More
 -  Notes
 -  Other
 -  Why
 -  Information

Use the exact subject instead.


Spacing
-------

For new long-form Markdown:

 -  Use one blank line between normal blocks.
 -  Use one blank line around lists, tables, quotes, and code.
 -  Use two blank lines before a major H2 section.
 -  End the file with one newline.

Do not reformat an existing file when the user asks for a small content change.


Line length
-----------

Use approximately 80 display columns for normal prose.

Do not split:

 -  URLs
 -  package names
 -  file paths
 -  commands
 -  inline code
 -  identifiers
 -  hashes
 -  exact data

The sentence rules control meaning.  The line-width rule controls only the
source display.


Lists
-----

Use the Hongdown-inspired list form:

~~~~ markdown
 -  First item
 -  Second item
 -  Third item
~~~~

Align continuation lines:

~~~~ markdown
 -  A browser process owns browser instances and reports their state through the
    control channel.
 -  An analysis process owns analysis threads and reads completed capture
    records.
~~~~

Use the same grammar in each item.

Do not mix nouns, commands, and sentence fragments in one list.


Code
----

Use inline code for exact technical text.

Use four-tilde fences for multi-line examples:

~~~~~ markdown
~~~~ typescript
const result = await capture.page({ route, browserContext, archiveWriter, signal });
~~~~
~~~~~

Add a language name.

Before each block, tell the reader what the block shows.

Do not put the main explanation only in code comments.


Links
-----

Use link text that names the destination.

Prefer:

> Read the [browser lifecycle guide].

Avoid:

> Click [here].

Move a long external URL to a reference definition when the URL makes the source
hard to read.

Keep a short relative path inline when the path helps the reader identify the
destination.


Tables
------

Use tables for exact comparison or mapping.

Keep each cell short.

Use full sentences outside the table when a row needs a detailed explanation.

Example:

| State | Meaning |
| ----- | ------- |
| `starting` | The process is creating required resources. |
| `ready` | The process can accept capture work. |
| `closing` | The process rejects new work and closes owned resources. |
| `closed` | The process has released all owned resources. |


Warnings
--------

Use a warning when the reader can cause data loss, unsafe behavior, a security
problem, or an invalid result.

~~~~ markdown
> [!WARNING]
> Do not mark the domain complete until all required uploads are durable.
~~~~

State the forbidden action and the reason.

Do not use a warning for normal background information.


Quality checks
==============

Sentence checks
---------------

 -  Each sentence has one main topic.
 -  The actor is clear.
 -  The main verb is direct.
 -  The object is clear.
 -  A required condition appears before the action.
 -  The sentence does not hide actions in abstract nouns.
 -  A pronoun has one clear reference.
 -  The sentence does not contain a long noun group.
 -  The sentence uses the established project term.
 -  An exact quantity replaces a vague quantity when possible.
 -  Uncertainty is visible.
 -  The sentence is short enough to parse.


Procedure checks
----------------

 -  Each step has one action.
 -  The step uses the command form.
 -  Conditions appear before actions.
 -  The expected result is clear.
 -  The reader knows when to continue.
 -  Failure correction is actionable.
 -  Commands and values are exact.


Concept checks
--------------

 -  The document explains what the concept does.
 -  The document explains why the concept exists.
 -  The document names the owner.
 -  The document names the input and output.
 -  The document explains important state changes.
 -  The document explains failure and recovery.
 -  The technical term has a concrete definition.


Decision checks
---------------

 -  The objective is clear.
 -  The current condition is clear.
 -  The causal chain is complete.
 -  Hard constraints are separate from preferences.
 -  The document compares real alternatives.
 -  The document explains why weaker options fail.
 -  The document states the accepted cost.
 -  The document states what evidence would change the decision.
 -  The conclusion does not claim more than the evidence supports.


Markdown checks
---------------

 -  The title is easy to find.
 -  Major sections are easy to find.
 -  Headings name real subjects.
 -  Lists have parallel grammar.
 -  Code blocks declare a language.
 -  Tables remain readable in plain text.
 -  Warnings are rare and direct.
 -  Long URLs do not interrupt prose.
 -  The raw file remains readable in a terminal and a diff.


Final rule
==========

Use Simplified Technical English as a source of sentence-level discipline.

Do not use it as a reason to remove:

 -  technical detail
 -  evidence
 -  trade-offs
 -  causal reasoning
 -  failure behavior
 -  uncertainty
 -  project terminology
 -  document-specific structure

A good technical sentence should let the reader answer:

> Who does what, under which condition, and with which result?

A good technical document should let the reader answer:

> What is this, why does it matter, how does it work, what can fail, and how do
> I know the result is correct?

Hongdown-inspired Markdown then makes those answers easy to find in the raw
file.


Sources
========

This handbook includes a paraphrased map of all 53 writing rules in
ASD-STE100 Issue 9.  It also adapts the eight Issue 9 general recommendations
for software documentation.

The rule map is not the official wording and does not replace the official
standard or its controlled dictionary.

 -  ASD-STE100 official website:
    https://www.asd-ste100.org/
 -  About ASD-STE100:
    https://www.asd-ste100.org/about_STE.html
 -  Official FAQ:
    https://www.asd-ste100.org/STE_faq.html
 -  Official tools guidance:
    https://www.asd-ste100.org/STEsoftware.html

Request the current official standard from ASD before claiming formal
ASD-STE100 compliance.
