import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import './styles.css';

const host = document.getElementById('root');
if (host === null) throw new Error('#root is missing from index.html');

createRoot(host).render(<App />);
