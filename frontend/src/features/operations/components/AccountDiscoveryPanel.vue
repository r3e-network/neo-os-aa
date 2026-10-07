<template>
  <section class="glass-panel p-6">
    <div class="mb-4 flex items-center justify-between">
      <div>
        <h2 class="text-lg font-bold text-aa-text flex items-center gap-2">
          <svg
            aria-hidden="true"
            class="w-5 h-5 text-aa-orange"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            ></path>
          </svg>
          {{ t("operations.discoverTitle", "Discover Your Accounts") }}
        </h2>
        <p class="text-sm text-aa-muted mt-1">
          {{
            t(
              "operations.discoverSubtitle",
              "Find all accounts where you are a signer",
            )
          }}
        </p>
      </div>
      <button
        class="btn-secondary btn-xs"
        :class="{ 'btn-loading': searching }"
        :disabled="!canSearch || searching"
        @click="discoverAccounts"
      >
        <svg
          v-if="searching"
          aria-hidden="true"
          class="animate-spin -ml-1 mr-1.5 h-3 w-3 inline"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            class="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            stroke-width="4"
          ></circle>
          <path
            class="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          ></path>
        </svg>
        {{
          searching
            ? t("operations.searching", "Searching…")
            : t("operations.discoverAction", "Discover")
        }}
      </button>
    </div>

    <div v-if="!isConfigured" class="empty-state">
      <svg
        aria-hidden="true"
        class="w-10 h-10 mx-auto mb-3 text-aa-muted"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="1.5"
          d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        ></path>
      </svg>
      <p class="text-sm font-semibold text-aa-text mb-1">
        {{
          t("operations.discoverNotConfigured", "Account Discovery Not Configured")
        }}
      </p>
      <p class="text-xs text-aa-muted max-w-sm mx-auto">
        {{
          t(
            "operations.discoverNotConfiguredHint",
            "Account discovery reads registered accounts from the NeoOS read API. Set the read API base URL and the abstract account core hash for this network, or use direct account lookup below.",
          )
        }}
      </p>
    </div>

    <div
      v-else-if="error"
      role="alert"
      class="mb-4 rounded-xl border border-aa-error/30 bg-aa-error/10 p-4 flex items-center gap-3"
    >
      <p class="text-sm text-aa-error font-medium flex-1">{{ error }}</p>
      <button
        class="btn-ghost btn-sm"
        :class="{ 'btn-loading': searching }"
        :disabled="searching"
        @click="discoverAccounts"
      >
        {{
          searching
            ? t("operations.searching", "Searching…")
            : t("operations.retry", "Retry")
        }}
      </button>
    </div>

    <div
      v-else-if="searched && registeredAccounts.length === 0 && discoveredListings.length === 0"
      class="empty-state"
    >
      <svg
        aria-hidden="true"
        class="w-10 h-10 mx-auto mb-3 text-aa-muted"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="1.5"
          d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        ></path>
      </svg>
      <p class="text-sm font-semibold text-aa-text mb-1">
        {{ t("operations.noAccountsFound", "No accounts found") }}
      </p>
      <p class="text-xs text-aa-muted max-w-sm mx-auto">
        {{
          t(
            "operations.noAccountsHint",
            "The NeoOS read API lists no accounts registered to your connected wallet, and the address market has no listings for it.",
          )
        }}
      </p>
    </div>

    <div v-if="registeredAccounts.length > 0" class="space-y-3 mb-6">
      <p class="text-xs font-bold uppercase text-aa-muted">
        {{ t("operations.discoveredRegisteredAccounts", "Registered Accounts") }}
      </p>
      <div
        v-for="account in registeredAccounts"
        :key="account.accountIdHash"
        class="rounded-xl border border-aa-border bg-aa-panel/40 p-4 hover:border-aa-orange/30 transition-colors duration-200"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0 flex-1">
            <p class="text-xs text-aa-muted font-mono truncate">
              {{ truncateHash(account.accountIdHash) }}
            </p>
            <div class="flex flex-wrap gap-x-4 gap-y-1 mt-2">
              <span
                v-if="account.registryBlockIndex"
                class="text-xs text-aa-muted"
                >{{ t("operations.registeredAtBlock", "Registered at block") }}
                {{ account.registryBlockIndex }}</span
              >
              <span v-if="account.verifier" class="text-xs text-aa-muted"
                >{{ t("operations.verifierShort", "Verifier") }}:
                {{ truncateHash(account.verifier) }}</span
              >
            </div>
          </div>
          <button
            class="btn-primary btn-xs shrink-0"
            @click="$emit('select', account.accountIdHash)"
          >
            {{ t("operations.loadThisAccount", "Load") }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="discoveredListings.length > 0" class="space-y-3 mb-6">
      <p class="text-xs font-bold uppercase text-aa-muted">
        {{ t("operations.discoveredListings", "Market Listings") }}
      </p>
      <div
        v-for="listing in discoveredListings"
        :key="listing.id"
        class="rounded-xl border border-aa-border bg-aa-panel/40 p-4 hover:border-aa-orange/30 transition-colors duration-200"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 mb-1">
              <p class="text-sm font-semibold text-aa-text truncate">
                {{
                  listing.title ||
                  t("operations.untitledListing", "Untitled Listing")
                }}
              </p>
              <span class="badge" :class="statusBadgeClass(listing.status)">{{
                translateStatus(listing.status)
              }}</span>
            </div>
            <p class="text-xs text-aa-muted font-mono truncate">
              {{ listing.account_address }}
            </p>
            <div class="flex flex-wrap gap-x-4 gap-y-1 mt-2">
              <span v-if="listing.price_gas" class="text-xs text-aa-text"
                >{{ listing.price_gas }} GAS</span
              >
              <span v-if="listing.backup_owner" class="text-xs text-aa-muted"
                >{{ t("operations.backupOwnerShort", "Backup") }}:
                {{ truncateHash(listing.backup_owner) }}</span
              >
            </div>
          </div>
          <button
            class="btn-primary btn-xs shrink-0"
            @click="$emit('select', listing.accountIdHash)"
          >
            {{ t("operations.loadThisAccount", "Load") }}
          </button>
        </div>
      </div>
    </div>

    <div class="border-t border-aa-border pt-4">
      <p class="text-xs font-bold uppercase text-aa-muted mb-3">
        {{ t("operations.directLookup", "Direct Lookup") }}
      </p>
      <div class="flex gap-3">
        <label
          class="flex-1 block space-y-1 text-sm"
          for="discovery-direct-lookup"
        >
          <input
            id="discovery-direct-lookup"
            v-model="directLookupValue"
            class="input-field w-full font-mono"
            :aria-label="
              t(
                'operations.directLookupLabel',
                'AccountId hash',
              )
            "
            :placeholder="
              t(
                'operations.directLookupPlaceholder',
                '40-char accountId hash',
              )
            "
            @keydown.enter="loadDirect"
          />
        </label>
        <button
          class="btn-secondary btn-xs self-end"
          :disabled="!directLookupValue.trim()"
          @click="loadDirect"
        >
          {{ t("operations.loadAction", "Load") }}
        </button>
      </div>
    </div>
  </section>
</template>

<script setup>
import { ref, computed } from "vue";
import { useI18n } from "@/i18n";
import { sanitizeHex } from "@/utils/hex.js";
import { getScriptHashFromAddress } from "@/utils/neo.js";
import {
  findListingsForWallet,
  isAddressMarketConfigured,
} from "@/services/addressMarketService.js";
import {
  discoverAAAccountsForWallet,
  isAAReadApiConfigured,
} from "@/services/aaAccountDiscoveryService.js";
import { translateError } from "@/config/errorCodes.js";

const props = defineProps({
  walletAddress: { type: String, default: "" },
});

const emit = defineEmits(["select"]);

const { t } = useI18n();

const searching = ref(false);
const searched = ref(false);
const registeredAccounts = ref([]);
const discoveredListings = ref([]);
const error = ref("");
const directLookupValue = ref("");

// Discovery reads the NeoOS read API, so it no longer depends on the address
// market being configured; the market listing scan stays an extra when it is.
const isConfigured = computed(() => isAAReadApiConfigured());

const canSearch = computed(() => {
  if (!isConfigured.value) return false;
  const addr = String(props.walletAddress || "").trim();
  return addr.length > 0;
});

function walletScriptHash() {
  const addr = String(props.walletAddress || "").trim();
  if (!addr) return "";
  try {
    if (addr.startsWith("N") && addr.length === 34) {
      return `0x${getScriptHashFromAddress(addr)}`;
    }
    return `0x${sanitizeHex(addr)}`;
  } catch (e) {
    if (import.meta.env.DEV)
      console.warn(
        "[AccountDiscoveryPanel] walletScriptHash parse failed:",
        addr,
        e?.message,
      );
    return "";
  }
}

async function discoverAccounts() {
  const scriptHash = walletScriptHash();
  if (!scriptHash) {
    error.value = t(
      "operations.noWalletConnected",
      "Connect a wallet first to discover accounts.",
    );
    return;
  }
  searching.value = true;
  error.value = "";
  try {
    registeredAccounts.value = await discoverAAAccountsForWallet({
      address: scriptHash,
    });
    searched.value = true;
  } catch (err) {
    registeredAccounts.value = [];
    error.value =
      translateError(err?.message, t) ||
      t(
        "operations.errorDiscoverAccounts",
        "Failed to discover accounts. Please try again.",
      );
  } finally {
    searching.value = false;
  }
  if (error.value || !isAddressMarketConfigured()) {
    discoveredListings.value = [];
    return;
  }
  try {
    discoveredListings.value = await findListingsForWallet(scriptHash);
  } catch (err) {
    // The read API answered, so the market scan is the optional half: keep the
    // registered accounts and let the market failure stay out of the panel.
    discoveredListings.value = [];
    if (import.meta.env.DEV)
      console.warn(
        "[AccountDiscoveryPanel] market listing scan failed:",
        err?.message,
      );
  }
}

function loadDirect() {
  const value = directLookupValue.value.trim();
  if (value) {
    emit("select", value);
  }
}

function statusBadgeClass(status) {
  if (status === "active") return "badge-green";
  if (status === "sold") return "badge-blue";
  if (status === "cancelled") return "badge-amber";
  return "";
}

function translateStatus(status) {
  const map = {
    active: t("operations.statusActive", "active"),
    sold: t("operations.statusSold", "sold"),
    cancelled: t("operations.statusCancelled", "cancelled"),
  };
  return map[status] || status;
}

function truncateHash(value) {
  const hex = sanitizeHex(value || "");
  if (hex.length <= 12) return `0x${hex}`;
  return `0x${hex.slice(0, 6)}…${hex.slice(-4)}`;
}
</script>
