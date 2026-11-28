# Bind the method to the project

A profile records the project's selected contracts. It keeps an example's runtime, provider or package choice from becoming an accidental requirement elsewhere.

Skills: `plan-changes`.

Use the [generic profile](generic.md) by default. Fill the [project profile](project.md) only where current repository instructions or accepted decisions require a concrete choice. Reuse an existing project contract instead of creating a second record.

The folder name, origin of a guide or presence of a dependency does not select a profile. A profile must name the actual supported outcome, tools, hosts and owners. Version-sensitive facts come from current source, installed dependencies and primary documentation.

Changes to a profile can affect consumers, tests, deployment, recovery and acceptance evidence. Trace those effects before applying a new requirement to existing work.
