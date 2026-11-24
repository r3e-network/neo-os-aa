# ThresholdPolicyModule (§15)

A basic account receives and sends funds without this module. To require multiple approvals, configure the recovery authority and install the standard recovery seat first. Install one standard member validator instance per distinct signing key. Choose a threshold of at least two if two independent signatures are required.

Submit `[7, 0, threshold, memberIds, true]` as the final action in a standard governance proposal and confirm after 24 hours. Once enrolled, all spending must use the allocated policy ID. Neither custody nor governance can reopen basic transfers or change members. To restore the basic account, start a fresh recovery and wait for its preset delay.

Use `getThresholdPolicy(accountId, 0)` to discover the active policy. It returns `[]` or `[threshold, memberIds, active, credentialGeneration, policyId]`. With a positive policy ID the response has the first four fields, or is empty for an unknown ID. Installation takes empty data.

Sign the operation for the policy ID. Supply a serialized list of `[memberId, signatureBytes]` in ascending member ID order, with empty bytes for absent signatures. Approvals share one validation budget. Only approving members receive completion callbacks.
