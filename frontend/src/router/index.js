import { createRouter, createWebHistory } from 'vue-router';
import { createI18nController } from '@/i18n';

const MainLayout = () => import('@/components/layout/MainLayout.vue');
const AbstractAccountTool = () => import('@/components/AbstractAccountTool.vue');
const HomeView = () => import('@/views/HomeView.vue');
const ConsoleView = () => import('@/views/ConsoleView.vue');
const IdentityView = () => import('@/views/IdentityView.vue');
const AddressMarketView = () => import('@/views/AddressMarketView.vue');
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
        meta: { breadcrumb: 'Home', breadcrumbKey: 'nav.home', titleKey: 'page.titleHome', title: 'Neo Abstract Account — Smart Wallets on Neo N3' }
      },
      {
        path: 'console',
        name: 'console',
        component: ConsoleView,
        meta: { breadcrumb: 'Console', breadcrumbKey: 'nav.console', titleKey: 'page.titleConsole', title: 'Console — Neo Abstract Account' }
      },
      {
        path: 'app',
        name: 'app-workspace',
        component: AbstractAccountTool,
        meta: { breadcrumb: 'Workspace', breadcrumbKey: 'nav.app', titleKey: 'page.titleApp', title: 'App Workspace — Neo Abstract Account' }
      },
      {
        path: 'identity',
        name: 'identity-workspace',
        component: IdentityView,
        meta: { breadcrumb: 'Identity', breadcrumbKey: 'nav.identity', titleKey: 'page.titleIdentity', title: 'Identity Workspace — Neo Abstract Account' }
      },
      {
        path: 'market',
        name: 'address-market',
        component: AddressMarketView,
        meta: { breadcrumb: 'Market', breadcrumbKey: 'nav.market', titleKey: 'page.titleMarket', title: 'Address Market — Neo Abstract Account' }
      },
      {
        path: 'native',
        name: 'native-account',
        component: NativeAccountWorkspace,
        meta: { breadcrumb: 'Native accounts', title: 'Native Accounts — Neo Abstract Account' }
      },
      {
        path: 'docs',
        name: 'documentation',
        component: DocsView,
        meta: { breadcrumb: 'Docs', breadcrumbKey: 'nav.docs', titleKey: 'page.titleDocs', title: 'Documentation — Neo Abstract Account' }
      },
      {
        path: 'transaction-info/:txid',
        name: 'transaction-info',
        component: TransactionInfoView,
        props: true,
        meta: { breadcrumb: 'Transaction Info', breadcrumbKey: 'nav.transactionInfo', titleKey: 'page.titleTransaction', title: 'Transaction Info — Neo Abstract Account' }
      },
      {
        path: 'tx/:draftId',
        name: 'transaction-draft',
        component: TransactionInfoView,
        props: (route) => ({ draftId: route.params.draftId }),
        meta: { breadcrumb: 'Draft', breadcrumbKey: 'nav.draft', titleKey: 'page.titleDraft', title: 'Draft — Neo Abstract Account' }
      },
      {
        path: '/:pathMatch(.*)*',
        name: 'not-found',
        component: NotFoundView,
        meta: { breadcrumb: 'Not Found', breadcrumbKey: 'nav.notFound', titleKey: 'page.titleNotFound', title: 'Not Found — Neo Abstract Account' }
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
