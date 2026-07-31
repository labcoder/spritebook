import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@lingui/react';
import App from './App';
import { i18n, setupI18n } from './i18n';
import { prefs } from './prefs';
import './fonts.css';
import './tokens.css';
import './styles.css';

setupI18n(prefs.locale());

createRoot(document.getElementById('root')!).render(
  <I18nProvider i18n={i18n}>
    <App />
  </I18nProvider>,
);
