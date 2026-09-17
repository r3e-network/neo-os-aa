/* eslint-disable */
// Generated from neo-os-services/scripts/export-public-runtime-catalog.mjs.
// Do not edit manually; re-export from the Morpheus canonical oracle workspace.

export const MORPHEUS_PUBLIC_RUNTIME_CATALOG = {
  "envelope": {
    "version": "2026-04-tee-v1"
  },
  "topology": {
    "ingressPlane": "edge_gateway",
    "orchestrationPlane": "control_plane",
    "schedulerPlane": "control_plane",
    "executionPlane": "tee_runtime",
    "riskPlane": "independent_observer"
  },
  "risk": {
    "observer": "independent_observer",
    "actions": [
      "observe",
      "review",
      "pause_scope"
    ]
  },
  "automation": {
    "workflowId": "automation.upkeep",
    "triggerKinds": [
      "interval",
      "threshold"
    ],
    "route": "/automation/execute",
    "deliveryMode": "onchain_callback"
  },
  "networks": {
    "mainnet": {
      "network": "mainnet",
      "rpcUrl": "https://api.n3index.dev/mainnet",
      "networkMagic": 860833102,
      "morpheus": {
        "publicApiUrl": "https://oracle.meshmini.app/mainnet",
        "publicApiUrls": [
          "https://oracle.meshmini.app/mainnet"
        ],
        "runtimeUrl": "https://oracle.meshmini.app/mainnet",
        "runtimeUrls": [
          "https://oracle.meshmini.app/mainnet",
          "https://edge.meshmini.app/mainnet"
        ],
        "edgeUrl": "https://edge.meshmini.app/mainnet",
        "controlPlaneBaseUrl": "https://control.meshmini.app",
        "controlPlaneUrl": "https://control.meshmini.app/mainnet",
        "oracleCvmId": "ddff154546fe22d15b65667156dd4b7c611e6093",
        "oracleCvmName": "oracle-morpheus-neo-r3e",
        "oracleAttestationExplorerUrl": "",
        "datafeedCvmId": "ac5b6886a2832df36e479294206611652400178f",
        "datafeedCvmName": "datafeed-morpheus-neo-r3e",
        "datafeedAttestationExplorerUrl": "",
        "neoDidServiceDid": "did:morpheus:neo_n3:service:neodid"
      },
      "contracts": {
        "aaCore": "0x0268a387913b250166ddec032b03332690a1ef78",
        "aaWeb3AuthVerifier": "0xf5c452cd4ba29dcdc47026383568c0d8b38d9272",
        "aaSessionKeyVerifier": "0x63d6a10d388dd4885bc42ba69593734476f47151",
        "aaSocialRecoveryVerifier": "0xfb3f605fc6bcd59d265d7c18230093d7dc24ac26",
        "aaAddressMarket": "0xae7afe3a85ab08bfd1d4907b35ae8b80c75b3a69",
        "aaPaymaster": "0xa0defa2bc6d7a71ba1e237149287c8ca4ff46caf",
        "morpheusOracle": "0xf54d8584ef82315c1800373272ab08ae0db2d5ef",
        "oracleCallbackConsumer": "0xe1226268f2fe08bea67fb29e1c8fda0d7c8e9844",
        "morpheusDatafeed": "0x03013f49c42a14546c8bbe58f9d434c3517fccab",
        "morpheusNeoDid": "0xb81f31ea81e279793b30411b82c2e82078b63105",
        "matrixNameService": "0x994c3cbe0d8641b9c911452c37191de8dd9f5f4e"
      },
      "domains": {
        "aa": "smartwallet.neo",
        "aaAlias": "aa.morpheus.neo",
        "aaCore": "core.smartwallet.neo",
        "aaWeb3AuthVerifier": "web3auth.smartwallet.neo",
        "aaSessionKeyVerifier": "sessionkey.smartwallet.neo",
        "aaSocialRecoveryVerifier": "recovery.smartwallet.neo",
        "aaAddressMarket": "market.smartwallet.neo",
        "aaPaymaster": "paymaster.smartwallet.neo",
        "oracle": "morpheus-oracle.neo",
        "callbackConsumer": "callback.morpheus.neo",
        "datafeed": "pricefeed.morpheus.neo",
        "neodid": "neodid.morpheus.neo"
      }
    },
    "testnet": {
      "network": "testnet",
      "rpcUrl": "https://api.n3index.dev/testnet",
      "networkMagic": 894710606,
      "morpheus": {
        "publicApiUrl": "https://oracle.meshmini.app/testnet",
        "publicApiUrls": [
          "https://oracle.meshmini.app/testnet"
        ],
        "runtimeUrl": "https://oracle.meshmini.app/testnet",
        "runtimeUrls": [
          "https://oracle.meshmini.app/testnet",
          "https://edge.meshmini.app/testnet"
        ],
        "edgeUrl": "https://edge.meshmini.app/testnet",
        "controlPlaneBaseUrl": "https://control.meshmini.app",
        "controlPlaneUrl": "https://control.meshmini.app/testnet",
        "oracleCvmId": "ddff154546fe22d15b65667156dd4b7c611e6093",
        "oracleCvmName": "oracle-morpheus-neo-r3e",
        "oracleAttestationExplorerUrl": "",
        "datafeedCvmId": "ac5b6886a2832df36e479294206611652400178f",
        "datafeedCvmName": "datafeed-morpheus-neo-r3e",
        "datafeedAttestationExplorerUrl": "",
        "neoDidServiceDid": "did:morpheus:neo_n3:service:neodid"
      },
      "contracts": {
        "aaCore": "0xdbf38e7b2117186bf7a5e17ead702322c0c5b6f2",
        "aaWeb3AuthVerifier": "0x1111f5b6b046a964c75d208998c13945ce172e85",
        "aaSessionKeyVerifier": "0x63d6a10d388dd4885bc42ba69593734476f47151",
        "aaSocialRecoveryVerifier": "0xfb3f605fc6bcd59d265d7c18230093d7dc24ac26",
        "aaAddressMarket": "0x6b979cdd246cc6491a20000a2a822e497c92c23b",
        "aaPaymaster": "",
        "morpheusOracle": "0xf54d8584ef82315c1800373272ab08ae0db2d5ef",
        "oracleCallbackConsumer": "0x0ac1fa9cdcb66c1672f0642f62d767902f460f2b",
        "morpheusDatafeed": "0x9bea75cf702f6afc09125aa6d22f082bfd2ee064",
        "morpheusNeoDid": "",
        "matrixNameService": "0x994c3cbe0d8641b9c911452c37191de8dd9f5f4e"
      },
      "domains": {
        "aa": "",
        "aaAlias": "",
        "aaCore": "",
        "aaWeb3AuthVerifier": "",
        "aaSessionKeyVerifier": "",
        "aaSocialRecoveryVerifier": "",
        "aaAddressMarket": "",
        "aaPaymaster": "",
        "oracle": "",
        "callbackConsumer": "",
        "datafeed": "",
        "neodid": ""
      }
    }
  },
  "workflows": [
    {
      "id": "oracle.query",
      "version": 1,
      "trigger": {
        "kind": "request"
      },
      "allowedNetworks": [
        "mainnet",
        "testnet"
      ],
      "route": "/oracle/query",
      "capabilityId": "oracle_query",
      "policies": [
        "tenant",
        "provider",
        "risk"
      ],
      "execution": {
        "orchestrationPlane": "control_plane",
        "executionPlane": "tee_runtime",
        "riskPlane": "independent_observer",
        "teeRequired": true
      },
      "delivery": {
        "mode": "api_response"
      }
    },
    {
      "id": "oracle.smart_fetch",
      "version": 1,
      "trigger": {
        "kind": "request"
      },
      "allowedNetworks": [
        "mainnet",
        "testnet"
      ],
      "route": "/oracle/smart-fetch",
      "capabilityId": "oracle_smart_fetch",
      "policies": [
        "tenant",
        "provider",
        "risk"
      ],
      "execution": {
        "orchestrationPlane": "control_plane",
        "executionPlane": "tee_runtime",
        "riskPlane": "independent_observer",
        "teeRequired": true
      },
      "delivery": {
        "mode": "api_response"
      }
    },
    {
      "id": "feed.sync",
      "version": 1,
      "trigger": {
        "kind": "event",
        "supported": [
          "feed_tick"
        ]
      },
      "allowedNetworks": [
        "mainnet",
        "testnet"
      ],
      "route": "/feeds/tick",
      "capabilityId": "oracle_feed",
      "policies": [
        "provider",
        "risk"
      ],
      "execution": {
        "orchestrationPlane": "control_plane",
        "executionPlane": "tee_runtime",
        "riskPlane": "independent_observer",
        "teeRequired": true
      },
      "delivery": {
        "mode": "shared_resource_sync"
      }
    },
    {
      "id": "automation.upkeep",
      "version": 1,
      "trigger": {
        "kind": "scheduler",
        "supported": [
          "interval",
          "threshold"
        ]
      },
      "allowedNetworks": [
        "mainnet",
        "testnet"
      ],
      "route": "/automation/execute",
      "policies": [
        "tenant",
        "provider",
        "paymaster",
        "risk"
      ],
      "execution": {
        "orchestrationPlane": "control_plane",
        "executionPlane": "tee_runtime",
        "riskPlane": "independent_observer",
        "teeRequired": true
      },
      "delivery": {
        "mode": "onchain_callback"
      }
    },
    {
      "id": "compute.execute",
      "version": 1,
      "trigger": {
        "kind": "request"
      },
      "allowedNetworks": [
        "mainnet",
        "testnet"
      ],
      "route": "/compute/execute",
      "capabilityId": "compute_execute",
      "policies": [
        "tenant",
        "risk"
      ],
      "execution": {
        "orchestrationPlane": "control_plane",
        "executionPlane": "tee_runtime",
        "riskPlane": "independent_observer",
        "teeRequired": true
      },
      "delivery": {
        "mode": "api_response"
      }
    },
    {
      "id": "neodid.bind",
      "version": 1,
      "trigger": {
        "kind": "request"
      },
      "allowedNetworks": [
        "mainnet",
        "testnet"
      ],
      "route": "/neodid/bind",
      "capabilityId": "neodid_bind",
      "policies": [
        "tenant",
        "risk"
      ],
      "execution": {
        "orchestrationPlane": "control_plane",
        "executionPlane": "tee_runtime",
        "riskPlane": "independent_observer",
        "teeRequired": true
      },
      "delivery": {
        "mode": "kernel_inbox"
      }
    },
    {
      "id": "neodid.action_ticket",
      "version": 1,
      "trigger": {
        "kind": "request"
      },
      "allowedNetworks": [
        "mainnet",
        "testnet"
      ],
      "route": "/neodid/action-ticket",
      "capabilityId": "neodid_action_ticket",
      "policies": [
        "tenant",
        "risk"
      ],
      "execution": {
        "orchestrationPlane": "control_plane",
        "executionPlane": "tee_runtime",
        "riskPlane": "independent_observer",
        "teeRequired": true
      },
      "delivery": {
        "mode": "kernel_inbox"
      }
    },
    {
      "id": "neodid.recovery_ticket",
      "version": 1,
      "trigger": {
        "kind": "request"
      },
      "allowedNetworks": [
        "mainnet",
        "testnet"
      ],
      "route": "/neodid/recovery-ticket",
      "capabilityId": "neodid_recovery_ticket",
      "policies": [
        "tenant",
        "risk"
      ],
      "execution": {
        "orchestrationPlane": "control_plane",
        "executionPlane": "tee_runtime",
        "riskPlane": "independent_observer",
        "teeRequired": true
      },
      "delivery": {
        "mode": "kernel_inbox"
      }
    },
    {
      "id": "paymaster.authorize",
      "version": 1,
      "trigger": {
        "kind": "request"
      },
      "allowedNetworks": [
        "mainnet",
        "testnet"
      ],
      "route": "/paymaster/authorize",
      "capabilityId": "paymaster_authorize",
      "policies": [
        "tenant",
        "paymaster",
        "risk"
      ],
      "execution": {
        "orchestrationPlane": "control_plane",
        "executionPlane": "tee_runtime",
        "riskPlane": "independent_observer",
        "teeRequired": true
      },
      "delivery": {
        "mode": "api_response"
      }
    }
  ]
};
