`@utils/pool`
=============

Purpose
-------

`@utils/pool` owns a bounded set of reusable values and lends them through
explicit disposable leases.

Use it for resources that are expensive to create but safe to reuse, such as
connections or host-specific runtime objects.  A domain package should still
name the actual resource it pools.  For example, a browser package can build a
`BrowserProcessPool` on top of this generic primitive.


How it fits
-----------

`@utils/context` supplies cancellation, deadlines, identity, and time.
`@utils/pool` uses that context while values wait, are created, are checked, and
are returned.

The package does not know how to create a browser, database connection, or
provider client.  The caller supplies `create`, `check`, and `close` behavior.


Ownership and admission
-----------------------

The pool enforces minimum and maximum size, optional idle limits, idle age, and
acquisition timeout.  Acquisition is FIFO when callers must wait.

A lease owns one borrowed value until disposal.  Returning the lease either
puts a healthy value back in the idle set or closes an invalid value.

Cancellation is checked while a value is being created.  If creation finishes
after the caller has cancelled, the pool closes that value instead of leaking
it.

Draining stops new acquisition, waits for active leases, and closes retained
values.  Close failures are collected without leaving waiters asleep forever.


Example
-------

~~~~ typescript
await using pool = await resourcePool.create({
  ctx,
  maximum: 8,
  create: createConnection,
  close: closeConnection,
});

await using lease = await pool.acquire(ctx);
await useConnection(lease.value);
~~~~

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

Ownership diagram
-----------------

~~~~ text
Pool
  | owns
  +--> idle value
  +--> idle value
  +--> leased value ---- Lease ----> caller borrows
  |                         |
  |                         `-- dispose -> return or close
  |
  `-- drain()
       +--> reject waiters
       +--> close idle values
       +--> wait for leases
       `--> finish disposal
~~~~

