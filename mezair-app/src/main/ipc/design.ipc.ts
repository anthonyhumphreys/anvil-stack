import { ipcMain } from 'electron';
import {
  checkDesignReadiness,
  registerFigmaMcp,
  installFrontendSkill,
} from '../services/design-readiness.service.js';

export function registerDesignHandlers(): void {
  ipcMain.handle('design:check-readiness', async () => {
    return checkDesignReadiness();
  });

  ipcMain.handle('design:register-figma-mcp', async () => {
    return registerFigmaMcp();
  });

  ipcMain.handle('design:install-frontend-skill', async () => {
    return installFrontendSkill();
  });
}
