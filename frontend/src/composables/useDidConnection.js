import { ref, computed, watch, onMounted } from 'vue';
import { useToast } from 'vue-toastification';
import { connectedDidProfile } from '@/utils/did';
import { useI18n } from '@/i18n';
import { translateError } from '@/config/errorCodes.js';
import { RUNTIME_CONFIG } from '@/config/runtimeConfig';

let didServicePromise;

async function getDidService() {
  if (!didServicePromise) {
    didServicePromise = import('@/services/didService').then((mod) => mod.didService);
  }
  return didServicePromise;
}

export function useDidConnection() {
  const toast = useToast();
  const { t } = useI18n();

  const isConnecting = ref(false);
  const isConnected = computed(() => Boolean(connectedDidProfile.value?.did));
  const didProfile = computed(() => connectedDidProfile.value);
  const shortDid = computed(() => {
    const did = connectedDidProfile.value?.did || '';
    if (!did) return '';
    return did.length > 26 ? `${did.slice(0, 18)}...${did.slice(-6)}` : did;
  });
  const isConfigured = computed(() => Boolean(String(RUNTIME_CONFIG.web3AuthClientId || '').trim()));

  async function connectDid(options = {}) {
    isConnecting.value = true;
    try {
      const didService = await getDidService();
      const profile = await didService.connect(options);
      toast.success(`${t('nav.connectDid', 'Connect Web3Auth')}: ${profile.did}`);
      return profile;
    } catch (err) {
      toast.error(translateError(err?.message, t));
      throw err;
    } finally {
      isConnecting.value = false;
    }
  }

  async function disconnectDid() {
    const didService = await getDidService();
    await didService.disconnect();
    toast.info(`${t('nav.disconnectDid', 'Disconnect Web3Auth')}.`);
  }

  // Auto-reconnect: persist DID connection state
  watch(isConnected, (connected) => {
    if (connected) {
      localStorage.setItem('sa_did_connected', 'true');
    } else {
      localStorage.removeItem('sa_did_connected');
    }
  });

  // Auto-reconnect on page load
  onMounted(async () => {
    if (localStorage.getItem('sa_did_connected') && !connectedDidProfile.value?.did && isConfigured.value) {
      try {
        const didService = await getDidService();
        await didService.connect();
      } catch (error) {
        if (import.meta.env.DEV) console.error('[useDidConnection] Auto-reconnect failed:', error?.message);
        toast.error(t('nav.didSessionExpired', 'Web3Auth session expired. Please reconnect.'));
        localStorage.removeItem('sa_did_connected');
      }
    }
  });

  return {
    isConfigured,
    isConnected,
    isConnecting,
    didProfile,
    shortDid,
    connectDid,
    disconnectDid,
  };
}
