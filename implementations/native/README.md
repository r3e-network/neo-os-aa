# Native AccountManagement implementation

This directory is the stable entrypoint for the native SmartAccount ABI 2
profile prepared for standard submission. The profile, native modules, SDK and
UI remain in their existing build-compatible locations; [`profile.json`](profile.json)
records the canonical roots and the native-only verification commands.

The native consensus `AccountManagement` service itself belongs to the matching
Neo core repository. This repository can validate the profile, modules, client,
fixtures and test-only VM probes, but it cannot claim hardfork activation,
node admission, formal refinement or public-network acceptance from those local
checks. The native track is currently draft/unactivated.
