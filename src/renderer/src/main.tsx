import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import './styles.css';

const host = document.getElementById('root');
if (host === null) throw new Error('#root is missing from index.html');

// Deliberately not wrapped in <StrictMode>: its dev-only mount/unmount/mount
// cycle would open, tear down and reopen every `docker exec` terminal session.
createRoot(host).render(<App />);
