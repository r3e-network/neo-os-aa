<template>
  <article
    class="gradient-border-card bg-sa-panel/60 backdrop-blur-xl overflow-hidden"
  >
    <div class="p-6">
      <!-- Header row: title, status, price -->
      <div
        class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between mb-5"
      >
        <div class="flex flex-wrap items-center gap-2">
          <img
            v-if="metadata?.logo_url"
            :src="metadata.logo_url"
            :alt="t('market.listingLogo', 'Listing logo')"
            class="w-6 h-6 rounded border border-sa-border object-cover"
          />
          <h3 class="text-lg font-bold text-sa-text">
            {{
              listing.title ||
              `${t("market.listingPrefix", "Listing #")}${listing.id}`
            }}
          </h3>
          <span
            class="badge text-xs font-semibold uppercase text inline-flex items-center gap-1"
            :class="statusBadgeClass"
          >
            <span
              v-if="listing.status === 'active'"
              class="w-1.5 h-1.5 rounded-full bg-sa-success"
            ></span>
            {{ translatedStatus }}
          </span>
          <span
            v-if="listing.escrow_active"
            class="rounded-full border border-sa-success/30 px-2.5 py-0.5 text-[11px] font-semibold uppercase text-sa-success-light bg-sa-success/10"
          >
            {{ t("market.escrowLocked", "escrow locked") }}
          </span>
        </div>
        <div class="flex items-baseline gap-1.5 shrink-0">
          <span
            class="text-3xl font-extrabold text-sa-text font-outfit"
            >{{ listing.price_gas }}</span
          >
          <span class="text-sm font-semibold text-sa-muted">GAS</span>
        </div>
      </div>

      <p
        v-if="metadata?.description"
        class="text-sm text-sa-muted mb-4"
      >
        {{ metadata.description }}
      </p>

      <!-- Account info row -->
      <div
        class="rounded-xl border border-sa-border bg-sa-dark/50 p-4 mb-4"
      >
        <p class="text-xs font-semibold uppercase text-sa-muted mb-2">
          {{ t("market.saAddress", "SA Address") }}
        </p>
        <div class="flex items-start gap-2">
          <p class="break-all font-mono text-sm text-sa-text flex-1">
            {{ listing.account_address }}
          </p>
          <button
            type="button"
            :aria-label="t('market.copyAddress', 'Copy address')"
            class="shrink-0 text-xs text-sa-muted hover:text-sa-text transition-colors duration-200"
            @click="
              $emit('copy', {
                value: listing.account_address,
                markKey: 'listing-addr-' + listing.id,
              })
            "
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
          </button>
        </div>
        <div
          class="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-xs text-sa-muted"
        >
          <span class="flex items-center"
            >{{ t("market.accountIdLabel", "Account ID") }}:
            <span class="font-mono text-sa-muted"
              >0x{{ listing.accountIdHash?.slice(0, 8) }}...{{
                listing.accountIdHash?.slice(-4)
              }}</span
            >
            <button
              v-if="listing.accountIdHash"
              :aria-label="
                t('market.copyAccountId', 'Copy account ID')
              "
              @click="
                $emit('copy', {
                  value: '0x' + listing.accountIdHash,
                  markKey: 'listing-accid-' + listing.id,
                })
              "
              class="ml-1.5 text-sa-muted hover:text-sa-text transition-colors duration-200 flex-shrink-0"
            >
              <svg
                aria-hidden="true"
                v-if="copiedKey !== 'listing-accid-' + listing.id"
                xmlns="http://www.w3.org/2000/svg"
                class="h-3.5 w-3.5"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z"
                />
                <path
                  d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z"
                />
              </svg>
              <svg
                aria-hidden="true"
                v-else
                xmlns="http://www.w3.org/2000/svg"
                class="h-3.5 w-3.5 text-sa-success"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fill-rule="evenodd"
                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                  clip-rule="evenodd"
                />
              </svg>
            </button>
          </span>
          <span class="flex items-center"
            >{{ t("market.seller", "Seller") }}:
            <span class="font-mono text-sa-muted">{{
              listing.seller_address
                ? listing.seller_address.slice(0, 8) +
                  "..." +
                  listing.seller_address.slice(-4)
                : t("market.unknown", "unknown")
            }}</span>
            <button
              v-if="listing.seller_address"
              :aria-label="
                t('market.copySeller', 'Copy seller address')
              "
              @click="
                $emit('copy', {
                  value: listing.seller_address,
                  markKey: 'listing-seller-' + listing.id,
                })
              "
              class="ml-1.5 text-sa-muted hover:text-sa-text transition-colors duration-200 flex-shrink-0"
            >
              <svg
                aria-hidden="true"
                v-if="copiedKey !== 'listing-seller-' + listing.id"
                xmlns="http://www.w3.org/2000/svg"
                class="h-3.5 w-3.5"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z"
                />
                <path
                  d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z"
                />
              </svg>
              <svg
                aria-hidden="true"
                v-else
                xmlns="http://www.w3.org/2000/svg"
                class="h-3.5 w-3.5 text-sa-success"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fill-rule="evenodd"
                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                  clip-rule="evenodd"
                />
              </svg>
            </button>
          </span>
        </div>
      </div>

      <!-- Details grid -->
      <div class="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <div>
          <p class="text-xs font-semibold uppercase text-sa-muted">
            {{ t("market.verifier", "Verifier") }}
          </p>
          <p class="mt-1 text-sm text-sa-text">
            {{ listing.verifier_profile || t("market.none", "None") }}
          </p>
        </div>
        <div>
          <p class="text-xs font-semibold uppercase text-sa-muted">
            {{ t("market.hook", "Hook") }}
          </p>
          <p class="mt-1 text-sm text-sa-text">
            {{ listing.hook_profile || t("market.none", "None") }}
          </p>
        </div>
        <div>
          <p class="text-xs font-semibold uppercase text-sa-muted">
            {{ t("market.backupOwner", "Backup Owner") }}
          </p>
          <div class="mt-1 flex items-center">
            <span class="font-mono text-sm text-sa-text flex-1">{{
              listing.backup_owner
                ? listing.backup_owner.slice(0, 8) +
                  "..." +
                  listing.backup_owner.slice(-4)
                : t("market.unset", "unset")
            }}</span>
            <button
              v-if="listing.backup_owner"
              :aria-label="
                t('market.copyBackupOwner', 'Copy backup owner')
              "
              @click="
                $emit('copy', {
                  value: listing.backup_owner,
                  markKey: 'listing-backup-' + listing.id,
                })
              "
              class="ml-1.5 text-sa-muted hover:text-sa-text transition-colors duration-200 flex-shrink-0"
            >
              <svg
                aria-hidden="true"
                v-if="copiedKey !== 'listing-backup-' + listing.id"
                xmlns="http://www.w3.org/2000/svg"
                class="h-3.5 w-3.5"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z"
                />
                <path
                  d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z"
                />
              </svg>
              <svg
                aria-hidden="true"
                v-else
                xmlns="http://www.w3.org/2000/svg"
                class="h-3.5 w-3.5 text-sa-success"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fill-rule="evenodd"
                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                  clip-rule="evenodd"
                />
              </svg>
            </button>
          </div>
        </div>
        <div>
          <p class="text-xs font-semibold uppercase text-sa-muted">
            {{ t("market.metadata", "Metadata") }}
          </p>
          <a
            v-if="listing.metadataUri"
            :href="listing.metadataUri"
            target="_blank"
            rel="noopener noreferrer"
            class="mt-1 text-sm text-sa-info-light hover:text-sa-info transition-colors duration-200"
          >
            {{ t("market.viewMetadata", "View") }} &rarr;
          </a>
          <p v-else class="mt-1 text-sm text-sa-muted">
            {{ t("market.noMetadataUrl", "No metadata URL") }}
          </p>
        </div>
      </div>
    </div>

    <!-- Actions footer -->
    <div class="border-t border-sa-border bg-sa-panel/40 p-4">
      <div
        class="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between"
      >
        <div
          class="rounded-xl border border-sa-border bg-sa-dark/50 p-3 flex-1 max-w-xl"
        >
          <p
            class="text-xs font-semibold uppercase text-sa-muted mb-2"
          >
            {{ t("market.buyerTransferPlan", "Buyer Transfer Plan") }}
          </p>
          <p class="text-xs leading-6 text-sa-muted">
            {{
              t(
                "market.buyerTransferPlanHint",
                "Settlement transfers only the SA shell. Existing verifier and hook bindings are cleared during settlement. Reconfigure fresh plugins afterward.",
              )
            }}
          </p>
          <label
            class="block mt-2"
            :for="'market-backup-owner-' + listing.id"
          >
            <span
              class="mb-1 block text-xs font-semibold uppercase text-sa-muted"
              >{{
                t("market.newBackupOwner", "New Backup Owner")
              }}</span
            >
            <input
              :id="'market-backup-owner-' + listing.id"
              :value="newBackupOwner"
              type="text"
              class="input-field w-full bg-sa-dark font-mono text-sm"
              :placeholder="
                connectedAccount ||
                t('market.addressPlaceholder', 'N...')
              "
              @input="$emit('update:newBackupOwner', $event.target.value)"
            />
          </label>
        </div>

        <div class="flex flex-wrap gap-2 shrink-0">
          <button
            type="button"
            class="btn-primary"
            :class="{ 'btn-loading': buyingId === listing.id }"
            :disabled="
              buyingId === listing.id ||
              listing.status !== 'active' ||
              !marketConfigured ||
              !connectedAccount
            "
            :aria-label="
              buyingId === listing.id
                ? t('market.settling', 'Settling...')
                : t('market.buyWithEscrow', 'Buy With Escrow')
            "
            @click="$emit('buy')"
          >
            {{
              buyingId === listing.id
                ? t("market.settling", "Settling...")
                : t("market.buyWithEscrow", "Buy With Escrow")
            }}
          </button>
          <button
            v-if="isSeller"
            type="button"
            class="btn-danger"
            :class="{ 'btn-loading': cancellingId === listing.id }"
            :disabled="
              cancellingId === listing.id ||
              listing.status !== 'active'
            "
            :aria-label="
              cancellingId === listing.id
                ? t('market.cancelling', 'Cancelling...')
                : t('market.cancelListing', 'Cancel Listing')
            "
            @click="$emit('cancel')"
          >
            {{
              cancellingId === listing.id
                ? t("market.cancelling", "Cancelling...")
                : t("market.cancelListing", "Cancel Listing")
            }}
          </button>
          <button
            v-if="isRefundBuyer"
            type="button"
            class="btn-ghost"
            :class="{ 'btn-loading': refundId === listing.id }"
            :disabled="refundId === listing.id || !connectedAccount"
            :aria-label="
              refundId === listing.id
                ? t('market.refunding', 'Refunding...')
                : t(
                    'market.refundPendingPayment',
                    'Refund Pending Payment',
                  )
            "
            :title="
              t(
                'market.refundHint',
                'Refund your pending payment if settlement did not complete',
              )
            "
            @click="$emit('refund')"
          >
            {{
              refundId === listing.id
                ? t("market.refunding", "Refunding...")
                : t(
                    "market.refundPendingPayment",
                    "Refund Pending Payment",
                  )
            }}
          </button>
        </div>
      </div>

      <div
        v-if="isSeller && listing.status === 'active'"
        class="mt-3 flex gap-2 items-end max-w-xs"
      >
        <label
          class="block flex-1"
          :for="'market-update-price-' + listing.id"
        >
          <span
            class="mb-1 block text-xs font-semibold uppercase text-sa-muted"
            >{{ t("market.updatePrice", "Update Price") }}</span
          >
          <input
            :id="'market-update-price-' + listing.id"
            :value="priceDraft"
            type="text"
            inputmode="decimal"
            class="input-field w-full bg-sa-dark font-mono text-sm"
            :placeholder="listing.price_gas"
            @input="$emit('update:priceDraft', $event.target.value)"
          />
        </label>
        <button
          type="button"
          class="btn-secondary"
          :class="{ 'btn-loading': priceUpdatingId === listing.id }"
          :disabled="priceUpdatingId === listing.id"
          :aria-label="
            priceUpdatingId === listing.id
              ? t('market.updating', 'Updating...')
              : t('market.update', 'Update')
          "
          @click="$emit('update-price')"
        >
          {{
            priceUpdatingId === listing.id
              ? t("market.updating", "Updating...")
              : t("market.update", "Update")
          }}
        </button>
      </div>
    </div>
  </article>
</template>

<script setup>
import { useI18n } from "@/i18n";

const { t } = useI18n();

defineProps({
  listing: { type: Object, required: true },
  metadata: { type: Object, default: () => ({}) },
  copiedKey: { type: String, default: "" },
  buyingId: { type: String, default: "" },
  cancellingId: { type: String, default: "" },
  refundId: { type: String, default: "" },
  priceUpdatingId: { type: String, default: "" },
  marketConfigured: { type: Boolean, default: false },
  connectedAccount: { type: String, default: "" },
  newBackupOwner: { type: String, default: "" },
  priceDraft: { type: String, default: "" },
  isSeller: { type: Boolean, default: false },
  isRefundBuyer: { type: Boolean, default: false },
  statusBadgeClass: { type: String, default: "" },
  translatedStatus: { type: String, default: "" },
});

defineEmits([
  "buy",
  "cancel",
  "refund",
  "update-price",
  "copy",
  "update:newBackupOwner",
  "update:priceDraft",
]);
</script>
