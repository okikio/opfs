Research and source register
============================

Research date: 2026-08-12.

Source priority
---------------

When sources disagree, use this order:

1. current standards and current upstream source contracts;
2. current `okikio/mediad` repository rules and current Kaiju Platform/Crawl architecture guides;
3. current package implementation and tests;
4. older experiments and secondary articles.

The old `okikio/testing-opfs` experiment was reviewed for intent only. It is not an implementation base.

Browser File System / OPFS
--------------------------

Primary standards and interoperability sources:

- WHATWG File System Standard: <https://fs.spec.whatwg.org/>
- WHATWG File System issues: <https://github.com/whatwg/fs/issues>
- Web Platform Tests File System suite: <https://wpt.fyi/results/fs>
- WPT interoperability issue supplied for review: <https://github.com/web-platform-tests/interop/issues/172>
- MDN Origin Private File System overview: <https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system>
- web.dev OPFS article: <https://web.dev/articles/origin-private-file-system>

Important design facts traced into code/tests:

- normal file/directory handle operations are asynchronous;
- synchronous access handle exposure is context/capability-specific and can hold native file locks;
- writable streams and sync files have explicit close/abort lifecycle;
- current portable OPFS does not provide the same universal native rename contract as a host filesystem;
- error names, locks, storage policy, private browsing, iframe partitioning, and `file:` documents contain interoperability details that must not be hidden by browser-name guessing.

Additional OPFS material supplied by the user and reviewed for behavior/performance context:

- <https://lapcatsoftware.com/articles/2026/5/5.html>
- <https://rxdb.info/rx-storage-opfs.html>
- <https://lofttools.com/blog/opfs-origin-private-file-system/>
- <https://barndoors.lumafield.com/3x-faster-project-loads-with-the-origin-private-file-system/>

These secondary/performance sources informed test cases and tradeoffs. They do not override the standard or current upstream contracts.

Deno standard filesystem
------------------------

- Deno standard library repository: <https://github.com/denoland/std>
- `@std/fs`: <https://jsr.io/@std/fs>
- current `fs/mod.ts`, `fs/walk.ts`, `fs/copy.ts`, and `fs/move.ts` source were reviewed.

Useful patterns retained:

- lazy tree walking;
- explicit overwrite behavior;
- source/destination overlap checks;
- bounded, understandable helper APIs.

Native-host assumptions deliberately not copied into OPFS/record adapters:

- symbolic links;
- host permission bits;
- OS path identity;
- portable timestamp mutation;
- universal native rename.

RxDB
----

- RxStorage guide: <https://rxdb.info/rx-storage.html>
- RxStorage interface: <https://github.com/pubkey/rxdb/blob/master/src/types/rx-storage.interface.d.ts>
- RxCollection implementation: <https://github.com/pubkey/rxdb/blob/master/src/rx-collection.ts>
- RxDocument type contract: <https://github.com/pubkey/rxdb/blob/master/src/types/rx-document.d.ts>

The integration point is `RxCollection`, while RxDB retains responsibility for the chosen RxStorage implementation, wrappers, replication, multi-instance behavior, conflicts, and licensing.

unstorage
---------

- repository: <https://github.com/unjs/unstorage>
- `src/types.ts` for `Storage` and `Driver` contracts
- generated `src/_drivers.ts` for current built-in driver inventory

The forward bridge targets `Storage`. The reverse bridge implements the stable Driver subset used by unstorage.

db0
---

- site: <https://db0.unjs.io/>
- repository: <https://github.com/unjs/db0>
- `src/types.ts` for Database/Statement/dialect contracts
- generated `src/_connectors.ts` for current connector inventory

The adapter targets `Database` and its reported SQL dialect, not a connector name.

Drizzle
-------

- repository: <https://github.com/drizzle-team/drizzle-orm>
- current package metadata and `drizzle-orm/src` driver/dialect tree
- SQLite core database/query builder source for the common CRUD shape

Drizzle schema and DDL remain caller-owned because they are dialect-specific. The integration uses a caller-supplied table and common select/insert/delete builders.

Mediad conventions
------------------

Current private repository reviewed through the connected GitHub source:

- `okikio/mediad/AGENTS.md`
- root workspace/package/TypeScript configuration
- `docs/` organization
- `packages/media/*` organization
- `packages/media/storage` source

Rules applied here include:

- one-word capability-oriented folders where practical;
- precise verbs;
- `Schema` suffix for Zod schema constants;
- `Type` suffix for project-owned data types;
- same core TypeScript source across runtimes;
- explicit runtime subpaths;
- caller-owned injected resources by default;
- TSDoc that explains examples, impact, ownership, limits, failure behavior, and necessary background.

Kaiju Platform and Crawl conventions
------------------------------------

The connected Library sources reviewed include:

- Kaiju Platform Programming Model
- library-first architecture guidebook
- Kaiju naming and folder structure guide
- Kaiju code formatting guide
- Kaiju readable Markdown / technical writing handbook
- Kaiju Platform package/service architecture handoff
- Kaiju Crawl architecture and capability alignment handoff

The project guidance used here includes:

- library-first composition;
- explicit resource ownership and disposal;
- import-safe capability packages;
- exact runtime-resource names instead of vague terms;
- focused public subpaths;
- lazy iterators and bounded active memory;
- `.agents/` for temporary Node validation when Deno/JSR are not available;
- authored documentation must explain how exports compose into real developer workflows.

Uploaded skill pack
-------------------

`skills(20260806-212711).zip` was reviewed before this refactor. Relevant software delivery references included:

- documentation requirements;
- comment/TSDoc requirements;
- TypeScript requirements;
- library architecture and packaging;
- Deno software packaging;
- storage/database design and Drizzle guidance.

The skill pack is a process/reference input. It is not copied into the package artifact.
