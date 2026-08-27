import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/global.css';
import { initializeRendererTelemetry } from './telemetry';

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

async function startRenderer(container: HTMLElement): Promise<void> {
  try {
    const settings = await window.anvil.settings.get();
    await initializeRendererTelemetry(settings.telemetryEnabled);
  } catch (error) {
    console.warn('[Telemetry] Renderer crash reporting was not initialized:', error);
  }

  createRoot(container).render(<App />);
}

void startRenderer(root);
