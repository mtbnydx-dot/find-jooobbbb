import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/tokens.css';
import './styles/global.css';
import './styles/components.css';
import './styles/responsive.css';

class RootErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) { return { error }; }

  render() {
    if (this.state.error) {
      return <main className="fatal-error"><strong>职路</strong><h1>页面遇到了一点问题</h1><p>{this.state.error.message}</p><button type="button" onClick={() => window.location.reload()}>重新打开</button></main>;
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode><RootErrorBoundary><App /></RootErrorBoundary></React.StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(error => {
      console.warn('职路离线缓存注册失败，在线功能不受影响。', error);
    });
  });
}
