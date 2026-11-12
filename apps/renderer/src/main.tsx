import './styles.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installClientErrorHandler } from './client-errors';

// 未捕获错误写进本地日志并作为 crash 事件上报（发送者在 App 连上内核后注入）
installClientErrorHandler();

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<App />);
