import React from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { DemoProvider } from './demo/state';
import './styles.css';
import './visual-refinements.css';
createRoot(document.getElementById('root')).render(<React.StrictMode><HashRouter><DemoProvider><App/></DemoProvider></HashRouter></React.StrictMode>);
