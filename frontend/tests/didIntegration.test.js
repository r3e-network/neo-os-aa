import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHandler as createDidNotifyHandler } from "../api/did-notify.js";

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    json(value) {
      this.payload = value;
      return this;
    },
  };
}

const frontendRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (relativePath) =>
  fs.readFileSync(path.join(frontendRoot, relativePath), "utf8");

// Markup from a parent SFC was extracted into colocated child components living
// in a sibling folder named after the parent (e.g. `DidIdentityPanel.vue` ->
// `DidIdentityPanel/*.vue`). This helper reads the parent file plus every
// colocated child so source-text contract assertions still check the real
// current location of the asserted markup.
const readComponentTree = (relativeVuePath) => {
  const parentVuePath = path.join(frontendRoot, relativeVuePath);
  const sources = [fs.readFileSync(parentVuePath, "utf8")];
  const childDir = parentVuePath.replace(/\.vue$/, "");
  if (fs.existsSync(childDir) && fs.statSync(childDir).isDirectory()) {
    for (const entry of fs.readdirSync(childDir).sort()) {
      const childPath = path.join(childDir, entry);
      if (fs.statSync(childPath).isFile()) {
        sources.push(fs.readFileSync(childPath, "utf8"));
      }
    }
  }
  return sources.join("\n\n");
};

test("did service integrates Web3Auth as the NeoDID identity root", () => {
  const source = read("src/services/didService.js");

  assert.match(source, /@web3auth\/modal/);
  assert.match(source, /new modal\.Web3Auth/);
  assert.match(source, /authenticateVerifiedDid\(client, this\.verifyProfile\)/);
  assert.doesNotMatch(source, /decodeJwtClaims|buildDidProfile|buildStableDidKey/);
  assert.match(source, /buildNeoDidSubject/);
  assert.match(source, /didVerificationEndpoint/);
  assert.match(source, /this\.persist\(null\)/);
});

test("morpheus did service can bind DIDs and invoke AA verifier requests", () => {
  const source = read("src/services/morpheusDidService.js");
  const proxy = read("api/morpheus-neodid.js");
  const keyProxy = read("api/morpheus-oracle-public-key.js");

  assert.match(source, /bindDid/);
  assert.match(source, /resolveDid/);
  assert.match(source, /previewRecoveryTicket/);
  assert.match(source, /previewActionTicket/);
  assert.match(source, /previewZkLoginTicket/);
  assert.match(source, /invokeRecoveryRequest/);
  assert.match(source, /invokeProxySessionRequest/);
  assert.match(source, /finalizeRecovery/);
  assert.match(source, /cancelRecovery/);
  assert.match(source, /revokeProxySession/);
  assert.match(source, /zklogin_verifier_params_hex/);
  assert.match(source, /fetchVerifierContractByAddress/);
  assert.match(source, /fetchAccountMaintenanceState/);
  assert.match(source, /hasPendingVerifierCall/);
  assert.match(source, /getPendingHookCallTime/);
  assert.match(source, /hex\.length === 40 \|\| hex\.length === 64/);
  assert.match(source, /pendingVerifierCall/);
  assert.match(source, /pendingHookCall/);
  assert.match(source, /fetchUnifiedVerifierState/);
  assert.match(source, /requestRecoveryTicket/);
  assert.match(source, /requestActionSession/);
  assert.doesNotMatch(source, /from ['"]@\/services\/didService['"]/);
  assert.match(source, /connectedDidProfile/);
  assert.match(proxy, /Unsupported Morpheus NeoDID action/);
  assert.match(proxy, /normalized === 'resolve'/);
  assert.match(keyProxy, /oracle\/public-key/);
});

test("notification service supports email and sms webhook delivery", () => {
  const source = read("src/services/notificationService.js");
  const apiSource = read("api/did-notify.js");

  assert.match(source, /sendRecoveryEmail/);
  assert.match(source, /sendRecoverySms/);
  assert.match(source, /connectedDidProfile/);
  assert.match(source, /idToken/);
  assert.doesNotMatch(source, /x-api-key/);
  assert.match(apiSource, /DID_EMAIL_WEBHOOK_URL/);
  assert.match(apiSource, /DID_SMS_WEBHOOK_URL/);
  assert.match(apiSource, /channel === 'email'/);
  assert.match(apiSource, /channel === 'sms'/);
  assert.match(apiSource, /jwtVerify/);
  assert.match(apiSource, /idToken is required/);
  assert.doesNotMatch(apiSource, /DID_NOTIFY_API_KEY/);
});

test("did verification api validates Web3Auth tokens against JWKS", () => {
  const source = read("api/did-verify.js");

  assert.match(source, /createRemoteJWKSet/);
  assert.match(source, /jwtVerify/);
  assert.match(source, /WEB3AUTH_JWKS_URL/);
  assert.match(
    source,
    /WEB3AUTH_CLIENT_ID \|\| process\.env\.VITE_WEB3AUTH_CLIENT_ID/,
  );
  assert.match(source, /provider:\s*'web3auth'/);
});

test("main layout and home workspace expose a DID connection path", () => {
  const layout = read("src/components/layout/MainLayout.vue");
  const controls = read("src/components/layout/ConnectionControls.vue");
  const workspace = read(
    "src/features/operations/components/HomeOperationsWorkspace.vue",
  );
  // Maintenance / pending-state markup was extracted into colocated
  // DidIdentityPanel/*.vue child components, so scan the full component tree.
  const panel = readComponentTree(
    "src/features/operations/components/DidIdentityPanel.vue",
  );
  const identityView = read("src/views/IdentityView.vue");
  const router = read("src/router/index.js");

  assert.match(layout, /defineAsyncComponent/);
  assert.match(layout, /ConnectionControls/);
  assert.match(controls, /Open Identity/);
  assert.match(controls, /Disconnect Web3Auth/);
  assert.match(controls, /connectedDidProfile/);
  assert.match(controls, /hydrateConnectedDidProfileFromStorage/);
  assert.match(controls, /await import\(["']@\/services\/didService["']\)/);
  assert.match(workspace, /useDidConnection/);
  assert.match(workspace, /didConnection/);
  assert.match(workspace, /connectDid\(/);
  assert.match(workspace, /Open Identity Workspace/);
  assert.match(identityView, /Web3Auth \/ NeoDID Workspace/);
  assert.match(identityView, /DidIdentityPanel/);
  assert.match(identityView, /route\.query\.accountId/);
  assert.match(identityView, /route\.query\.recoveryVerifier/);
  assert.match(identityView, /route\.query\.autoPreviewRecovery/);
  assert.match(panel, /accountIdPrefill/);
  assert.match(panel, /recoveryVerifierPrefill/);
  assert.match(panel, /autoPreviewRecovery/);
  assert.match(panel, /previewRecoveryAction/);
  assert.match(router, /path: 'identity'/);
  assert.match(panel, /Google/);
  assert.match(panel, /Email/);
  assert.match(panel, /SMS/);
  assert.match(panel, /Send Email Notice/);
  assert.match(panel, /Send SMS Notice/);
  assert.match(panel, /Finalize Recovery/);
  assert.match(panel, /Cancel Recovery/);
  assert.match(panel, /Revoke Session/);
  assert.match(panel, /Pending Account Maintenance/);
  assert.match(panel, /Pending Verifier Maintenance Call/);
  assert.match(panel, /Pending Hook Maintenance Call/);
  assert.match(panel, /Pending Verifier Rotation/);
  assert.match(panel, /Pending Hook Rotation/);
  assert.match(panel, /Bound Module/);
  assert.match(panel, /Pending Call Hash/);
  assert.match(panel, /formatScheduledTimestamp/);
  assert.match(panel, /ZK Login Verifier Params/);
  assert.match(panel, /notificationService/);
});

test("did-notify binds the recipient to the verified identity and allowlists templates", async () => {
  const snapshot = {
    WEB3AUTH_CLIENT_ID: process.env.WEB3AUTH_CLIENT_ID,
    DID_EMAIL_WEBHOOK_URL: process.env.DID_EMAIL_WEBHOOK_URL,
    DID_EMAIL_WEBHOOK_TOKEN: process.env.DID_EMAIL_WEBHOOK_TOKEN,
  };
  const originalFetch = global.fetch;

  process.env.WEB3AUTH_CLIENT_ID = "test-client-id";
  process.env.DID_EMAIL_WEBHOOK_URL = "https://hooks.example/email";
  delete process.env.DID_EMAIL_WEBHOOK_TOKEN;

  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ delivered: true }),
    };
  };

  // jwtVerify is injected via the createHandler seam so the test never reaches
  // the real Web3Auth JWKS endpoint.
  const handler = createDidNotifyHandler({
    verifyToken: async () => ({ email: "a@x.com" }),
  });

  try {
    // (a) A recipient that does not match the verified identity is rejected with
    // 403 and the webhook is never invoked.
    const victimRes = createResponse();
    await handler(
      {
        method: "POST",
        headers: {},
        socket: { remoteAddress: `did-notify-victim-${Date.now()}` },
        body: {
          channel: "email",
          to: "victim@y.com",
          idToken: "token",
        },
      },
      victimRes,
    );
    assert.equal(victimRes.statusCode, 403);
    assert.equal(victimRes.payload?.error, "recipient_does_not_match_identity");
    assert.equal(calls.length, 0);

    // (b) The caller's own verified email proceeds to the webhook.
    const ownerRes = createResponse();
    await handler(
      {
        method: "POST",
        headers: {},
        socket: { remoteAddress: `did-notify-owner-${Date.now()}` },
        body: {
          channel: "email",
          to: "a@x.com",
          idToken: "token",
        },
      },
      ownerRes,
    );
    assert.equal(ownerRes.statusCode, 200);
    assert.equal(ownerRes.payload?.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://hooks.example/email");

    // (c) A non-allowlisted template is coerced to the default aa_recovery.
    const templateRes = createResponse();
    await handler(
      {
        method: "POST",
        headers: {},
        socket: { remoteAddress: `did-notify-template-${Date.now()}` },
        body: {
          channel: "email",
          to: "a@x.com",
          template: "arbitrary",
          idToken: "token",
        },
      },
      templateRes,
    );
    assert.equal(templateRes.statusCode, 200);
    assert.equal(calls.length, 2);
    const forwarded = JSON.parse(calls[1].options.body);
    assert.equal(forwarded.template, "aa_recovery");
    assert.equal(forwarded.to, "a@x.com");
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(snapshot)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
