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
  workspace: {
    title: { en: 'Account Workspace', 'zh-CN': '账户工作台' },
    loaders: {
      en: () => import('@/assets/docs/workspace.md?raw'),
      'zh-CN': () => import('@/assets/docs/workspace.zh.md?raw'),
    },
  },
  dataFlow: {
    title: { en: 'Storage & Data Flow', 'zh-CN': '存储与数据流' },
    loaders: {
      en: () => import('@/assets/docs/data-flow.md?raw'),
      'zh-CN': () => import('@/assets/docs/data-flow.zh.md?raw'),
    },
  },
  sdk: {
    title: { en: 'SDK Integration', 'zh-CN': 'SDK 集成' },
    loaders: {
      en: () => import('@/assets/docs/sdk-usage.md?raw'),
      'zh-CN': () => import('@/assets/docs/sdk-usage.zh.md?raw'),
    },
  },
  moduleGuide: {
    title: { en: 'Validator, Policy & Hook Modules', 'zh-CN': '验证器、策略与钩子模块' },
    loaders: {
      en: () => import('@/assets/docs/module-guide.md?raw'),
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
