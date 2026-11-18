<template>
  <div
    class="relative min-h-screen overflow-hidden bg-sa-dark font-sans text-sa-text"
  >
    <div class="absolute inset-0 z-0">
      <div
        class="absolute left-1/4 top-0 h-[480px] w-[480px] rounded-full bg-sa-info/10 blur-3xl"
      ></div>
      <div
        class="absolute bottom-0 right-1/4 h-[420px] w-[420px] rounded-full bg-sa-success/10 blur-3xl"
      ></div>
    </div>

    <div class="relative z-10 mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
      <section class="sa-market-focus-entry">
        <div>
          <p class="text-xs font-bold uppercase text-sa-info">
            {{ t("market.focusEyebrow", "Market workflow") }}
          </p>
          <h1 class="mt-2 text-3xl font-extrabold text-sa-text font-outfit md:text-4xl">
            {{ t("market.focusTitle", "Create or settle an SA listing") }}
          </h1>
          <p class="mt-3 max-w-3xl text-sm leading-7 text-sa-muted md:text-base">
            {{
              t(
                "market.focusSubtitle",
                "Use the left action panel to prepare an escrow listing, then review active listings on the right.",
              )
            }}
          </p>
        </div>
        <a class="btn-secondary" href="#vanity-generator">
          {{ t("market.prepareAddress", "Prepare address") }}
        </a>
      </section>

      <details class="sa-focus-reference mb-6">
        <summary>
          <span>{{ t("market.marketReference", "Market reference") }}</span>
          <strong>{{ activeListingsCount }} active</strong>
        </summary>
        <div class="sa-market-reference-stack">
          <AddressMarketHero />
          <MarketStatsStrip
            :loading="loading"
            :has-loaded="hasLoaded"
            :total-listings="listings.length"
            :active-count="activeListingsCount"
            :avg-price="averagePrice"
          />
        </div>
      </details>

      <MarketNotConfiguredBanner v-if="!marketConfigured" />

      <VanityGeneratorPanel
        id="vanity-generator"
        class="mb-8"
        :on-use-for-listing="setListingSeed"
      />

      <section
        class="mb-8 grid gap-6 xl:grid-cols-[420px_minmax(0,1fr)]"
        data-vanity-anchor
      >
        <div
          class="rounded-[20px] border border-sa-border bg-sa-panel/60 p-6 backdrop-blur-xl shadow-sm"
        >
          <h2 class="text-lg font-bold text-sa-text">
            {{ t("market.createEscrowListing", "Create Escrow Listing") }}
          </h2>
          <p class="mt-2 text-sm leading-7 text-sa-muted">
            {{
              t(
                "market.createEscrowListingHint",
                "Listing creation is a real on-chain action. The seller must be the current backup owner, and the account is frozen in escrow immediately after the listing transaction succeeds.",
              )
            }}
          </p>

          <div class="mt-6 space-y-4">
            <label class="block" for="market-account-seed">
              <span
                class="mb-1 block text-xs font-semibold uppercase text-sa-muted"
                >{{
                  t("market.accountSeedLabel", "Account Seed / AccountId Hash")
                }}</span
              >
              <input
                id="market-account-seed"
                v-model="createForm.accountSeed"
                type="text"
                class="input-field w-full bg-sa-dark font-mono text-sm"
                :class="accountSeedInputClass"
                :placeholder="
                  t(
                    'market.accountSeedPlaceholder',
                    '64-char hex seed or 40-char account hash',
                  )
                "
                autocomplete="off"
                spellcheck="false"
              />
              <p
                v-if="accountSeedError"
                role="alert"
                class="mt-1 text-xs text-sa-error"
              >
                {{ accountSeedError }}
              </p>
              <p
                v-else-if="listingPreview.address"
                class="mt-1 text-xs text-sa-success/70"
              >
                {{ t("market.validAccountDetected", "Valid account detected") }}
              </p>
            </label>

            <div
              class="rounded-2xl border border-sa-border bg-sa-dark/50 p-4 transition-all duration-200"
              :class="
                listingPreview.address
                  ? 'border-sa-success/30 shadow-glow-emerald-sm'
                  : ''
              "
            >
              <div class="flex items-center justify-between">
                <p class="text-xs font-semibold uppercase text-sa-muted">
                  {{ t("market.derivedSaAddress", "Derived SA Address") }}
                </p>
                <button
                  v-if="listingPreview.address"
                  type="button"
                  :aria-label="t('market.copyAddress', 'Copy address')"
                  class="text-xs text-sa-muted hover:text-sa-text transition-colors duration-200 flex items-center gap-1"
                  @click="copyDerivedAddress"
                >
                  <svg
                    aria-hidden="true"
                    class="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                    ></path>
                  </svg>
                  {{
                    addressCopied
                      ? t("market.copied", "Copied!")
                      : t("market.copy", "Copy")
                  }}
                </button>
              </div>
              <p class="mt-2 break-all font-mono text-sm text-sa-text">
                {{
                  listingPreview.address ||
                  t(
                    "market.waitingForAccountSeed",
                    "Waiting for account seed / accountId hash",
                  )
                }}
              </p>
              <p
                v-if="listingPreview.accountIdHash"
                class="mt-2 break-all font-mono text-xs text-sa-muted"
              >
                {{ t("market.accountIdLabel", "accountId") }}: 0x{{
                  listingPreview.accountIdHash
                }}
              </p>
            </div>

            <label class="block" for="market-listing-title">
              <span
                class="mb-1 block text-xs font-semibold uppercase text-sa-muted"
                >{{ t("market.listingTitleLabel", "Listing Title") }}</span
              >
              <input
                id="market-listing-title"
                v-model="createForm.title"
                type="text"
                maxlength="80"
                class="input-field w-full bg-sa-dark text-sm"
                :class="
                  titleError
                    ? 'border-sa-error focus:border-sa-error-light focus:ring-sa-error/20'
                    : ''
                "
                :placeholder="
                  t('market.listingTitlePlaceholder', 'Short and descriptive')
                "
                @input="validateTitle"
              />
              <p
                v-if="titleError"
                role="alert"
                class="mt-1 text-xs text-sa-error"
              >
                {{ titleError }}
              </p>
              <p v-else class="mt-1 text-xs text-sa-muted">
                {{ createForm.title.length }}/80
              </p>
            </label>

            <label class="block" for="market-price-gas">
              <span
                class="mb-1 block text-xs font-semibold uppercase text-sa-muted"
                >{{ t("market.priceLabel", "Price (GAS)") }}</span
              >
              <input
                id="market-price-gas"
                v-model="createForm.price_gas"
                type="text"
                inputmode="decimal"
                class="input-field w-full bg-sa-dark font-mono text-sm"
                :class="priceInputClass"
                :placeholder="t('market.pricePlaceholder', 'e.g. 25.5')"
                @input="validatePrice"
              />
              <p
                v-if="priceError"
                role="alert"
                class="mt-1 text-xs text-sa-error"
              >
                {{ priceError }}
              </p>
            </label>

            <label class="block" for="market-metadata-uri">
              <span
                class="mb-1 block text-xs font-semibold uppercase text-sa-muted"
                >{{ t("market.metadataLabel", "Metadata / Docs URL") }}</span
              >
              <input
                id="market-metadata-uri"
                v-model="createForm.metadataUri"
                type="text"
                maxlength="240"
                class="input-field w-full bg-sa-dark text-sm"
                :placeholder="
                  t(
                    'market.metadataPlaceholder',
                    'Optional URL with listing context',
                  )
                "
              />
            </label>

            <button
              type="button"
              class="btn-primary w-full"
              :class="{ 'btn-loading': submitting }"
              :disabled="submitting || !canSubmitListing || !marketConfigured"
              :aria-label="
                submitting
                  ? t('market.submittingListing', 'Submitting Listing...')
                  : t(
                      'market.createTrustlessListing',
                      'Create Trustless Listing',
                    )
              "
              @click="submitListing"
            >
              {{
                submitting
                  ? t("market.submittingListing", "Submitting Listing...")
                  : t(
                      "market.createTrustlessListing",
                      "Create Trustless Listing",
                    )
              }}
            </button>

            <p class="text-xs leading-6 text-sa-muted">
              {{ t("market.sellerWalletLabel", "Seller wallet:") }}
              <span class="font-mono text-sa-text">{{
                connectedAccount ||
                t("market.connectNeoWallet", "connect a Neo wallet")
              }}</span>
            </p>
          </div>
        </div>

        <div class="space-y-4">
          <ListingsHeaderBar
            :loading="loading"
            :market-configured="marketConfigured"
            @refresh="refreshListings"
          />

          <ListingsSkeletonList
            v-if="loading && !hasLoaded && marketConfigured"
          />

          <ListingsEmptyState
            v-else-if="marketConfigured && listings.length === 0"
          />

          <div v-else class="space-y-4">
            <AddressMarketListingCard
              v-for="listing in listings"
              :key="listing.id"
              :listing="listing"
              :metadata="listingMetadata[listing.accountIdHash]"
              :copied-key="copiedKey"
              :buying-id="buyingId"
              :cancelling-id="cancellingId"
              :refund-id="refundId"
              :price-updating-id="priceUpdatingId"
              :market-configured="marketConfigured"
              :connected-account="connectedAccount || ''"
              :new-backup-owner="purchaseForm(listing.id).newBackupOwner"
              :price-draft="priceDrafts[listing.id]"
              :is-seller="isSeller(listing)"
              :is-refund-buyer="isRefundBuyer(listing)"
              :status-badge-class="statusBadgeClass(listing.status)"
              :translated-status="translatedStatus(listing.status)"
              @buy="buyListingAction(listing)"
              @cancel="cancelListingAction(listing)"
              @refund="refundAction(listing)"
              @update-price="updatePriceAction(listing)"
              @copy="
                copyText($event.value);
                markCopied($event.markKey);
              "
              @update:new-backup-owner="
                purchaseForm(listing.id).newBackupOwner = $event
              "
              @update:price-draft="priceDrafts[listing.id] = $event"
            />
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useToast } from "vue-toastification";
import { useI18n } from "@/i18n";
import { connectedAccount } from "@/utils/wallet";
import { RUNTIME_CONFIG } from "@/config/runtimeConfig.js";
import { getScriptHashFromAddress } from "@/utils/neo.js";
import { useClipboard } from "@/composables/useClipboard";
import {
  buyAddressListing,
  cancelAddressListing,
  createAddressListing,
  deriveVirtualAddressFromListing,
  isAddressMarketConfigured,
  listAddressListings,
  readAddressListing,
  refundPendingAddressPurchase,
  resolveListedAccountId,
  updateAddressListingPrice,
} from "@/services/addressMarketService.js";
import { fetchAccountMetadataBatch } from "@/services/accountMetadataService.js";
import VanityGeneratorPanel from "@/features/market/components/VanityGeneratorPanel.vue";
import AddressMarketHero from "@/views/AddressMarketView/AddressMarketHero.vue";
import MarketStatsStrip from "@/views/AddressMarketView/MarketStatsStrip.vue";
import MarketNotConfiguredBanner from "@/views/AddressMarketView/MarketNotConfiguredBanner.vue";
import ListingsHeaderBar from "@/views/AddressMarketView/ListingsHeaderBar.vue";
import ListingsSkeletonList from "@/views/AddressMarketView/ListingsSkeletonList.vue";
import ListingsEmptyState from "@/views/AddressMarketView/ListingsEmptyState.vue";
import AddressMarketListingCard from "@/views/AddressMarketView/AddressMarketListingCard.vue";
import { translateError } from "@/config/errorCodes.js";

const { t } = useI18n();
const toast = useToast();
const { copiedKey, markCopied, copyText } = useClipboard();
const marketConfigured = isAddressMarketConfigured();
const listings = ref([]);
const listingMetadata = ref({});
const loading = ref(false);
const hasLoaded = ref(false);
const submitting = ref(false);
const buyingId = ref("");
const cancellingId = ref("");
const refundId = ref("");
const priceUpdatingId = ref("");
const priceDrafts = reactive({});
const purchaseDrafts = reactive({});

const createForm = reactive({
  accountSeed: "",
  title: "",
  price_gas: "",
  metadataUri: "",
});

function setListingSeed(seed) {
  createForm.accountSeed = seed;
  const formEl = document.querySelector("[data-vanity-anchor]");
  if (formEl) formEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

const priceError = ref("");
const titleError = ref("");

const accountSeedError = ref("");

const addressCopied = ref(false);
let addressCopiedTimer = null;

async function copyDerivedAddress() {
  if (!listingPreview.value.address) return;
  await copyText(listingPreview.value.address);
  markCopied("derivedAddress");
  addressCopied.value = true;
  addressCopiedTimer = setTimeout(() => {
    addressCopied.value = false;
  }, 1200);
}

const accountSeedInputClass = computed(() => {
  if (accountSeedError.value)
    return "border-sa-error focus:border-sa-error-light focus:ring-sa-error/20";
  if (listingPreview.value.accountIdHash) return "border-sa-success/50";
  return "";
});

function translatedStatus(status) {
  const map = {
    active: t("market.statusActive", "active"),
    sold: t("market.statusSold", "sold"),
    cancelled: t("market.statusCancelled", "cancelled"),
    unknown: t("market.statusUnknown", "unknown"),
  };
  return map[status] || status;
}

function validatePrice() {
  const val = createForm.price_gas.trim();
  if (!val) {
    priceError.value = "";
    return true;
  }
  const num = parseFloat(val);
  if (isNaN(num) || num <= 0) {
    priceError.value = t(
      "market.errorPositiveNumber",
      "Enter a positive number (e.g. 25 or 25.5)",
    );
    return false;
  }
  if (num > 1000000) {
    priceError.value = t(
      "market.errorPriceTooHigh",
      "Price seems too high - enter a reasonable GAS amount",
    );
    return false;
  }
  priceError.value = "";
  return true;
}

function validateTitle() {
  const val = createForm.title.trim();
  if (!val) {
    titleError.value = "";
    return true;
  }
  if (val.length < 3) {
    titleError.value = t(
      "market.errorTitleTooShort",
      "Title must be at least 3 characters",
    );
    return false;
  }
  titleError.value = "";
  return true;
}

const priceInputClass = computed(() => {
  if (priceError.value)
    return "border-sa-error focus:border-sa-error-light focus:ring-sa-error/20";
  if (createForm.price_gas && !priceError.value) return "border-sa-success/50";
  return "";
});

const connectedScriptHash = computed(() => {
  try {
    return connectedAccount.value
      ? getScriptHashFromAddress(connectedAccount.value)
      : "";
  } catch (e) {
    if (import.meta.env.DEV)
      console.warn(
        "[AddressMarketView] connectedScriptHash parse failed:",
        e?.message,
      );
    return "";
  }
});

const listingPreview = computed(() => {
  try {
    const accountIdHash = createForm.accountSeed
      ? resolveListedAccountId(createForm.accountSeed)
      : "";
    const address = accountIdHash
      ? deriveVirtualAddressFromListing({
          saContractHash: RUNTIME_CONFIG.smartAccountHash,
          accountIdHash,
        })
      : "";
    return { accountIdHash, address };
  } catch (e) {
    if (import.meta.env.DEV)
      console.warn(
        "[AddressMarketView] listingPreview derivation failed:",
        e?.message,
      );
    return { accountIdHash: "", address: "" };
  }
});

const canSubmitListing = computed(() => {
  return Boolean(
    createForm.accountSeed &&
    createForm.price_gas &&
    !priceError.value &&
    !titleError.value &&
    connectedAccount.value &&
    listingPreview.value.accountIdHash,
  );
});

const activeListingsCount = computed(
  () => listings.value.filter((l) => l.status === "active").length,
);

const averagePrice = computed(() => {
  const active = listings.value.filter(
    (l) => l.status === "active" && l.price_gas,
  );
  if (!active.length) return "0";
  const sum = active.reduce((acc, l) => acc + parseFloat(l.price_gas || 0), 0);
  return (sum / active.length).toFixed(2);
});

function statusBadgeClass(status) {
  if (status === "active") return "badge-green";
  if (status === "sold") return "badge-amber";
  if (status === "cancelled") return "badge-red";
  return "badge-red";
}

function isSeller(listing) {
  return Boolean(
    connectedScriptHash.value &&
    listing?.sellerScriptHash === connectedScriptHash.value,
  );
}

function isRefundBuyer(listing) {
  return Boolean(
    connectedScriptHash.value &&
    listing?.buyerScriptHash &&
    listing.buyerScriptHash === connectedScriptHash.value,
  );
}

function purchaseForm(id) {
  if (!purchaseDrafts[id]) {
    purchaseDrafts[id] = reactive({
      newBackupOwner: connectedAccount.value || "",
    });
  }
  if (!purchaseDrafts[id].newBackupOwner && connectedAccount.value) {
    purchaseDrafts[id].newBackupOwner = connectedAccount.value;
  }
  return purchaseDrafts[id];
}

async function refreshListings() {
  loading.value = true;
  try {
    listings.value = await listAddressListings();
    hasLoaded.value = true;
    listings.value.forEach((listing) => {
      if (!(listing.id in priceDrafts)) {
        priceDrafts[listing.id] = listing.price_gas;
      }
      purchaseForm(listing.id);
    });
    const hashes = listings.value.map((l) => l.accountIdHash).filter(Boolean);
    if (hashes.length) {
      try {
        listingMetadata.value = await fetchAccountMetadataBatch(hashes);
      } catch (err) {
        if (import.meta.env.DEV)
          console.warn(
            "[AddressMarketView] Metadata batch fetch failed:",
            err?.message,
          );
      }
    }
  } catch (error) {
    toast.error(translateError(error?.message, t));
  } finally {
    loading.value = false;
  }
}

async function refreshOne(listingId) {
  try {
    const next = await readAddressListing(listingId);
    listings.value = listings.value.map((item) =>
      item.id === String(listingId) ? next : item,
    );
    return next;
  } catch (e) {
    if (import.meta.env.DEV)
      console.warn(
        "[AddressMarketView] refreshOne failed, falling back to full refresh:",
        e?.message,
      );
    await refreshListings();
    return null;
  }
}

async function submitListing() {
  if (!canSubmitListing.value) return;
  submitting.value = true;
  try {
    const result = await createAddressListing({
      accountSeed: createForm.accountSeed,
      title: createForm.title,
      price_gas: createForm.price_gas,
      metadataUri: createForm.metadataUri,
    });
    toast.success(
      t("market.successListingSubmitted", "Listing submitted on-chain.") +
        ` Tx: ${result.txid || "pending"}`,
    );
    Object.assign(createForm, {
      accountSeed: "",
      title: "",
      price_gas: "",
      metadataUri: "",
    });
    await refreshListings();
  } catch (error) {
    toast.error(translateError(error?.message, t));
  } finally {
    submitting.value = false;
  }
}

async function buyListingAction(listing) {
  buyingId.value = listing.id;
  try {
    const form = purchaseForm(listing.id);
    const result = await buyAddressListing(listing.id, {
      newBackupOwner: form.newBackupOwner,
    });
    toast.success(
      t("market.successEscrowSettlement", "Escrow settlement submitted.") +
        ` Tx: ${result.txid || "pending"}`,
    );
    await refreshOne(listing.id);
  } catch (error) {
    toast.error(translateError(error?.message, t));
  } finally {
    buyingId.value = "";
  }
}

async function cancelListingAction(listing) {
  cancellingId.value = listing.id;
  try {
    const result = await cancelAddressListing(listing.id);
    toast.success(
      t("market.successCancellation", "Listing cancellation submitted.") +
        ` Tx: ${result.txid || "pending"}`,
    );
    await refreshOne(listing.id);
  } catch (error) {
    toast.error(translateError(error?.message, t));
  } finally {
    cancellingId.value = "";
  }
}

async function refundAction(listing) {
  refundId.value = listing.id;
  try {
    const result = await refundPendingAddressPurchase(listing.id);
    toast.success(
      t("market.successRefund", "Pending payment refund submitted.") +
        ` Tx: ${result.txid || "pending"}`,
    );
  } catch (error) {
    toast.error(translateError(error?.message, t));
  } finally {
    refundId.value = "";
  }
}

async function updatePriceAction(listing) {
  priceUpdatingId.value = listing.id;
  try {
    const nextPrice = String(priceDrafts[listing.id] || "").trim();
    const result = await updateAddressListingPrice(listing.id, nextPrice);
    toast.success(
      t("market.successPriceUpdate", "Listing price update submitted.") +
        ` Tx: ${result.txid || "pending"}`,
    );
    await refreshOne(listing.id);
  } catch (error) {
    toast.error(translateError(error?.message, t));
  } finally {
    priceUpdatingId.value = "";
  }
}

onMounted(() => {
  void refreshListings();
});

onUnmounted(() => {
  clearTimeout(addressCopiedTimer);
});

watch(
  () => createForm.accountSeed,
  (val) => {
    const trimmed = String(val || "").trim();
    if (!trimmed) {
      accountSeedError.value = "";
      return;
    }
    const isValidHex64 = /^[0-9a-fA-F]{64}$/.test(trimmed);
    const isValidHex40 = /^(0x)?[0-9a-fA-F]{40}$/.test(trimmed);
    if (!isValidHex64 && !isValidHex40) {
      accountSeedError.value = t(
        "market.errorInvalidAccountSeed",
        "Enter 64-char hex seed or 40-char accountId hash",
      );
    } else {
      accountSeedError.value = "";
    }
  },
);
</script>
