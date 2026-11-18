<template>
  <div v-if="renderError" role="alert" class="app-error-boundary">
    <div class="error-content">
      <h1 class="error-title">
        {{ t("errorBoundary.title", "Something went wrong") }}
      </h1>
      <p class="error-message">
        {{
          t(
            "errorBoundary.message",
            "An unexpected error occurred. Please try reloading the page.",
          )
        }}
      </p>
      <pre v-if="isDev && renderError" class="error-details">{{
        renderError.stack || renderError.message || String(renderError)
      }}</pre>
      <button class="btn-reload" @click="handleReload">
        {{ t("errorBoundary.reload", "Reload Page") }}
      </button>
    </div>
  </div>
  <RouterView v-else />
</template>

<script setup>
import { ref, onErrorCaptured } from "vue";
import { useI18n } from "@/i18n";

const { t } = useI18n();

const renderError = ref(null);
const isDev = import.meta.env.DEV;

onErrorCaptured((err, instance, info) => {
  renderError.value = err;
  if (import.meta.env.DEV) console.error("[ErrorBoundary]", err, info);
  return false;
});

function handleReload() {
  window.location.reload();
}
</script>

<style scoped>
.app-error-boundary {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 2rem;
  background: var(--sa-dark, #0a0a0a);
  color: var(--sa-text, #e5e5e5);
  font-family: Inter, sans-serif;
}

.error-content {
  text-align: center;
  max-width: 32rem;
  padding: 2.5rem;
  border: 1px solid var(--sa-border, #262626);
  border-radius: 0.75rem;
  background: var(--sa-dark, #0a0a0a);
}

.error-title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--sa-orange, #ff4400);
  margin-bottom: 0.75rem;
}

.error-message {
  color: var(--sa-muted, #a3a3a3);
  margin-bottom: 1.5rem;
  line-height: 1.6;
}

.error-details {
  text-align: left;
  padding: 1rem;
  margin-bottom: 1.5rem;
  border-radius: 0.5rem;
  background: rgba(var(--sa-orange-rgb), 0.08);
  border: 1px solid rgba(var(--sa-orange-rgb), 0.2);
  color: var(--sa-orange, #ff4400);
  font-size: 0.8rem;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.btn-reload {
  padding: 0.625rem 2rem;
  background: var(--sa-orange, #ff4400);
  color: var(--sa-dark, #0a0a0a);
  border: none;
  border-radius: 0.5rem;
  font-weight: 600;
  font-size: 0.9rem;
  cursor: pointer;
  transition: opacity 0.2s ease;
}

.btn-reload:hover {
  opacity: 0.85;
}

.btn-reload:focus-visible {
  outline: 2px solid var(--sa-orange, #ff4400);
  outline-offset: 2px;
}
</style>
