import { ref, computed, onMounted } from 'vue';
import { useToast } from 'vue-toastification';
import { connectedAccount } from '@/utils/wallet';
import { walletService } from '@/services/walletService';
import { useI18n } from '@/i18n';
import { connectErrorMessage } from '@/config/errorCodes.js';

// The session-expired toast must fire at most once per page load even though
// several components mount this composable concurrently.
let sessionExpiredToastShown = false;

export function useWalletConnection() {
  const toast = useToast();
  const { t } = useI18n();

  const isConnecting = ref(false);
  const isConnected = computed(() => !!connectedAccount.value);
  const truncatedAddress = computed(() => {
    if (!connectedAccount.value) return '';
    const address = connectedAccount.value;
    return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
  });

  const availableWalletModes = computed(() => walletService.getAvailableWalletModes());

  async function connect() {
    isConnecting.value = true;
    try {
      const { address } = await walletService.connect();
      toast.success(`${t('nav.connect', 'Connect Wallet')}: ${address}`);
    } catch (err) {
      // Every failure renders a sentence: a refusal is named as one and keeps the wallet's words,
      // and a thrown value with no message still produces text rather than an empty toast.
      toast.error(connectErrorMessage(err, t));
      throw err;
    } finally {
      isConnecting.value = false;
    }
  }

  function disconnect() {
    walletService.disconnect();
    toast.info(`${t('nav.disconnect', 'Disconnect')}.`);
  }

  // Lazy session verification: walletService restores the persisted session as
  // 'pending'; the first mount reconciles it against the provider without
  // prompting (provider.getAccounts()). Persistence lives in walletService
  // under a single key, so no extra storage writes happen here.
  onMounted(async () => {
    if (walletService.sessionState !== 'pending') return;
    const state = await walletService.reconcileSession();
    if (state === 'disconnected' && !sessionExpiredToastShown) {
      sessionExpiredToastShown = true;
      toast.error(t('nav.walletSessionExpired', 'Wallet session expired. Please reconnect.'));
    }
  });

  async function connectEvm() {
    isConnecting.value = true;
    try {
      const { address } = await walletService.connectEvm();
      toast.success(`${t('operations.connectEvmWallet', 'Connect EVM Wallet')}: ${address}`);
      return { address };
    } catch (err) {
      toast.error(connectErrorMessage(err, t));
      throw err;
    } finally {
      isConnecting.value = false;
    }
  }

  return {
    isConnected,
    isConnecting,
    truncatedAddress,
    availableWalletModes,
    connect,
    connectEvm,
    disconnect
  };
}
