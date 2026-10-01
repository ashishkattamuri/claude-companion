import type { CompanionApi } from '../../shared/api';

declare global {
  interface Window {
    companion: CompanionApi;
  }
}

export const api = window.companion;
