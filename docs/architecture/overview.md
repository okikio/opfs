Media architecture
==================

The media domain is decomposed into focused packages. A package owns one
capability and exposes an intentional API. Generic programming models remain in
`utils/`.

```text
@media/convert
    |-- @media/source
    |-- @media/inspect
    |-- @media/plan
    |-- @media/output
    `-- @media/task

@media/download
    |-- @media/source
    |-- @media/output
    `-- @media/task
```

The initial package files establish contracts and independently testable
operations. The application layer will be added after the library behavior and
performance characteristics are stable.
