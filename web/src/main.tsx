import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './auth';
import { BrandProvider, registerServiceWorker } from './brand';
import { ToastProvider } from './components/ui';
import '@fontsource-variable/plus-jakarta-sans';
import './styles.css';
import './premium.css';
import './tokens.css';
import './shell.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode><BrowserRouter><ToastProvider><AuthProvider><BrandProvider><App /></BrandProvider></AuthProvider></ToastProvider></BrowserRouter></StrictMode>,
);

registerServiceWorker();
