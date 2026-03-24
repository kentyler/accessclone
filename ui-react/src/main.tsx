import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installRuntime } from '@/lib/runtime';

// Install window.AC runtime for generated VBA-to-JS event handlers
installRuntime();

ReactDOM.createRoot(document.getElementById('app')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
