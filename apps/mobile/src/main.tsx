import './styles.css';
import { createRoot } from 'react-dom/client';
import { MobileApp } from './MobileApp';

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<MobileApp />);
