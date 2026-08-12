`@utils/email`
==============

Purpose
-------

`@utils/email` normalizes email domains and returns independent evidence about
public mailbox providers, privacy relays, and disposable domains. It performs
no network, DNS, filesystem, database, or framework I/O.

How it fits
-----------

Import or lead logic can use this evidence when it decides whether an email
address can identify a company domain. The package does not make that product
decision itself.

Runtime-neutral email-domain utilities. The package performs no network, DNS,
filesystem, database, or framework I/O.

```text
email or hostname
      |
      v
normalization ----------> invalid / unknown
      |
      v
provider rules + disposable parent matching
      |
      v
independent evidence: public-mailbox, privacy-relay, disposable
```

Why evidence is multi-trait
---------------------------

| Trait | Meaning | Typical extraction policy |
| --- | --- | --- |
| `public-mailbox` | Provider-operated consumer mailbox | Exclude as a company domain |
| `privacy-relay` | Stable or masked forwarding identity | Exclude as a company domain, do not call disposable |
| `disposable` | Known temporary or abuse-prone domain | Exclude and let product policy decide whether to block |

Custom domains used with SimpleLogin, Proton Pass, addy.io, or self-hosted relay
software cannot be proven from the domain alone. An unmatched domain is therefore
`unknown`, never automatically `corporate`.

Disposable snapshot refresh
---------------------------

`data/disposable.ts` records repository, commit, blob, retrieval date, and
license. Refresh it as one reviewed change from
`disposable_email_blocklist.conf`, preserving lowercase sorting and duplicates
removal. The generated utility must remain plain TypeScript data so browser,
Deno, Node, edge, worker, and test runtimes receive identical behavior.

Progressive usage
-----------------

The package participates in the complete domain-enrichment example in
`docs/implementation/utils-progressive-usage.md`.  Read that guide when the
individual helpers make sense in isolation but their place in a service,
resource graph, runtime host, or workflow is not yet clear.

`API.md` is the exhaustive public-surface map for this package.  It lists every
package export target, explains each exported name, gives a compact use form,
and expands every detected repository use into a source-backed TypeScript
snippet.  An export with no current consumer stays labelled as unproven instead
of receiving an invented production example.

