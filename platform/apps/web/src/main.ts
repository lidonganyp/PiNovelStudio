/**
 * 应用入口：装配 Pinia、路由与 Element Plus（中文语言包）。
 */
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import './styles/global.css';
import App from './App.vue';
import router from './router';

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(ElementPlus, { locale: zhCn });
app.mount('#app');

// qiankun 微前端：注册 PiVideoStudio 子应用
import { registerMicroApps, start } from 'qiankun';
registerMicroApps([
  {
    name: 'pivideo-web',
    entry: '//ainovel.cloud/video/',
    container: '#pivideo-container',
    activeRule: (location: Location) => /^\/projects\/\d+\/video\/?$/.test(location.pathname),
  },
]);
start({ prefetch: false });
