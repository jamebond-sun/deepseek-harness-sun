# DeepSeek Harness learning and second-development path

English | [中文](project-learning-path.zh.md)

This tutorial is a staged route from a working checkout to designing, implementing, testing, and deploying DeepSeek Harness extensions. It uses the repository architecture, Cordis tutorials, package cookbooks, and deployment guidance.

## Summary

Study each phase until you can explain its data flow, ownership, failure path, and extension point. The route is designed for about twelve weeks at eight to ten hours per week.

## Table of Contents

- [How to use this tutorial](#how-to-use-this-tutorial)
- [The mental model](#the-mental-model)
- [Preparation and evidence rules](#preparation-and-evidence-rules)
- [Twelve-week curriculum](#twelve-week-curriculum)
- [Second-development ladder](#second-development-ladder)
- [Feature design checklist](#feature-design-checklist)
- [Deployment study](#deployment-study)
- [Completion standard](#completion-standard)
- [Further exploration](#further-exploration)

## How to use this tutorial

Read only the files named for the current phase, run the commands exactly, record observations, and answer the questions in your own words. Do not start by reading every package. Keep a journal with question, evidence, conclusion, uncertainty, and next experiment. Keep experiments in tmp or an isolated branch.

## The mental model

DeepSeek Harness is an all-plugin agent harness. A running application is a Cordis plugin tree assembled by a named profile and ordered bundle layers. Plugins contribute services, typed events, tools, model adapters, persistence, policies, and UI behavior through a shared context. Registrations are effects and are disposed with their owning plugin.

The dsh launcher selects profiles such as web, headless, sdk, sdk-minimal, and acp. Profiles select bundles; bundles provide patchable Cordis configuration. Profile, home, and command-line patches can replace configuration without editing implementation packages.

The agent loop coordinates model generation, tool dispatch, inbox work, cancellation, and lifecycle. New behavior normally belongs in a plugin, service seam, event listener, tool, or model adapter. The Session log is the durable source for model-visible facts, UI replay, SDK projections, and recovery. A new model-visible input must be reconstructable from Session events.

## Preparation and evidence rules

Before changing packages, read the architecture, defensive patterns, and the applicable package README. For Cordis, complete the primer and hands-on tutorial.

~~~sh
corepack enable
pnpm install
pnpm run typecheck
pnpm run test:docs
~~~

Run every command that claims an observable result in the current checkout. Commands requiring DEEPSEEK_API_KEY may skip without a key; a skip is not provider evidence. Do not reset pre-existing changes. Use git status, git diff, and an isolated branch for experiments.

## Twelve-week curriculum

### Week 1: TypeScript, Node.js, and the repository map

**Goal.** Explain ESM, TypeScript project references, pnpm workspaces, and source versus built artifact planes.

**Read.** Development guide, package map, AGENTS.md, package.json, pnpm-workspace.yaml, and the three TypeScript configuration faces.

**Run.** typecheck, build:artifacts, and build:check. Inspect one package source tree, output tree, configuration, and manifest.

**Observe.** Mark source files, generated files, Host and Client packages, and commands that consume each plane.

**Answer.** Why are Host and Client aggregate programs separate? Why do local TypeScript imports include .ts? Which file owns the runtime entry?

**Exercise.** Draw the path from apps/cli to one package and its direct dependencies.

### Week 2: Cordis fundamentals

**Goal.** Build the plugin lifecycle model.

**Read.** Cordis tutorial chapters 1 through 7 and the Cordis primer.

**Run.** Run each chapter from tmp/cordis-tutorial. Change one configuration value at a time.

**Observe.** Effects and event listeners are reversible; inject controls readiness; waterfall listeners call next.

**Answer.** Who owns a disposer? What happens when an injected service is unavailable? When should an impossible reference fail?

**Exercise.** Write a keyless plugin that registers a service, emits an event, and removes both on dispose.

### Week 3: Profiles, bundles, patches, and launch

**Goal.** Understand how packages become Web, headless, SDK, and ACP applications.

**Read.** Architecture profile and bundle sections, packages/boot, packages/bundle, and the configuration catalog.

**Run.** Execute dsh --profile web --dump-config. Compare it with bundle patch files. Start Web when a key is available.

**Observe.** Layers are ordered; a patch replaces a configuration entry or inserts one; supported applications start through dsh.

**Answer.** Which layer wins for one id? Why is sdk-minimal a separate tree? Which choices must be validated configuration fields?

**Exercise.** Change one non-secret setting through a local patch, dump the tree, and remove the patch.

### Week 4: CLI to Web startup

**Goal.** Trace one request from launcher to Client.

**Read.** apps/cli, boot/app-boot, host, client, apps/web, CLI help, and configuration catalog.

**Run.** Start Web, inspect browser network and terminal output, and compare configuration before and after a patch.

**Observe.** Host owns Node capabilities; Client owns browser rendering; RPC and Session events connect them.

**Answer.** Where is a fatal startup error reported? Which side owns filesystem access? What crosses the connection?

**Exercise.** Draw a sequence diagram with launcher, profile, Host, Client, Session, and provider.

### Week 5: Agent loop and turn lifecycle

**Goal.** Explain a turn as a state machine.

**Read.** core/agent, core/agent-loop, runtime context, and the agent lifecycle reference.

**Run.** Use keyless snapshots and loop tests. Compare normal completion, tool call, cancellation, and provider failure.

**Observe.** Work enters an inbox; the loop selects agent and model, streams chunks, dispatches tools, records results, and may continue.

**Answer.** Which events are durable facts? Who owns cancellation? When is a tool result visible to the next request?

**Exercise.** Annotate input, model request, stream, tool call, tool result, next request, and finish, including abort.

### Week 6: Session, replay, and persistence

**Goal.** Treat Session as a compatibility-sensitive append-only log.

**Read.** core/session, session packages, persistence packages, Session format status, and persistence catalog.

**Run.** Replay a keyless snapshot, inspect JSONL events, and restart to identify reconstructed state.

**Observe.** Reader compatibility, monotonic schema versions, and released-data rules govern changes. UI views derive from events and persisted metadata.

**Answer.** When is a format version required? What cannot be recovered unless logged?

**Exercise.** For one event, record producer, consumer, persisted fields, replay behavior, and missing-event failure.

### Week 7: Tools and execution policy

**Goal.** Build a model-callable tool with canonical output and replayable presentation.

**Read.** Tool cookbook, core/tools, tool pipeline reference, and first-tool tutorial.

**Run.** Build the tutorial tool keylessly. Trace schema, pre-execute, execute, post-execute, result, and abort signal.

**Observe.** Execute returns canonical JSON; render creates model-visible content; presentation metadata creates replayable UI facts; policy belongs in hooks or guards.

**Answer.** Why return structured data? Which failures become isError? What happens when a signal is already aborted?

**Exercise.** Implement a read-only observation tool and prove disposal removes it.

### Week 8: Model adapters and capability seams

**Goal.** Map provider protocols to one stable stream vocabulary.

**Read.** LLM adapter cookbook, llm packages, and capability seams.

**Run.** Inspect text, reasoning, tool arguments, usage, and finish chunks. Run adapter tests and focused provider e2e when credentials exist.

**Observe.** Adapters preserve order, raw JSON argument deltas, usage-before-finish, abort, unsupported-option errors, and replay state. A seam has Definition, Provider, and Consumer roles.

**Answer.** Which failures throw? Why is replay state explicit? When should roles be separate packages?

**Exercise.** Design a deterministic fake adapter and its ordering, abort, malformed-argument, and finish tests.

### Week 9: Web presentation and Client extensions

**Goal.** Add a user-visible capability without importing Host implementation into the browser.

**Read.** host, client, UI and responsive UI skills, and tool presentation guidance.

**Run.** Follow a Web card from Session event to Client component. Test loading, empty, error, narrow-width, and replay states.

**Observe.** Host presenters are pure; Web cards derive from events and metadata; copy is locale-owned; unsupported payloads fall back.

**Answer.** Which facts must be persisted for replay? Where is localized copy defined? What is the unknown-card fallback?

**Exercise.** Specify pending, success, error, and replay states with required fields.

### Week 10: Tests, snapshots, and gates

**Goal.** Select evidence without reflexively running the full suite.

**Read.** Testing policy, pre-push checks, nearby tests, and snapshots/AGENTS.md.

**Run.** Focused unit test, keyless snapshot test, build:artifacts, build:check, and test:docs.

**Observe.** Source-plane tests and artifact-plane checks answer different questions. Model-visible changes require recorded evidence; CI owns the exhaustive matrix.

**Answer.** Which check proves behavior, packaging, and documentation? Why fix fixtures instead of normalizers?

**Exercise.** Define the smallest check matrix for a tool change.

### Week 11: Packaging and reusable extensions

**Goal.** Turn an experiment into a maintainable package or profile overlay.

**Read.** Adding a package, extension patterns, package READMEs, and plugin publishing guidance.

**Run.** Compare service, tool, bundle, and Client packages. Run metadata, constraints, typecheck, lint, build, and README checks.

**Observe.** Boundaries follow independently evolving roles; configuration is validated; plugins, bundles, and libraries have different installation paths.

**Answer.** What belongs in a package README? When is an upgrade guide needed? Which dependencies are peer, runtime, or development-only?

**Exercise.** Write a package design note before creating files.

### Week 12: Deployment, operations, and a complete project

**Goal.** Deploy, measure, and deliver one extension end to end.

**Read.** Public deployment guide, bundle README, and error handling guidance.

**Run.** Follow the deployment guide linked below. Inspect logs, persistent directories, and memory. Deploy the extension in a disposable profile.

**Observe.** Build and runtime memory differ; persistent directories need backups; secrets need access controls.

**Answer.** What grows with concurrent Sessions? What survives application restart? Which failures are user-visible?

**Exercise.** Deliver an extension with README, tests, required replay evidence, profile patch, deployment smoke check, and rollback note.

## Second-development ladder

1. Observation plugin: listen to an event and write a bounded diagnostic record.
2. Simple tool plugin: register a read-only schema, output, render, and cancellation.
3. Policy plugin: add allow, deny, or ask decisions through tool hooks.
4. Profile overlay: change a bundle setting through a patch.
5. Context plugin: add model context backed by a Session fact.
6. Client presentation: add a replayable Web card.
7. LLM adapter: map a deterministic provider stream.
8. Persistence provider: store and restore Session data.

Every project needs a design page, source links, lifecycle diagram, failure table, focused tests, replay or snapshot evidence when model-visible, and a README.

## Feature design checklist

1. What user or model outcome changes?
2. Which extension point owns it?
3. Is this one package or independent Definition, Provider, and Consumer roles?
4. Which values are configuration, protocol constants, or security invariants?
5. Which facts reach a model request, and which Session event reconstructs them?
6. What happens during load, HMR, cancellation, disposal, restart, and replay?
7. What structured failure is reported, by whom, and what work stops?
8. How do Web, SDK, headless, and tests observe it?
9. What is the smallest meaningful test and documentation set?
10. Does a public entry point change and require an upgrade guide?

If one answer is missing, return to the owning architecture, subsystem, cookbook, or package README.

## Deployment study

Follow the [public deployment guide](user/guide/public-deployments.md) for Web access, authentication, trusted hosts, and TLS. Use the [development guide](development.md) for source build and launch instructions.

## Completion standard

You understand the project when you can explain dsh profile → bundle patch → Cordis plugin tree → agent loop → model adapter → tool pipeline → Session events → Host/Client projection, with a normal and failure path.

You are ready for second development when you can choose an extension point without editing the loop by default, define roles, state persistence and replay consequences, write a focused test plan, and ship a package or overlay that survives disposal, restart, and clean build.

You are ready to maintain production behavior when you can reproduce a bug from logs or a Session fixture, identify ownership, make a scoped change, run matching checks, and document an external break.

## Further exploration

- [Architecture](architecture.md)
- [Cordis primer](cordis-primer.md) and [Cordis tutorial](cordis-tutorial/index.md)
- [Development guide](development.md)
- [Testing policy](testing.md)
- [Adding a package](cookbook/adding-a-package.md)
- [Adding a tool](cookbook/adding-a-tool.md)
- [Adding an LLM adapter](cookbook/adding-an-llm-adapter.md)
- [Extension patterns](cookbook/extension-cookbook.md)
- [Subsystem reference](subsystems/README.md)

## Dev Note

This tutorial is a learning map, not a replacement for package contracts or generated references. When a command, default, or behavior changes, update the owning document and rerun documentation checks.
