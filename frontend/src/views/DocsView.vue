<template>
  <div
    class="relative min-h-screen bg-sa-dark overflow-hidden font-sans text-sa-text"
  >
    <div
      class="absolute inset-0 z-0 bg-[linear-gradient(rgba(123,97,255,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(123,97,255,0.04)_1px,transparent_1px)] bg-[size:48px_48px]"
    ></div>
    <div
      class="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 animate-fade-in-up"
    >
      <div class="flex flex-col md:flex-row gap-8">
        <aside
          :aria-label="t('docs.documentationSidebar', 'Documentation sidebar')"
          class="md:w-64 flex-shrink-0"
        >
          <div
            class="sticky top-24 bg-sa-panel/60 p-5 rounded-[20px] shadow-glow-blue border border-sa-border backdrop-blur-xl"
          >
            <h1
              class="text-sm font-extrabold text-sa-muted uppercase text mb-4 px-2 font-outfit"
            >
              {{ t("docs.heading", "Documentation") }}
            </h1>
            <div class="mb-4">
              <div class="relative">
                <input
                  v-model="searchQuery"
                  type="text"
                  :aria-label="
                    t('docs.searchDocumentation', 'Search documentation')
                  "
                  class="w-full rounded-[14px] border border-sa-border bg-sa-dark px-3 py-2 text-sm text-sa-text placeholder:text-sa-muted transition-all duration-200 focus:border-sa-orange focus:outline-none focus:ring-2 focus:ring-sa-orange/40"
                  :placeholder="
                    t('docs.searchDocsPlaceholder', 'Search docs...')
                  "
                />
                <svg
                  aria-hidden="true"
                  v-if="!searchQuery"
                  class="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sa-muted"
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
                <button
                  v-else
                  @click="searchQuery = ''"
                  :aria-label="t('docs.clearSearch', 'Clear search')"
                  class="absolute right-3 top-1/2 -translate-y-1/2 text-sa-muted hover:text-sa-text transition-colors duration-200"
                >
                  <svg
                    aria-hidden="true"
                    class="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M6 18L18 6M6 6l12 12"
                    ></path>
                  </svg>
                </button>
              </div>
              <p
                v-if="searchQuery && filteredDocKeys.length === 0"
                class="mt-2 text-xs text-sa-muted px-2"
              >
                {{ t("docs.noDocsFound", "No docs found") }}
              </p>
            </div>
            <nav class="space-y-1">
              <button
                v-for="key in searchQuery ? filteredDocKeys : Object.keys(docs)"
                :key="key"
                @click="selectDoc(key)"
                :aria-current="activeDoc === key ? 'page' : undefined"
                :class="[
                  activeDoc === key
                    ? 'bg-sa-orange/10 text-sa-orange font-bold border-l-4 border-sa-orange shadow-glow-orange-inset'
                    : 'text-sa-text/75 hover:bg-sa-dark hover:text-sa-text border-l-4 border-transparent font-medium',
                  'w-full flex items-center px-3 py-2.5 text-sm rounded-r-lg transition-all duration-200 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-sa-orange/40',
                ]"
              >
                {{ docs[key]?.title || key }}
              </button>
            </nav>
            <!-- Quick links -->
            <div class="mt-4 pt-4 border-t border-sa-border/60 space-y-1">
              <router-link
                to="/"
                class="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-sa-muted hover:text-sa-text rounded-lg hover:bg-sa-dark transition-all duration-200"
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
                    d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"
                  ></path>
                </svg>
                {{ t("docs.backToHome", "Back to Home") }}
              </router-link>
              <router-link
                to="/native"
                class="flex items-center gap-2 px-3 py-2 text-xs font-semibold text-sa-muted hover:text-sa-text rounded-lg hover:bg-sa-dark transition-all duration-200"
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
                    d="M13 10V3L4 14h7v7l9-11h-7z"
                  ></path>
                </svg>
                {{ t("nav.native", "Native Accounts") }}
              </router-link>
            </div>
          </div>
        </aside>

        <div class="flex-1 min-w-0">
          <div
            class="prose prose-slate max-w-none bg-sa-panel/90 p-8 sm:p-12 rounded-[20px] shadow-glow-blue border border-sa-border backdrop-blur-xl min-h-[600px]"
          >
            <div v-if="isLoading" class="space-y-4">
              <div class="skeleton h-8 w-3/4"></div>
              <div class="skeleton h-4 w-full"></div>
              <div class="skeleton h-4 w-5/6"></div>
              <div class="skeleton h-4 w-4/5"></div>
              <div class="skeleton h-4 w-full mt-4"></div>
              <div class="skeleton h-4 w-2/3"></div>
              <div class="skeleton h-32 w-full mt-6"></div>
              <div class="skeleton h-4 w-5/6 mt-4"></div>
              <div class="skeleton h-4 w-full"></div>
              <div class="skeleton h-4 w-3/4"></div>
            </div>
            <transition
              v-else
              name="fade-in-up"
              mode="out-in"
              @after-enter="renderMermaidDiagrams"
            >
              <div :key="`${activeDoc}:${locale}`">
                <div
                  ref="contentRoot"
                  v-html="compiledMarkdown"
                  class="markdown-body"
                ></div>
              </div>
            </transition>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import "highlight.js/styles/github-dark.css";
import {
  DEFAULT_DOC_KEY,
  getDocsForLocale,
  loadDocContent,
} from "@/features/docs/registry";
import { sanitizeRenderedHtml } from "@/features/docs/rendering";
import { useI18n } from "@/i18n";

let docsRuntimePromise;
let renderVersion = 0;

async function getDocsRuntime() {
  if (!docsRuntimePromise) {
    docsRuntimePromise = (async () => {
      const markedModule = await import("marked");
      const markedHighlightModule = await import("marked-highlight");
      const hljsModule = await import("highlight.js/lib/core");
      const bashModule = await import("highlight.js/lib/languages/bash");
      const javascriptModule =
        await import("highlight.js/lib/languages/javascript");
      const csharpModule = await import("highlight.js/lib/languages/csharp");
      const mermaidModule = await import("mermaid");
      const { Marked } = markedModule;
      const { markedHighlight } = markedHighlightModule;
      const hljs = hljsModule.default;
      const mermaid = mermaidModule.default;

      hljs.registerLanguage("bash", bashModule.default);
      hljs.registerLanguage("shell", bashModule.default);
      hljs.registerLanguage("javascript", javascriptModule.default);
      hljs.registerLanguage("js", javascriptModule.default);
      hljs.registerLanguage("csharp", csharpModule.default);
      hljs.registerLanguage("cs", csharpModule.default);

      mermaid.initialize({ startOnLoad: false, theme: "dark" });

      const marked = new Marked(
        markedHighlight({
          langPrefix: "hljs language-",
          highlight(code, lang) {
            if (lang === "mermaid") {
              return code;
            }
            const language = hljs.getLanguage(lang) ? lang : "plaintext";
            return hljs.highlight(code, { language }).value;
          },
        }),
      );

      const renderer = new marked.Renderer();
      const originalCode = renderer.code.bind(renderer);
      renderer.code = (token) => {
        if (token.lang === "mermaid") {
          const id = `mermaid-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
          return `<div class="mermaid-container" id="${id}" data-mermaid-code="${encodeURIComponent(token.text)}">${t("docs.loadingDiagram", "Loading diagram...")}</div>`;
        }
        return originalCode(token);
      };
      marked.use({ renderer });

      return { marked, mermaid };
    })();
  }

  return docsRuntimePromise;
}

const { locale, t } = useI18n();
const route = useRoute();
const router = useRouter();
const docs = computed(() => getDocsForLocale(locale.value));
const compiledMarkdown = ref("");
const contentRoot = ref(null);
const hasInitialMermaidRender = ref(false);
const isLoading = ref(true);
const searchQuery = ref("");

const filteredDocKeys = computed(() => {
  const query = searchQuery.value.toLowerCase().trim();
  if (!query) return [];
  return Object.keys(docs.value).filter((key) => {
    const doc = docs.value[key];
    return (
      doc?.title?.toLowerCase().includes(query) ||
      key.toLowerCase().includes(query)
    );
  });
});

function selectDoc(key) {
  activeDoc.value = key;
  searchQuery.value = "";
  scrollToTop();
}

function scrollToTop() {
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resolveDocKey(candidate, availableDocs = docs.value) {
  if (
    typeof candidate === "string" &&
    Object.prototype.hasOwnProperty.call(availableDocs, candidate)
  ) {
    return candidate;
  }
  return DEFAULT_DOC_KEY;
}

const activeDoc = ref(resolveDocKey(route.query.doc));

async function renderMermaidDiagrams() {
  const { mermaid } = await getDocsRuntime();
  const containers =
    contentRoot.value?.querySelectorAll(".mermaid-container") || [];

  for (const container of containers) {
    try {
      const rawCode = decodeURIComponent(
        container.getAttribute("data-mermaid-code"),
      );
      const { svg } = await mermaid.render(`${container.id}-svg`, rawCode);
      container.innerHTML = svg;
    } catch (err) {
      if (import.meta.env.DEV)
        console.error("[DocsView] Mermaid render failed:", err?.message);
      const pre = document.createElement("pre");
      pre.className = "text-sa-error-light text-xs overflow-auto";
      pre.textContent = t(
        "docs.diagramRenderFailed",
        "Failed to render diagram.",
      );
      container.replaceChildren(pre);
    }
  }
}

const renderMarkdown = async (key) => {
  const currentRender = ++renderVersion;
  isLoading.value = true;
  try {
    const { marked } = await getDocsRuntime();
    const rawContent = await loadDocContent(key, locale.value);
    if (currentRender !== renderVersion) return;
    const rendered = await marked.parse(rawContent);
    if (currentRender !== renderVersion) return;
    compiledMarkdown.value = sanitizeRenderedHtml(rendered);
    await nextTick();
    if (currentRender !== renderVersion) return;
    if (!hasInitialMermaidRender.value) {
      hasInitialMermaidRender.value = true;
      await renderMermaidDiagrams();
    }
  } catch (err) {
    if (import.meta.env.DEV)
      console.error("[DocsView] Markdown render failed:", err?.message);
    if (currentRender === renderVersion) {
      compiledMarkdown.value = `<p class="text-sa-error-light">${t("docs.failedToLoad", "Documentation failed to load.")}</p>`;
    }
  } finally {
    if (currentRender === renderVersion) {
      isLoading.value = false;
    }
  }
};

watch(
  () => [activeDoc.value, locale.value],
  ([newKey]) => {
    void renderMarkdown(newKey);
  },
  { immediate: true },
);

watch(
  () => [route.query.doc, locale.value],
  ([docKey]) => {
    const nextKey = resolveDocKey(docKey);
    if (activeDoc.value !== nextKey) {
      activeDoc.value = nextKey;
    }
  },
  { immediate: true },
);

watch(activeDoc, (value) => {
  if (route.query.doc === value) return;
  void router.replace({
    query: {
      ...route.query,
      doc: value,
    },
  });
});
</script>

<style>
/* ── Typography ── */
.markdown-body h1 {
  color: theme("colors.sa.text");
  font-weight: 800;
  font-size: 2rem;
  margin-bottom: 1.5rem;
  font-family: "Outfit", sans-serif;
  background: linear-gradient(
    135deg,
    theme("colors.sa.orange"),
    theme("colors.neo.400")
  );
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  letter-spacing: 0;
  line-height: 1.2;
}
.markdown-body h2 {
  color: theme("colors.sa.text");
  border-bottom: 1px solid rgba(var(--sa-orange-rgb), 0.15);
  padding-bottom: 0.75rem;
  margin-top: 3rem;
  margin-bottom: 1.25rem;
  font-weight: 700;
  font-size: 1.5rem;
  font-family: "Outfit", sans-serif;
  letter-spacing: 0;
}
.markdown-body h3 {
  color: theme("colors.sa.text");
  margin-top: 2.25rem;
  margin-bottom: 0.75rem;
  font-weight: 600;
  font-size: 1.25rem;
  font-family: "Outfit", sans-serif;
}
.markdown-body h4 {
  color: theme("colors.sa.text");
  margin-top: 1.75rem;
  margin-bottom: 0.5rem;
  font-weight: 600;
  font-size: 1.05rem;
  font-family: "Outfit", sans-serif;
}
.markdown-body p {
  line-height: 1.75;
  color: theme("colors.sa.muted");
  margin-bottom: 1.25rem;
  font-size: 1rem;
  max-width: 720px;
}
.markdown-body strong {
  color: theme("colors.sa.text");
  font-weight: 700;
}

/* ── Lists ── */
.markdown-body ul {
  list-style-type: disc;
  padding-left: 1.5rem;
  color: theme("colors.sa.muted");
  margin-bottom: 1.5rem;
}
.markdown-body ol {
  list-style-type: decimal;
  padding-left: 1.5rem;
  color: theme("colors.sa.muted");
  margin-bottom: 1.5rem;
}
.markdown-body li {
  margin-bottom: 0.5rem;
  line-height: 1.75;
}
.markdown-body li::marker {
  color: theme("colors.sa.orange");
}

/* ── Links ── */
.markdown-body a {
  color: theme("colors.sa.orange");
  text-decoration: none;
  border-bottom: 1px solid rgba(var(--sa-orange-rgb), 0.3);
  transition:
    color 0.2s ease,
    border-color 0.2s ease;
}
.markdown-body a:hover {
  color: theme("colors.sa.lightOrange");
  border-bottom-color: theme("colors.sa.lightOrange");
}

/* ── Code Blocks ── */
.markdown-body pre {
  background: #0d1117 !important;
  border-radius: 0.5rem;
  padding: 1.25rem;
  overflow-x: auto;
  border: 1px solid rgba(255, 255, 255, 0.08);
  margin: 1.5rem 0;
  position: relative;
}
.markdown-body pre code {
  font-family: "JetBrains Mono", "Fira Code", ui-monospace, monospace;
  font-size: 0.8125rem;
  line-height: 1.65;
  tab-size: 2;
}
.markdown-body code:not(pre code) {
  background-color: rgba(var(--sa-orange-rgb), 0.08);
  color: theme("colors.sa.orange");
  padding: 0.15rem 0.4rem;
  border-radius: 0.25rem;
  font-size: 0.85em;
  font-weight: 600;
  font-family: "JetBrains Mono", "Fira Code", ui-monospace, monospace;
  border: 1px solid rgba(var(--sa-orange-rgb), 0.15);
}

/* ── Blockquotes / Callouts ── */
.markdown-body blockquote {
  border-left: 3px solid theme("colors.sa.orange");
  background: rgba(var(--sa-orange-rgb), 0.04);
  padding: 1rem 1.25rem;
  margin: 1.5rem 0;
  border-radius: 0 0.5rem 0.5rem 0;
}
.markdown-body blockquote p {
  color: theme("colors.sa.muted");
  margin-bottom: 0;
  font-size: 0.95rem;
}
.markdown-body blockquote strong {
  color: theme("colors.sa.orange");
}

/* ── Tables ── */
.markdown-body table {
  width: 100%;
  border-collapse: collapse;
  margin: 1.5rem 0;
  border-radius: 0.5rem;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.08);
}
.markdown-body thead th {
  background: rgba(var(--sa-orange-rgb), 0.06);
  padding: 0.75rem 1rem;
  text-align: left;
  font-size: 0.8rem;
  font-weight: 700;
  color: theme("colors.sa.text");
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}
.markdown-body tbody td {
  padding: 0.75rem 1rem;
  font-size: 0.875rem;
  color: theme("colors.sa.muted");
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}
.markdown-body tbody tr:nth-child(even) {
  background: rgba(255, 255, 255, 0.015);
}
.markdown-body tbody tr:hover {
  background: rgba(var(--sa-orange-rgb), 0.03);
}

/* ── Horizontal Rules ── */
.markdown-body hr {
  border: none;
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent,
    rgba(var(--sa-orange-rgb), 0.2),
    transparent
  );
  margin: 2.5rem 0;
}

/* ── Images ── */
.markdown-body img {
  max-width: 100%;
  border-radius: 0.5rem;
  border: 1px solid rgba(255, 255, 255, 0.08);
  margin: 1.5rem 0;
}

/* ── Mermaid Diagrams ── */
.markdown-body :deep(.mermaid-container) {
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 0.5rem;
  padding: 1.5rem;
  margin: 1.5rem 0;
  text-align: center;
  overflow-x: auto;
}
</style>
