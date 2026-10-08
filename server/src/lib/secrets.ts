import { config } from '../config.js';
import { createSecretBox } from './crypto.js';

export const secrets = createSecretBox(config.encryptionKey);
