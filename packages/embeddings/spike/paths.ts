import { join } from 'node:path';

/** The user's real app profile (Electron userData for "The Insectoids") — where the app keeps models. */
export const MODELS_DIR = join(process.env['APPDATA'] ?? join(process.env['HOME'] ?? '.', '.config'), 'The Insectoids', 'models');
