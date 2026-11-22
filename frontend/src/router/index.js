import { createRouter, createWebHistory } from 'vue-router';
import { createI18nController } from '@/i18n';

const MainLayout = () => import('@/components/layout/MainLayout.vue');
const HomeView = () => import('@/views/HomeView.vue');
const ConsoleView = () => import('@/views/ConsoleView.vue');
const IdentityView = () => import('@/views/IdentityView.vue');
const TransactionInfoView = () => import('@/views/TransactionInfoView.vue');
const NativeAccountWorkspace = () => import('@/features/native/NativeAccountWorkspace.vue');
const DocsView = () => import('@/views/DocsView.vue');
const NotFoundView = () => import('@/views/NotFoundView.vue');

const routes = [
  {
    path: '/',
    component: MainLayout,
    children: [
      {
        path: '',
        name: 'home',
        component: HomeView,
        meta: { breadcrumb: 'Home', breadcrumbKey: 'nav.home', titleKey: 'page.titleHome', title: 'Neo Smart Account — Smart Wallets on Neo N3' }
      },
      {
        path: 'console',
        name: 'console',
        component: ConsoleView,
        meta: { breadcrumb: 'Console', breadcrumbKey: 'nav.console', titleKey: 'page.titleConsole', title: 'Console — Neo Smart Account' }
      },
      {
        path: 'identity',
        name: 'identity-workspace',
        component: IdentityView,
        meta: { breadcrumb: 'Identity', breadcrumbKey: 'nav.identity', titleKey: 'page.titleIdentity', title: 'Identity Workspace — Neo Smart Account' }
      },
      {
        path: 'native',
        name: 'native-account',
        component: NativeAccountWorkspace,
        meta: { breadcrumb: 'Native accounts', title: 'Native Accounts — Neo Smart Account' }
      },
      {
        path: 'docs',
        name: 'documentation',
        component: DocsView,
        meta: { breadcrumb: 'Docs', breadcrumbKey: 'nav.docs', titleKey: 'page.titleDocs', title: 'Documentation — Neo Smart Account' }
      },
      {
        path: 'transaction-info/:txid',
        name: 'transaction-info',
        component: TransactionInfoView,
        props: true,
        meta: { breadcrumb: 'Transaction Info', breadcrumbKey: 'nav.transactionInfo', titleKey: 'page.titleTransaction', title: 'Transaction Info — Neo Smart Account' }
      },
      {
        path: 'tx/:draftId',
        name: 'transaction-draft',
        component: TransactionInfoView,
        props: (route) => ({ draftId: route.params.draftId }),
        meta: { breadcrumb: 'Draft', breadcrumbKey: 'nav.draft', titleKey: 'page.titleDraft', title: 'Draft — Neo Smart Account' }
      },
      {
        path: '/:pathMatch(.*)*',
        name: 'not-found',
        component: NotFoundView,
        meta: { breadcrumb: 'Not Found', breadcrumbKey: 'nav.notFound', titleKey: 'page.titleNotFound', title: 'Not Found — Neo Smart Account' }
      }
    ]
  }
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior(to, from, savedPosition) {
    return savedPosition || { top: 0 };
  }
});

const i18n = createI18nController();

router.afterEach((to) => {
  if (to.meta?.titleKey) {
    document.title = i18n.t(to.meta.titleKey, to.meta.title || '');
  } else if (to.meta?.title) {
    document.title = to.meta.title;
  }
});

export default router;
