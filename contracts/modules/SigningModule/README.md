# SigningModule (§13)

This module exposes a read adapter: `getMessageSubjects(accountId)` returns `[subjects, threshold, subjectRevision]`, or an empty array for an unknown account. A registered account without a custom roster returns its custody address with threshold one. A missing or corrupt committed body faults; do not substitute custody on error. Install with empty data. The adapter never approves an operation.

To change signers, propose `[9, subjects, threshold]` to the installed standard governance module and confirm the original actions after 24 hours. Subjects identify verification scripts by raw HASH160 (20 bytes) or SHA-256 (32 bytes). A compressed public key is not a subject.

Verifiers call **the native core** directly: `isValidSignature(accountId, hash32, [4, validatorId, credentialGeneration, pairs])`. Built-in pairs are distinct `[verificationScript, signature64]` entries. The digest binds the caller, account, network, authority epoch and generation. The four-byte result is `1626ba7e` for acceptance or `ffffffff` for refusal. Forwarding the call through a different contract changes the signed caller.
