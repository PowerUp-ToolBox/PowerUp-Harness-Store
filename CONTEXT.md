# Harness Store

A desktop platform (org: PowerUp) where users install and launch AI agent "harnesses" as standalone local apps, and where publishers share them. Every Harness reaches language models only through the platform's Model Gateway, so any Harness runs on any model the User has access to, including local ones.

## Language

### Core

**Harness**:
A self-contained runnable program, packaged with a Manifest, that delivers one concrete agent-powered function (e.g. a code reviewer) and owns its own agent loop and UI. A Harness launches as its own app and obtains model access exclusively through the Model Gateway.
_Avoid_: Agent, bot, app, plugin, extension, package (the archive is the "Harness Package")

**Harness Package**:
The archive a Publisher uploads: the Manifest plus the files needed to run the Harness on the declared platforms.
_Avoid_: Bundle, artifact, build

**Manifest**:
The single declarative file at the root of a Harness Package that names the Harness, versions it, and declares its entry point, platforms, UI kind, Model Requirements and Declared Permissions.
_Avoid_: Config, package.json, metadata

**Model Gateway**:
The local service run by the Runtime that accepts model requests from running Harnesses over one canonical protocol and forwards them to the User's chosen Provider. It is the only path from a Harness to any model.
_Avoid_: Middleware (the User's working name; too overloaded), proxy, router, broker

**Harness Version**:
One immutable published revision of a Harness, identified by semantic version. Users install Harness Versions, not Harnesses.
_Avoid_: Release, build

**Runtime**:
The local component of the desktop app that installs Harness Packages, launches and supervises Harness processes, opens their windows, and hosts the Model Gateway. It does not contain an agent loop.
_Avoid_: Engine, executor, daemon, launcher

**Store**:
The hosted service and its in-app surface where Harnesses are discovered, downloaded and published.
_Avoid_: Marketplace, registry, hub, catalog

### Running a Harness

**Harness ID**:
The globally unique name of a Harness, `publisher/slug`, where the publisher segment is the Publisher's GitHub username.
_Avoid_: Package name, app id

**Entry**:
The command the Runtime executes to start a Harness, declared in the Manifest (optionally per platform).
_Avoid_: Main, start script, binary

**UI Kind**:
How a Harness presents itself when launched: `web` (the Harness serves a local page that the Runtime opens in its own window) or `terminal` (the Runtime opens an embedded terminal running the Harness).
_Avoid_: Window type, mode

**Workspace**:
A folder the User picks at launch for a Harness that declares it needs one (e.g. the project a code reviewer should look at). Distinct from the Data Directory.
_Avoid_: Project, cwd, root

**Data Directory**:
A private folder the Runtime creates per installed Harness for its own state; deleted on uninstall. The Store never reads it.
_Avoid_: App data, storage, cache

**Channel**:
A release track for a Harness (`stable` in P0; `beta` reserved for P1). Users opt into non-stable Channels per Harness.
_Avoid_: Track, ring, tier

### People

**User**:
Anyone who runs the desktop app. In P0 a User is a technical person who already has their own model accounts.
_Avoid_: Customer, consumer, end user

**Publisher**:
A signed-in User who has uploaded at least one Harness to the Store. Publishing requires an account; installing does not.
_Avoid_: Developer, author, creator, seller

### Models

**Provider**:
A source of language models the Runtime can call: a remote API vendor (Anthropic, OpenAI, Google, OpenRouter) or a local server (Ollama, LM Studio, any OpenAI-compatible endpoint).
_Avoid_: Vendor, backend, LLM service

**Connection**:
A User's configured way of reaching one Provider: the credential (API key or local endpoint URL) plus its settings. Connections are stored only on the User's machine and are never exposed to a Harness.
_Avoid_: Account, subscription, integration, key

**Model Slot**:
A named role for a model inside a Harness (e.g. `default`, `fast`, `smart`), declared in the Manifest with its own Model Requirements. A Harness asks the Model Gateway for a Slot; the User decides which real model fills it.
_Avoid_: Model alias, role, profile

**Model Requirements**:
The capabilities a Model Slot declares it needs (e.g. tool calling, minimum context window, vision). The Runtime checks a User's Connections against them.
_Avoid_: Model spec, compatibility

**Slot Binding**:
The User's assignment of a concrete Provider + model to a Model Slot, either globally (for all Harnesses) or as a Model Override for one Harness.
_Avoid_: Mapping, routing rule

**Gateway Token**:
A one-time credential the Runtime issues to a Harness process at launch so the Model Gateway can attribute requests to that Harness. It expires when the process exits.
_Avoid_: API key, session key

**Recommended Models**:
An ordered list of model identifiers a Publisher may put in the Manifest. The Runtime uses the first one the User can reach as the initial choice; the User can always override it.
_Avoid_: Preferred models, supported models

**Default Model**:
The User's global Slot Binding for a Slot, used for any Harness that has no Model Override and no reachable Recommended Model for that Slot.
_Avoid_: Primary model, fallback

**Model Override**:
A per-Harness Slot Binding set by the User that takes precedence over Recommended Models and the Default Model.
_Avoid_: Per-app model

**Usage Record**:
A local, per-Harness, per-model tally of tokens consumed through the Model Gateway. Never leaves the User's machine in P0.
_Avoid_: Telemetry, metering, billing

### Store

**Featured**:
A Harness manually pinned by a Store administrator for prominent display. Not algorithmic.
_Avoid_: Trending, popular, promoted

**Unpublish**:
A Publisher's act of withdrawing a Harness Version from the Store. Existing local installs are untouched; the version can no longer be downloaded.
_Avoid_: Delete, remove, retract

**Takedown**:
A Store administrator's act of removing a Harness or Harness Version after a report or automated check. Distinct from Unpublish because the Publisher did not choose it.
_Avoid_: Ban, moderation, removal

**Report**:
A User-submitted flag on a Harness that queues it for administrator review.
_Avoid_: Flag, complaint

### Permissions

**Declared Permission**:
A capability a Harness states in its Manifest that it will use (filesystem paths, shell, network). In P0 Declared Permissions are shown for User consent at install time but are not enforced by a sandbox.
_Avoid_: Scope, capability, entitlement
