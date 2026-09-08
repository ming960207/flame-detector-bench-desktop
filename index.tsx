import React from 'react';
import ReactDOM from 'react-dom/client';
import { OfflineClosureApp } from './components/OfflineClosureApp';
import { FieldProcessStatusApp } from './components/FieldProcessStatusApp';
import { TestProgramApp } from './components/TestProgramApp';
import './components/detector-status-lights-runtime';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}
const root = ReactDOM.createRoot(rootElement);

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

class GlobalErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Global React Error Caught:", error, errorInfo);
    this.setState({ errorInfo });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh',
          backgroundColor: '#071822',
          color: '#e2f4f7',
          padding: '24px',
          fontFamily: 'Consolas, monospace',
          boxSizing: 'border-box'
        }}>
          <div style={{
            maxWidth: '900px',
            margin: '0 auto',
            border: '1px solid #e06c75',
            backgroundColor: '#1e1418',
            padding: '20px',
            borderRadius: '6px'
          }}>
            <h2 style={{ color: '#ff6b7b', margin: '0 0 12px' }}>⚠️ 前端渲染发生异常 (React Runtime Error)</h2>
            <p style={{ color: '#dcdfe4', marginBottom: '16px' }}>{this.state.error?.message || '未知错误'}</p>
            <pre style={{
              backgroundColor: '#0d1117',
              padding: '12px',
              borderRadius: '4px',
              overflowX: 'auto',
              fontSize: '12px',
              color: '#abb2bf'
            }}>
              {this.state.error?.stack}
            </pre>
            <div style={{ marginTop: '16px' }}>
              <button
                onClick={() => window.location.reload()}
                style={{
                  padding: '8px 16px',
                  backgroundColor: '#4fa6e8',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer'
                }}
              >
                刷新页面重试
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const getIsTestProgram = () => {
  if (typeof window === 'undefined') return false;
  if (import.meta.env.VITE_RUNTIME_MODE === 'test' || import.meta.env.MODE === 'test') return true;
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('mode') === 'test' || window.location.hash.includes('test')) return true;
  if (window.location.port === '3005' || window.location.port === '3305') return true;
  return false;
};

const isTestProgram = getIsTestProgram();
const isOffline = import.meta.env.VITE_RUNTIME_MODE === 'offline' || (typeof window !== 'undefined' && window.location.port === '3000');

root.render(
  <React.StrictMode>
    <GlobalErrorBoundary>
      {isTestProgram
        ? <TestProgramApp />
        : isOffline ? <OfflineClosureApp /> : <FieldProcessStatusApp />}
    </GlobalErrorBoundary>
  </React.StrictMode>
);
