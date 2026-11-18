export const DEFAULT_DOC_KEY = 'guide';

const DOC_DEFINITIONS = {
  guide: {
    title: { en: 'How It Works & Usage Guide', 'zh-CN': '工作原理与使用指南' },
    loaders: {
      en: () => import('@/assets/docs/guide.md?raw'),
      'zh-CN': () => import('@/assets/docs/guide.zh.md?raw'),
    },
  },
  overview: {
    title: { en: 'Overview & Verified Status', 'zh-CN': '概览与已验证状态' },
    loaders: {
      en: () => import('@/assets/docs/repo-readme.md?raw'),
      'zh-CN': () => import('@/assets/docs/overview.zh.md?raw'),
    },
  },
  architecture: {
    title: { en: 'Core Architecture', 'zh-CN': '核心架构' },
    loaders: {
      en: () => import('@/assets/docs/architecture.md?raw'),
      'zh-CN': () => import('@/assets/docs/architecture.zh.md?raw'),
    },
  },
  workflow: {
    title: { en: 'Workflow Lifecycle', 'zh-CN': '工作流生命周期' },
    loaders: {
      en: () => import('@/assets/docs/workflow.md?raw'),
      'zh-CN': () => import('@/assets/docs/workflow.zh.md?raw'),
    },
  },
  dataFlow: {
    title: { en: 'Data Flow & Storage', 'zh-CN': '数据流与存储' },
    loaders: {
      en: () => import('@/assets/docs/data-flow.md?raw'),
      'zh-CN': () => import('@/assets/docs/data-flow.zh.md?raw'),
    },
  },
  verifiers: {
    title: { en: 'Custom Verifiers', 'zh-CN': '自定义验证器' },
    loaders: {
      en: () => import('@/assets/docs/custom-verifiers.md?raw'),
    },
  },
  evm: {
    title: { en: 'Ethereum / EVM Integration', 'zh-CN': '以太坊 / EVM 集成' },
    loaders: {
      en: () => import('@/assets/docs/evm-integration.md?raw'),
    },
  },
  mixed: {
    title: { en: 'Mixed Multi-Sig (N3 + EVM)', 'zh-CN': '混合多签（N3 + EVM）' },
    loaders: {
      en: () => import('@/assets/docs/mixed-multisig.md?raw'),
    },
  },
  sdk: {
    title: { en: 'SDK Integration', 'zh-CN': 'SDK 集成' },
    loaders: {
      en: () => import('@/assets/docs/sdk-usage.md?raw'),
    },
  },
  pluginGuide: {
    title: { en: 'Hook & Plugin Guide', 'zh-CN': 'Hook 与 Plugin 指南' },
    loaders: {
      en: () => import('@/assets/docs/hook-plugin-guide.md?raw'),
    },
  },
  addressMarket: {
    title: { en: 'SA Address Market', 'zh-CN': 'SA 地址市场' },
    loaders: {
      en: () => import('@/assets/docs/address-market.md?raw'),
    },
  },
  morpheusActions: {
    title: { en: 'Morpheus Private Actions', 'zh-CN': 'Morpheus 私密操作' },
    loaders: {
      en: () => import('@/assets/docs/MORPHEUS_PRIVATE_ACTIONS.md?raw'),
      'zh-CN': () => import('@/assets/docs/MORPHEUS_PRIVATE_ACTIONS.zh-CN.md?raw'),
    },
  },
};

const docContentCache = new Map();

export const DOCS = Object.fromEntries(
  Object.entries(DOC_DEFINITIONS).map(([key, value]) => [key, { title: value.title }]),
);

export function getDocsForLocale(locale = 'en') {
  return Object.fromEntries(
    Object.entries(DOCS).map(([key, value]) => [key, {
      title: value.title?.[locale] || value.title?.en || key,
    }]),
  );
}

export async function loadDocContent(key, locale = 'en') {
  const definition = DOC_DEFINITIONS[key];
  if (!definition) return '# Missing documentation';

  const resolvedLocale = definition.loaders?.[locale] ? locale : 'en';
  const loader = definition.loaders?.[resolvedLocale];
  if (!loader) return '# Missing documentation';

  const cacheKey = `${key}:${resolvedLocale}`;
  if (!docContentCache.has(cacheKey)) {
    docContentCache.set(
      cacheKey,
      Promise.resolve(loader())
        .then((module) => module?.default || module || '# Missing documentation')
        .catch(() => '# Missing documentation'),
    );
  }

  return docContentCache.get(cacheKey);
}
