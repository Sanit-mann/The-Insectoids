import type { InsectoidsApi } from '@insectoids/shared';

declare global {
  interface Window {
    insectoids: InsectoidsApi;
  }
}

export {};
