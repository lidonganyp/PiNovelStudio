/**
 * 路由：登录/注册为公开页；/ 为用户门户（PortalLayout）；
 * /admin 为管理后台（AdminLayout，requiresAdmin）。
 * 全局守卫：未登录访问受保护页跳登录；非 admin 访问管理页回门户。
 */
import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('../views/LoginView.vue'),
      meta: { public: true },
    },
    {
      path: '/register',
      name: 'register',
      component: () => import('../views/RegisterView.vue'),
      meta: { public: true },
    },
    {
      path: '/',
      component: () => import('../layouts/PortalLayout.vue'),
      children: [
        { path: '', redirect: '/projects' },
        {
          path: 'projects',
          name: 'portal-home',
          component: () => import('../views/portal/HomeView.vue'),
        },
        {
          path: 'projects/create',
          name: 'project-create',
          component: () => import('../views/portal/ProjectCreateView.vue'),
        },
        {
          path: 'projects/:id/workbench',
          name: 'workspace',
          component: () => import('../views/portal/WorkspaceView.vue'),
        },
        {
          path: 'projects/:id/workspace',
          redirect: (to) => `/projects/${String(to.params.id)}/workbench`,
        },
        {
          path: 'billing',
          name: 'billing',
          component: () => import('../views/portal/BillingView.vue'),
        },
        {
          path: 'billing/records',
          name: 'billing-records',
          component: () => import('../views/portal/BillingView.vue'),
        },
        {
          path: 'billing/topup',
          name: 'recharge',
          component: () => import('../views/portal/RechargeView.vue'),
        },
        { path: 'recharge', redirect: '/billing/topup' },
        {
          path: 'payment/result',
          name: 'payment-result',
          component: () => import('../views/portal/PaymentResultView.vue'),
        },
      ],
    },
    {
      path: '/admin',
      component: () => import('../layouts/AdminLayout.vue'),
      meta: { requiresAdmin: true },
      children: [
        {
          path: '',
          name: 'admin-home',
          component: () => import('../views/admin/HomeView.vue'),
        },
        {
          path: 'users',
          name: 'admin-users',
          component: () => import('../views/admin/UsersView.vue'),
        },
        {
          path: 'models',
          name: 'admin-models',
          component: () => import('../views/admin/ModelsView.vue'),
        },
        {
          path: 'usage',
          name: 'admin-usage',
          component: () => import('../views/admin/UsageView.vue'),
        },
        {
          path: 'revenue',
          name: 'admin-revenue',
          component: () => import('../views/admin/RevenueView.vue'),
        },
        {
          path: 'orders',
          name: 'admin-orders',
          component: () => import('../views/admin/PaymentOrdersView.vue'),
        },
        {
          path: 'audit',
          name: 'admin-audit',
          component: () => import('../views/admin/AuditView.vue'),
        },
        {
          path: 'feedback',
          name: 'admin-feedback',
          component: () => import('../views/admin/FeedbackView.vue'),
        },
        {
          path: 'settings',
          name: 'admin-settings',
          component: () => import('../views/admin/SettingsView.vue'),
        },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.beforeEach((to) => {
  const auth = useAuthStore();
  if (!to.meta.public && !auth.token) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (to.meta.requiresAdmin && auth.role !== 'admin') {
    return { name: 'portal-home' };
  }
  return true;
});

export default router;
