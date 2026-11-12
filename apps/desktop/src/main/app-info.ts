import { type AppInfo, AppInfoSchema } from '@insectoids/shared';

export function buildAppInfo(raw: { name: string; version: string; platform: string; electron: string }): AppInfo {
  return AppInfoSchema.parse(raw);
}
