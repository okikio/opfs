# Installed package verification sources

Read [Verify the installed package](../../docs/package.md) for the complete workflow, fixture owners, native discovery,
declaration environments and cleanup contract. That guide is included in the published package.

`verify.ts` remains the command entrypoint. `consumer/` holds the real programs copied into its temporary install, and
`fixtures/` projects the retained producer data. Add scenarios through those owners; native tools discover their files.
